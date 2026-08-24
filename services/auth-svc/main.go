// ============================================================
// auth-svc — authentification complète MIAD Market.
//   - OTP SMS/email (référence opaque, code jamais renvoyé)
//   - Login admin email + mot de passe (sel + 10 000× SHA-256)
//   - Firebase : vérification du jeton Google (tokeninfo) puis
//     émission d'un JWT maison avec le rôle de la table admins
//   - Sessions Redis + JWT HS256 avec claim "role"
//
// Publie : customer.registered
// ============================================================
package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/IBM/sarama"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"

	"github.com/miadmarket/miad-backend/internal/kit"
)

var base32NoPadding = base32.StdEncoding.WithPadding(base32.NoPadding)

const schema = `
CREATE TABLE IF NOT EXISTS customers (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT UNIQUE,
  phone           TEXT UNIQUE,
  full_name       TEXT DEFAULT '',
  addresses       JSONB NOT NULL DEFAULT '[]',
  preferred_lang  TEXT NOT NULL DEFAULT 'fr',
  password_hash   TEXT DEFAULT '',  -- vide = compte OTP/Firebase uniquement, pas de mot de passe
  salt            TEXT DEFAULT '',
  vendor_id       BIGINT,           -- NULL = acheteur normal ; sinon boutique liée (vendor-svc), inclus tel quel dans le JWT à l'émission
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT DEFAULT '';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS salt TEXT DEFAULT '';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS vendor_id BIGINT;
CREATE TABLE IF NOT EXISTS admins (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL DEFAULT '',
  salt          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'admin',
  totp_secret   TEXT DEFAULT '',            -- base32, vide = 2FA non configurée
  totp_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`

type server struct {
	db     *pgxpool.Pool
	redis  *goredis.Client
	kafka  sarama.SyncProducer
	jwtSec []byte
	otpTTL time.Duration
	jwtTTL time.Duration
}

func main() {
	ctx := context.Background()
	log := kit.Logger("auth-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_AUTH", "postgres://miad:miad@postgres:5432/miad_auth?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema); err != nil {
		log.Error("migration impossible", "err", err)
		return
	}

	otpMin, _ := strconv.Atoi(kit.Env("OTP_TTL_MINUTES", "5"))
	jwtH, _ := strconv.Atoi(kit.Env("JWT_TTL_HOURS", "72"))

	s := &server{
		db:     db,
		redis:  kit.NewRedis(kit.Env("REDIS_ADDR", "redis:6379"), kit.Env("REDIS_PASSWORD", "")),
		kafka:  kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		jwtSec: []byte(kit.Env("JWT_SECRET", "change-me")),
		otpTTL: time.Duration(otpMin) * time.Minute,
		jwtTTL: time.Duration(jwtH) * time.Hour,
	}
	s.seedAdmin(ctx, log)

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	health.Add("redis", func(ctx context.Context) error { return s.redis.Ping(ctx).Err() })
	health.Add("jwt_secret", func(ctx context.Context) error {
		if string(s.jwtSec) == "change-me" {
			return fmt.Errorf("JWT_SECRET par défaut — à changer avant la prod")
		}
		return nil
	})

	kit.Run("auth-svc", kit.Env("PORT_AUTH", "8086"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("POST /auth/otp/send", s.sendOTP)
		mux.HandleFunc("POST /auth/otp/verify", s.verifyOTP)
		mux.HandleFunc("POST /auth/register", s.registerCustomer)
		mux.HandleFunc("POST /auth/login", s.loginCustomer)
		mux.HandleFunc("POST /auth/admin/login", s.adminLogin)
		mux.HandleFunc("POST /auth/admin/firebase", s.firebaseAdminLogin)
		mux.HandleFunc("POST /auth/firebase", s.firebaseCustomerLogin)
		mux.HandleFunc("POST /auth/admin/2fa/setup", s.setup2FA) // exige un JWT role=admin déjà valide (post-login sans 2FA, ou 2FA déjà active pour la remplacer)
		mux.HandleFunc("POST /auth/admin/2fa/verify", s.verify2FASetup)
		mux.HandleFunc("POST /auth/admin/2fa/disable", s.disable2FA)
		mux.HandleFunc("GET /customers", s.listCustomers) // role admin exigé
		mux.HandleFunc("GET /customer/{id}", s.getCustomer)
	})
}

/* ---------- Admin : seed + login ---------- */

func (s *server) seedAdmin(ctx context.Context, log interface {
	Info(string, ...any)
	Warn(string, ...any)
}) {
	email := kit.Env("ADMIN_EMAIL", "")
	pwd := kit.Env("ADMIN_PASSWORD", "")
	if email == "" || pwd == "" {
		log.Warn("ADMIN_EMAIL / ADMIN_PASSWORD absents : aucun admin seedé. " +
			"Créez-en un ou utilisez Firebase.")
		return
	}
	var n int
	_ = s.db.QueryRow(ctx, "SELECT count(*) FROM admins").Scan(&n)
	if n > 0 {
		return
	}
	salt := randomToken(12)
	_, err := s.db.Exec(ctx, "INSERT INTO admins (email, password_hash, salt) VALUES ($1,$2,$3)",
		email, hashPassword(salt, pwd), salt)
	if err != nil {
		log.Warn("seed admin impossible", "err", err.Error())
		return
	}
	log.Info("compte admin initial créé depuis ADMIN_EMAIL — changez-le vite")
}

// customerVendorID lit le vendor_id lié à un compte client (NULL si simple
// acheteur) — inclus dans les claims JWT à l'émission (voir A.10 du plan de
// migration) pour qu'admin-svc/vendor-svc identifient un vendeur sans appel
// réseau supplémentaire à chaque requête.
func (s *server) customerVendorID(ctx context.Context, customerID int64) any {
	var vendorID *int64
	_ = s.db.QueryRow(ctx, "SELECT vendor_id FROM customers WHERE id = $1", customerID).Scan(&vendorID)
	if vendorID == nil {
		return nil
	}
	return *vendorID
}

func hashPassword(salt, pwd string) string {
	h := []byte(salt + ":" + pwd)
	for i := 0; i < 10000; i++ {
		sum := sha256.Sum256(h)
		h = sum[:]
	}
	return base64.StdEncoding.EncodeToString(h)
}

// adminLogin — flux en DEUX temps si la 2FA est active (comportement
// standard : mot de passe seul ne suffit jamais à obtenir un JWT une
// fois totp_enabled=true). Sans code TOTP fourni, renvoie
// {"totp_required":true} sans JWT — pas d'erreur, c'est une étape
// normale du flux, pas un échec.
func (s *server) adminLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		TOTPCode string `json:"totp_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	var id int64
	var hash, salt, role, totpSecret string
	var totpEnabled bool
	err := s.db.QueryRow(r.Context(),
		"SELECT id, password_hash, salt, role, totp_secret, totp_enabled FROM admins WHERE lower(email) = lower($1)", body.Email,
	).Scan(&id, &hash, &salt, &role, &totpSecret, &totpEnabled)
	if err == pgx.ErrNoRows || hashPassword(salt, body.Password) != hash {
		kit.Fail(w, 401, "invalid_credentials", "email ou mot de passe incorrect")
		return
	} else if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	if totpEnabled {
		if body.TOTPCode == "" {
			kit.JSON(w, 200, map[string]any{"totp_required": true, "email": body.Email})
			return
		}
		if !verifyTOTP(totpSecret, body.TOTPCode) {
			kit.Fail(w, 401, "invalid_totp_code", "code de vérification incorrect ou expiré")
			return
		}
	}

	jwt, expires := s.signJWT(map[string]any{
		"sub": id, "iss": "miad-auth", "role": role, "email": body.Email,
		"exp": time.Now().Add(s.jwtTTL).Unix(),
	})
	kit.JSON(w, 200, map[string]any{
		"session": map[string]string{"jwt": jwt, "expires_at": expires},
		"role":    role,
		"email":   body.Email,
	})
}

/* ---------- Firebase ---------- */

// firebaseAdminLogin vérifie le jeton ID auprès de Google (tokeninfo),
// puis exige que l'email soit présent dans la table admins. Réservé à
// la console admin — voir firebaseCustomerLogin pour les acheteurs.
func (s *server) firebaseAdminLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDToken string `json:"id_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.IDToken == "" {
		kit.Fail(w, 400, "invalid_body", "id_token Firebase obligatoire")
		return
	}
	info, err := verifyFirebaseToken(r.Context(), body.IDToken, kit.Env("FIREBASE_WEB_CLIENT_ID", ""))
	if err != nil {
		kit.Fail(w, 401, "firebase_rejected", err.Error())
		return
	}
	var id int64
	var role string
	err = s.db.QueryRow(r.Context(),
		"SELECT id, role FROM admins WHERE lower(email) = lower($1)", info.Email,
	).Scan(&id, &role)
	if err == pgx.ErrNoRows {
		kit.Fail(w, 403, "not_admin", fmt.Sprintf("%s est authentifié Firebase mais n'a pas le rôle admin", info.Email))
		return
	} else if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	jwt, expires := s.signJWT(map[string]any{
		"sub": id, "iss": "miad-auth", "role": role, "email": info.Email,
		"provider": "firebase", "exp": time.Now().Add(s.jwtTTL).Unix(),
	})
	kit.JSON(w, 200, map[string]any{
		"session": map[string]string{"jwt": jwt, "expires_at": expires},
		"role":    role,
		"email":   info.Email,
	})
}

// firebaseCustomerLogin — connexion Google pour n'importe quel acheteur
// (pas seulement les admins), même mécanisme de compte que l'OTP
// (voir verifyOTP) : un email Firebase déjà connu dans customers se
// connecte, sinon un compte est créé à la volée et customer.registered
// est publié. Contrairement au PHP historique, Firebase n'est PAS
// utilisé côté Go pour créer le mot de passe d'un compte — seul l'email
// vérifié par Google sert d'identité.
func (s *server) firebaseCustomerLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDToken string `json:"id_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.IDToken == "" {
		kit.Fail(w, 400, "invalid_body", "id_token Firebase obligatoire")
		return
	}
	info, err := verifyFirebaseToken(r.Context(), body.IDToken, kit.Env("FIREBASE_WEB_CLIENT_ID", ""))
	if err != nil {
		kit.Fail(w, 401, "firebase_rejected", err.Error())
		return
	}

	var id int64
	var isNew bool
	err = s.db.QueryRow(r.Context(), "SELECT id FROM customers WHERE lower(email) = lower($1)", info.Email).Scan(&id)
	if err == pgx.ErrNoRows {
		if err := s.db.QueryRow(r.Context(),
			"INSERT INTO customers (email) VALUES ($1) RETURNING id", info.Email).Scan(&id); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		isNew = true
		kit.Publish(s.kafka, "customer.registered", fmt.Sprint(id), map[string]any{
			"customer_id": id, "email": info.Email, "provider": "firebase",
			"at": time.Now().UTC().Format(time.RFC3339),
		})
	} else if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	jwt, expires := s.signJWT(map[string]any{
		"sub": id, "iss": "miad-auth", "role": "customer",
		"vendor_id": s.customerVendorID(r.Context(), id),
		"provider":  "firebase", "exp": time.Now().Add(s.jwtTTL).Unix(),
	})
	_ = s.redis.Set(r.Context(), "session:"+jwt, fmt.Sprint(id), s.jwtTTL).Err()
	kit.JSON(w, 200, map[string]any{
		"session":         map[string]string{"jwt": jwt, "expires_at": expires},
		"is_new_customer": isNew,
		"customer_id":     id,
		"email":           info.Email,
	})
}

/* ---------- 2FA (TOTP, RFC 6238) ---------- */

// setup2FA — génère un nouveau secret TOTP, le stocke en attente
// (totp_enabled reste FALSE tant que verify2FASetup n'a pas confirmé
// un premier code valide — jamais d'activation sans preuve que
// l'admin a bien scanné le bon secret). Exige un JWT role=admin déjà
// valide : réutilisable aussi bien pour la mise en place initiale
// (juste après un login sans 2FA) que pour régénérer un secret perdu.
func (s *server) setup2FA(w http.ResponseWriter, r *http.Request) {
	claims, err := s.claimsFromRequest(r)
	if err != nil || claims["role"] != "admin" {
		kit.Fail(w, 403, "admin_required", "JWT admin valide requis")
		return
	}
	email, _ := claims["email"].(string)
	secret := randomBase32Secret(20) // 160 bits, standard TOTP
	if _, err := s.db.Exec(r.Context(),
		"UPDATE admins SET totp_secret = $2, totp_enabled = FALSE WHERE lower(email) = lower($1)",
		email, secret); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	issuer := "MIAD Market Admin"
	otpauthURL := fmt.Sprintf("otpauth://totp/%s:%s?secret=%s&issuer=%s&algorithm=SHA1&digits=6&period=30",
		urlEscape(issuer), urlEscape(email), secret, urlEscape(issuer))
	kit.JSON(w, 200, map[string]any{
		"secret": secret, "otpauth_url": otpauthURL,
		"note": "scannez otpauth_url dans Google Authenticator/Authy, puis confirmez avec POST /auth/admin/2fa/verify",
	})
}

// verify2FASetup — confirme la mise en place : sans ce premier code
// valide, totp_enabled reste FALSE et adminLogin n'exige jamais de
// code (évite qu'un admin se verrouille lui-même hors de son compte
// avec un secret mal scanné).
func (s *server) verify2FASetup(w http.ResponseWriter, r *http.Request) {
	claims, err := s.claimsFromRequest(r)
	if err != nil || claims["role"] != "admin" {
		kit.Fail(w, 403, "admin_required", "JWT admin valide requis")
		return
	}
	email, _ := claims["email"].(string)
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	var secret string
	if err := s.db.QueryRow(r.Context(),
		"SELECT totp_secret FROM admins WHERE lower(email) = lower($1)", email,
	).Scan(&secret); err != nil || secret == "" {
		kit.Fail(w, 400, "no_pending_setup", "aucune configuration 2FA en attente — appelez /auth/admin/2fa/setup d'abord")
		return
	}
	if !verifyTOTP(secret, body.Code) {
		kit.Fail(w, 401, "invalid_totp_code", "code incorrect — vérifiez l'heure de votre téléphone et réessayez")
		return
	}
	if _, err := s.db.Exec(r.Context(),
		"UPDATE admins SET totp_enabled = TRUE WHERE lower(email) = lower($1)", email); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"totp_enabled": true})
}

// disable2FA — exige un code TOTP valide pour désactiver (pas juste le
// JWT admin) : un JWT volé seul ne doit jamais suffire à retirer la
// 2FA d'un compte.
func (s *server) disable2FA(w http.ResponseWriter, r *http.Request) {
	claims, err := s.claimsFromRequest(r)
	if err != nil || claims["role"] != "admin" {
		kit.Fail(w, 403, "admin_required", "JWT admin valide requis")
		return
	}
	email, _ := claims["email"].(string)
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	var secret string
	var enabled bool
	if err := s.db.QueryRow(r.Context(),
		"SELECT totp_secret, totp_enabled FROM admins WHERE lower(email) = lower($1)", email,
	).Scan(&secret, &enabled); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if !enabled {
		kit.Fail(w, 409, "totp_not_enabled", "la 2FA n'est pas active sur ce compte")
		return
	}
	if !verifyTOTP(secret, body.Code) {
		kit.Fail(w, 401, "invalid_totp_code", "code incorrect")
		return
	}
	if _, err := s.db.Exec(r.Context(),
		"UPDATE admins SET totp_enabled = FALSE, totp_secret = '' WHERE lower(email) = lower($1)", email); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"totp_enabled": false})
}

// randomBase32Secret — secret TOTP aléatoire encodé en base32 sans
// padding (format attendu par Google Authenticator/Authy).
func randomBase32Secret(nBytes int) string {
	b := make([]byte, nBytes)
	_, _ = rand.Read(b)
	return strings.ToUpper(base32NoPadding.EncodeToString(b))
}

// verifyTOTP — RFC 6238 (TOTP), période 30s, 6 chiffres, SHA1 (standard
// Google Authenticator/Authy). Tolère ±1 période (30s) de dérive
// d'horloge, comme la quasi-totalité des implémentations TOTP réelles —
// sans cette tolérance, un décalage d'horloge mineur sur le téléphone
// de l'admin le verrouillerait hors de son propre compte.
func verifyTOTP(base32Secret, code string) bool {
	if len(code) != 6 || base32Secret == "" {
		return false
	}
	secret, err := base32NoPadding.DecodeString(strings.ToUpper(base32Secret))
	if err != nil {
		return false
	}
	now := time.Now().Unix() / 30
	for _, step := range []int64{now - 1, now, now + 1} {
		if generateTOTP(secret, step) == code {
			return true
		}
	}
	return false
}

func generateTOTP(secret []byte, timeStep int64) string {
	msg := make([]byte, 8)
	for i := 7; i >= 0; i-- {
		msg[i] = byte(timeStep & 0xff)
		timeStep >>= 8
	}
	mac := hmac.New(sha1.New, secret)
	mac.Write(msg)
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	code := (uint32(sum[offset])&0x7f)<<24 |
		uint32(sum[offset+1])<<16 |
		uint32(sum[offset+2])<<8 |
		uint32(sum[offset+3])
	return fmt.Sprintf("%06d", code%1_000_000)
}

func urlEscape(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}

type firebaseInfo struct {
	Email string `json:"email"`
	Iss   string `json:"iss"`
	Aud   string `json:"aud"`
}

func verifyFirebaseToken(ctx context.Context, idToken, wantAud string) (*firebaseInfo, error) {
	url := "https://oauth2.googleapis.com/tokeninfo?id_token=" + idToken
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Google tokeninfo injoignable: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("jeton refusé par Google (%d): %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var info firebaseInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return nil, fmt.Errorf("réponse Google illisible: %w", err)
	}
	if info.Iss != "accounts.google.com" && info.Iss != "https://accounts.google.com" {
		return nil, fmt.Errorf("émetteur inattendu: %s", info.Iss)
	}
	if wantAud != "" && info.Aud != wantAud {
		return nil, fmt.Errorf("audience %s ≠ projet Firebase attendu %s", info.Aud, wantAud)
	}
	if info.Email == "" {
		return nil, fmt.Errorf("jeton sans email")
	}
	return &info, nil
}

/* ---------- OTP (flux acheteur, inchangé) ---------- */

func (s *server) sendOTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Identifier string `json:"identifier"`
		Channel    string `json:"channel"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Identifier == "" {
		kit.Fail(w, 400, "missing_identifier", "identifier (email ou téléphone) obligatoire")
		return
	}
	if body.Channel != "sms" && body.Channel != "email" {
		kit.Fail(w, 400, "invalid_channel", "channel doit être sms ou email")
		return
	}
	code := fmt.Sprintf("%06d", randInt(1_000_000))
	ref := randomToken(16)
	if err := s.redis.Set(r.Context(), "otp:"+ref,
		body.Identifier+"|"+body.Channel+"|"+code, s.otpTTL).Err(); err != nil {
		kit.Fail(w, 503, "session_store_down", "Redis indisponible : OTP impossible — erreur explicite")
		return
	}
	if kit.Env("SMS_PROVIDER_URL", "") == "" {
		fmt.Printf("[auth-svc][DEV] OTP %s pour %s (ref %s)\n", code, body.Identifier, ref)
	}
	kit.JSON(w, 200, map[string]any{
		"otp_ref":     ref,
		"ttl_minutes": int(s.otpTTL.Minutes()),
		"dev_mode":    kit.Env("SMS_PROVIDER_URL", "") == "",
	})
}

func (s *server) verifyOTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OtpRef string `json:"otp_ref"`
		Code   string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	val, err := s.redis.Get(r.Context(), "otp:"+body.OtpRef).Result()
	if err == goredis.Nil {
		kit.Fail(w, 401, "otp_expired_or_unknown", "OTP expiré ou inconnu — renvoyer via /auth/otp/send")
		return
	} else if err != nil {
		kit.Fail(w, 503, "session_store_down", "Redis indisponible")
		return
	}
	parts := strings.SplitN(val, "|", 3)
	if len(parts) != 3 || parts[2] != body.Code {
		kit.Fail(w, 401, "invalid_code", "code OTP incorrect")
		return
	}
	identifier, channel := parts[0], parts[1]
	_ = s.redis.Del(r.Context(), "otp:"+body.OtpRef).Err()

	var id int64
	var isNew bool
	col := "email"
	if channel == "sms" {
		col = "phone"
	}
	err = s.db.QueryRow(r.Context(), "SELECT id FROM customers WHERE "+col+" = $1", identifier).Scan(&id)
	if err == pgx.ErrNoRows {
		if err := s.db.QueryRow(r.Context(),
			"INSERT INTO customers ("+col+") VALUES ($1) RETURNING id", identifier).Scan(&id); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		isNew = true
		kit.Publish(s.kafka, "customer.registered", fmt.Sprint(id), map[string]any{
			"customer_id": id, col: identifier,
			"at": time.Now().UTC().Format(time.RFC3339),
		})
	} else if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	jwt, expires := s.signJWT(map[string]any{
		"sub": id, "iss": "miad-auth", "role": "customer",
		"vendor_id": s.customerVendorID(r.Context(), id),
		"exp":       time.Now().Add(s.jwtTTL).Unix(),
	})
	_ = s.redis.Set(r.Context(), "session:"+jwt, fmt.Sprint(id), s.jwtTTL).Err()
	kit.JSON(w, 200, map[string]any{
		"session":         map[string]string{"jwt": jwt, "expires_at": expires},
		"is_new_customer": isNew,
		"customer_id":     id,
	})
}

/* ---------- Clients : compte par mot de passe (distinct de OTP/Firebase) ---------- */

// registerCustomer — auto-login après inscription (comportement is_new_customer
// déjà en place pour OTP/Firebase). Réutilise hashPassword/randomToken déjà
// présents pour admins — même primitive crypto, pas de duplication.
func (s *server) registerCustomer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		FullName string `json:"full_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Email == "" || len(body.Password) < 8 {
		kit.Fail(w, 400, "missing_fields", "email et un mot de passe d'au moins 8 caractères sont obligatoires")
		return
	}

	var existing int64
	if err := s.db.QueryRow(r.Context(), "SELECT id FROM customers WHERE lower(email) = lower($1)", body.Email).Scan(&existing); err == nil {
		kit.Fail(w, 409, "email_taken", "un compte existe déjà avec cet email")
		return
	} else if err != pgx.ErrNoRows {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	salt := randomToken(12)
	var id int64
	err := s.db.QueryRow(r.Context(),
		"INSERT INTO customers (email, full_name, password_hash, salt) VALUES ($1,$2,$3,$4) RETURNING id",
		body.Email, body.FullName, hashPassword(salt, body.Password), salt,
	).Scan(&id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.Publish(s.kafka, "customer.registered", fmt.Sprint(id), map[string]any{
		"customer_id": id, "email": body.Email, "provider": "password",
		"at": time.Now().UTC().Format(time.RFC3339),
	})

	jwt, expires := s.signJWT(map[string]any{
		"sub": id, "iss": "miad-auth", "role": "customer",
		"vendor_id": s.customerVendorID(r.Context(), id),
		"exp":       time.Now().Add(s.jwtTTL).Unix(),
	})
	_ = s.redis.Set(r.Context(), "session:"+jwt, fmt.Sprint(id), s.jwtTTL).Err()
	kit.JSON(w, 201, map[string]any{
		"session":         map[string]string{"jwt": jwt, "expires_at": expires},
		"is_new_customer": true,
		"customer_id":     id,
	})
}

func (s *server) loginCustomer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	var id int64
	var hash, salt string
	err := s.db.QueryRow(r.Context(),
		"SELECT id, password_hash, salt FROM customers WHERE lower(email) = lower($1)", body.Email,
	).Scan(&id, &hash, &salt)
	if err == pgx.ErrNoRows || hash == "" || hashPassword(salt, body.Password) != hash {
		kit.Fail(w, 401, "invalid_credentials", "email ou mot de passe incorrect")
		return
	} else if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	jwt, expires := s.signJWT(map[string]any{
		"sub": id, "iss": "miad-auth", "role": "customer",
		"vendor_id": s.customerVendorID(r.Context(), id),
		"exp":       time.Now().Add(s.jwtTTL).Unix(),
	})
	_ = s.redis.Set(r.Context(), "session:"+jwt, fmt.Sprint(id), s.jwtTTL).Err()
	kit.JSON(w, 200, map[string]any{
		"session":     map[string]string{"jwt": jwt, "expires_at": expires},
		"customer_id": id,
	})
}

/* ---------- Clients ---------- */

// listCustomers — exigé par la console admin (JWT role=admin).
func (s *server) listCustomers(w http.ResponseWriter, r *http.Request) {
	if err := s.requireRole(r, "admin"); err != nil {
		kit.Fail(w, 403, "admin_required", err.Error())
		return
	}
	page, _ := strconv.Atoi(kit.EnvOr(r.URL.Query().Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(r.URL.Query().Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}
	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM customers").Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT id, email, phone, preferred_lang, created_at FROM customers
		ORDER BY id DESC LIMIT `+strconv.Itoa(pageSize)+` OFFSET `+strconv.Itoa((page-1)*pageSize))
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var email, phone, lang string
		var at time.Time
		_ = rows.Scan(&id, &email, &phone, &lang, &at)
		items = append(items, map[string]any{
			"id": id, "email": email, "phone": phone, "preferred_lang": lang,
			"created_at": at.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

func (s *server) getCustomer(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	row := s.db.QueryRow(r.Context(), `
		SELECT id, email, phone, full_name, addresses, preferred_lang, created_at
		FROM customers WHERE id = $1`, id)
	var cid int64
	var email, phone, name, lang string
	var addresses []byte
	var at time.Time
	if err := row.Scan(&cid, &email, &phone, &name, &addresses, &lang, &at); err != nil {
		kit.Fail(w, 404, "customer_not_found", fmt.Sprintf("compte %d introuvable", id))
		return
	}
	kit.JSON(w, 200, map[string]any{
		"id": cid, "email": email, "phone": phone, "full_name": name,
		"addresses": json.RawMessage(addresses), "preferred_lang": lang,
		"created_at": at.UTC().Format(time.RFC3339),
	})
}

/* ---------- requireRole (vérifie le JWT de la requête) ---------- */

func (s *server) requireRole(r *http.Request, role string) error {
	claims, err := s.claimsFromRequest(r)
	if err != nil {
		return err
	}
	if claims["role"] != role {
		return fmt.Errorf("rôle %q requis", role)
	}
	return nil
}

// claimsFromRequest — vérifie signature + expiration du JWT porté par la
// requête et renvoie ses claims (utilisé par requireRole et par les
// endpoints 2FA, qui ont besoin de l'email de l'admin courant en plus
// du rôle).
func (s *server) claimsFromRequest(r *http.Request) (map[string]any, error) {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return nil, fmt.Errorf("Authorization: Bearer <jwt> attendu")
	}
	parts := strings.Split(h[len(prefix):], ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("JWT malformé")
	}
	mac := hmac.New(sha256.New, s.jwtSec)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	wantSig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(mac.Sum(nil), wantSig) {
		return nil, fmt.Errorf("signature invalide")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("payload illisible")
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("payload JSON invalide")
	}
	if exp, ok := claims["exp"].(float64); ok && time.Now().Unix() > int64(exp) {
		return nil, fmt.Errorf("session expirée")
	}
	return claims, nil
}

/* ---------- JWT ---------- */

func (s *server) signJWT(claims map[string]any) (string, string) {
	header := b64([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payloadJSON, _ := json.Marshal(claims)
	payload := b64(payloadJSON)
	sig := b64(hmacSHA256(s.jwtSec, []byte(header+"."+payload)))
	exp, _ := claims["exp"].(int64)
	return header + "." + payload + "." + sig, time.Unix(exp, 0).UTC().Format(time.RFC3339)
}

func hmacSHA256(key, msg []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(msg)
	return m.Sum(nil)
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func randInt(max int) int {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	n := int(b[0])<<24 | int(b[1])<<16 | int(b[2])<<8 | int(b[3])
	if n < 0 {
		n = -n
	}
	return n % max
}

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
	"bytes"
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
-- Import historique WooCommerce (cmd/wc-data-import) : l'API REST
-- WooCommerce n'expose jamais wp_users.user_pass — un client importé n'a
-- donc aucun mot de passe utilisable tant qu'il ne passe pas par "mot de
-- passe oublié" (décision validée le 2026-08-25, voir wc-data-import).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN NOT NULL DEFAULT FALSE;
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
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_secret TEXT DEFAULT '';
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
`

type server struct {
	db       *pgxpool.Pool
	redis    *goredis.Client
	kafka    sarama.SyncProducer
	jwtSec   []byte
	otpTTL   time.Duration
	jwtTTL   time.Duration
	emailURL string // canal réel d'envoi de l'OTP par email (voir sendOTP) — adresse réseau interne, pas un secret, pas dans SettingsStore

	settings *kit.SettingsStore
	// otpTTLMinutes/jwtTTLHours dupliquent otpTTL/jwtTTL (déjà convertis en
	// time.Duration) car SettingsStore travaille en string — recalculés
	// après chaque Load/Save (voir refreshDurations). jwtSecretStr : même
	// remarque pour jwtSec ([]byte) — JWT_SECRET est éditable ici mais
	// PARTAGÉ avec admin-svc (même variable), le changer désynchronise les
	// JWT déjà émis tant qu'admin-svc n'a pas la même valeur (pas de
	// mécanisme de coordination automatique entre les deux services).
	otpTTLMinutes        string
	jwtTTLHours          string
	jwtSecretStr         string
	redisPassword        string
	adminEmail           string
	firebaseWebClientID  string
	firebaseAPIKey       string
	smsProviderURL       string
	internalAPISecretStr string
}

func (s *server) settingsFields() []kit.SettingsField {
	return []kit.SettingsField{
		{Key: "otp_ttl_minutes", Ptr: &s.otpTTLMinutes, Description: "Durée de validité (minutes) d'un code OTP envoyé par SMS/email"},
		{Key: "jwt_ttl_hours", Ptr: &s.jwtTTLHours, Description: "Durée de validité (heures) des tokens JWT émis"},
		{Key: "jwt_secret", Ptr: &s.jwtSecretStr, Secret: true, Description: "Clé de signature des JWT — ATTENTION : partagée avec admin-svc (même variable), les deux doivent rester identiques manuellement"},
		{Key: "redis_password", Ptr: &s.redisPassword, Secret: true, Description: "Mot de passe de connexion Redis (session store OTP) — nécessite un redémarrage du service pour être pris en compte (connexion établie au démarrage)"},
		{Key: "admin_email", Ptr: &s.adminEmail, Description: "Email du compte admin bootstrap — INFORMATIF SEUL : n'a d'effet qu'au tout premier démarrage (table admins vide), le modifier après coup ne change rien"},
		{Key: "firebase_web_client_id", Ptr: &s.firebaseWebClientID, Description: "Project ID Firebase attendu dans les tokens de connexion sociale (vérifié en plus de la signature)"},
		{Key: "firebase_api_key", Ptr: &s.firebaseAPIKey, Secret: true, Description: "Clé API Web Firebase — nécessaire pour valider les id_token Firebase via Identity Toolkit (accounts:lookup). Même valeur que NEXT_PUBLIC_FIREBASE_API_KEY côté frontend."},
		{Key: "sms_provider_url", Ptr: &s.smsProviderURL, Description: "URL du fournisseur SMS pour l'envoi d'OTP — vide = mode dev (OTP journalisé, jamais envoyé)"},
		{Key: "internal_api_secret", Ptr: &s.internalAPISecretStr, Secret: true, Description: "Secret partagé avec le frontend Next.js pour les routes internes sensibles — ATTENTION : doit rester identique côté Cloudflare Pages"},
	}
}

const settingsTable = "auth_settings"

// refreshDurations — recalcule otpTTL/jwtTTL/jwtSec depuis leurs
// équivalents string (settings) : à appeler après Load et après chaque
// Save qui touche l'un de ces 3 champs.
func (s *server) refreshDurations() {
	if mins, err := strconv.Atoi(s.otpTTLMinutes); err == nil {
		s.otpTTL = time.Duration(mins) * time.Minute
	}
	if h, err := strconv.Atoi(s.jwtTTLHours); err == nil {
		s.jwtTTL = time.Duration(h) * time.Hour
	}
	s.jwtSec = []byte(s.jwtSecretStr)
}

func main() {
	ctx := context.Background()
	log := kit.Logger("auth-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_AUTH", "postgres://miad:miad@postgres:5432/miad_auth?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema+kit.SettingsStoreSchema(settingsTable)); err != nil {
		log.Error("migration impossible", "err", err)
		return
	}

	redisPassword := kit.Env("REDIS_PASSWORD", "")
	s := &server{
		db:       db,
		redis:    kit.NewRedis(kit.Env("REDIS_ADDR", "redis:6379"), redisPassword),
		kafka:    kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		emailURL: kit.Env("EMAIL_SVC_URL", "http://email-svc:8089"),

		otpTTLMinutes:        kit.Env("OTP_TTL_MINUTES", "5"),
		jwtTTLHours:          kit.Env("JWT_TTL_HOURS", "72"),
		jwtSecretStr:         kit.Env("JWT_SECRET", "change-me"),
		redisPassword:        redisPassword,
		adminEmail:           kit.Env("ADMIN_EMAIL", ""),
		firebaseWebClientID:  kit.Env("FIREBASE_WEB_CLIENT_ID", ""),
		firebaseAPIKey:       kit.Env("FIREBASE_API_KEY", ""),
		smsProviderURL:       kit.Env("SMS_PROVIDER_URL", ""),
		internalAPISecretStr: kit.Env("INTERNAL_API_SECRET", ""),
	}
	s.settings = kit.NewSettingsStore(db, settingsTable, s.settingsFields())
	if err := s.settings.Load(ctx); err != nil {
		log.Error("chargement auth_settings impossible", "err", err)
	}
	s.refreshDurations()
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
		mux.HandleFunc("GET /settings", s.getSettings)
		mux.HandleFunc("PUT /settings", s.putSettings)
		mux.HandleFunc("POST /auth/otp/send", s.sendOTP)
		mux.HandleFunc("POST /auth/otp/verify", s.verifyOTP)
		mux.HandleFunc("POST /auth/register", s.registerCustomer)
		mux.HandleFunc("POST /auth/reset-password", s.resetPassword)
		mux.HandleFunc("POST /auth/login", s.loginCustomer)
		mux.HandleFunc("POST /auth/admin/login", s.adminLogin)
		mux.HandleFunc("POST /auth/admin/firebase", s.firebaseAdminLogin)
		mux.HandleFunc("POST /auth/firebase", s.firebaseCustomerLogin)
		mux.HandleFunc("POST /auth/admin/2fa/setup", s.setup2FA) // exige un JWT role=admin déjà valide (post-login sans 2FA, ou 2FA déjà active pour la remplacer)
		mux.HandleFunc("POST /auth/admin/2fa/verify", s.verify2FASetup)
		mux.HandleFunc("POST /auth/admin/2fa/disable", s.disable2FA)
		mux.HandleFunc("GET /customers", s.listCustomers)                                // role admin exigé
		mux.HandleFunc("GET /customer/{id}", s.getCustomer)                              // role admin exigé
		mux.HandleFunc("PATCH /customer/{id}/address", s.updateCustomerAddress)          // secret interne exigé
		mux.HandleFunc("GET /admins", s.listAdmins)                                      // role admin exigé
		mux.HandleFunc("POST /auth/impersonate-vendor/{vendor_id}", s.impersonateVendor) // role admin exigé
	})
}

// getSettings/putSettings — Configuration Système (page admin). Après un
// Save qui touche otp_ttl_minutes/jwt_ttl_hours/jwt_secret, recalcule
// immédiatement otpTTL/jwtTTL/jwtSec (sinon la valeur en base serait
// stockée mais jamais réellement utilisée avant un redémarrage).
func (s *server) getSettings(w http.ResponseWriter, r *http.Request) {
	kit.JSON(w, 200, s.settings.Snapshot())
}

func (s *server) putSettings(w http.ResponseWriter, r *http.Request) {
	var body map[string]string
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	toSave := map[string]string{}
	for k, v := range body {
		if !s.settings.IsKnown(k) {
			continue
		}
		if s.settings.IsSecret(k) && v == "" {
			continue
		}
		toSave[k] = v
	}
	if len(toSave) == 0 {
		kit.Fail(w, 400, "no_valid_fields", "aucun champ reconnu à mettre à jour")
		return
	}
	if err := s.settings.Save(r.Context(), toSave); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	s.refreshDurations()
	kit.JSON(w, 200, map[string]any{"ok": true, "updated": len(toSave)})
}

/* ---------- Admin : seed + login ---------- */

func (s *server) seedAdmin(ctx context.Context, log interface {
	Info(string, ...any)
	Warn(string, ...any)
}) {
	email := s.adminEmail
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
	info, err := verifyFirebaseToken(r.Context(), body.IDToken, s.firebaseWebClientID)
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
	info, err := verifyFirebaseToken(r.Context(), body.IDToken, s.firebaseWebClientID)
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

	// devMode : reflète le canal RÉELLEMENT demandé, pas toujours SMS —
	// bug corrigé le 2026-08-26 (dev_mode regardait s.smsProviderURL même
	// pour channel=="email", donc mentait sur l'état réel de l'envoi email).
	devMode := true
	if body.Channel == "sms" {
		devMode = s.smsProviderURL == ""
		if !devMode {
			// TODO : câblage SMS réel non implémenté (voir SMS_PROVIDER_URL
			// dans Configuration Système) — journalisé en attendant, jamais
			// silencieusement prétendu envoyé.
			fmt.Printf("[auth-svc][DEV] OTP %s pour %s (ref %s) — SMS_PROVIDER_URL configuré mais aucun appel réel implémenté\n", code, body.Identifier, ref)
			devMode = true
		}
	} else { // email
		if err := s.sendOTPEmail(r.Context(), body.Identifier, code); err != nil {
			// Le code reste valide dans Redis (l'utilisateur peut redemander) —
			// ne jamais faire échouer /otp/send juste parce que l'email n'est
			// pas parti, mais ne jamais prétendre un succès non plus.
			fmt.Printf("[auth-svc] échec envoi OTP par email à %s (ref %s) : %v\n", body.Identifier, ref, err)
		} else {
			devMode = false
		}
	}
	if devMode {
		fmt.Printf("[auth-svc][DEV] OTP %s pour %s (ref %s)\n", code, body.Identifier, ref)
	}

	kit.JSON(w, 200, map[string]any{
		"otp_ref":     ref,
		"ttl_minutes": int(s.otpTTL.Minutes()),
		"dev_mode":    devMode,
	})
}

// sendOTPEmail — relaie vers email-svc (template otp_email, déjà prêt
// mais jamais appelé jusqu'ici — trou documenté dans
// app/api/auth/otp/send/route.ts, comblé le 2026-08-26). Le template
// attend {{.Code}} et {{.TTLMinutes}} (PascalCase, voir
// services/email-svc/main.go otpEmailHTML) — payload construit en
// conséquence, distinct du snake_case utilisé par d'autres templates.
func (s *server) sendOTPEmail(ctx context.Context, to, code string) error {
	payload := map[string]any{
		"Code":       code,
		"TTLMinutes": int(s.otpTTL.Minutes()),
	}
	body, _ := json.Marshal(map[string]any{
		"to":       to,
		"subject":  "Votre code de vérification MIAD Market",
		"template": "otp_email",
		"payload":  payload,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.emailURL+"/emails/send", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("email-svc injoignable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("email-svc a répondu %d", resp.StatusCode)
	}
	return nil
}

func (s *server) verifyOTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OtpRef       string `json:"otp_ref"`
		Code         string `json:"code"`
		FullName     string `json:"full_name"`
		ReferralCode string `json:"referral_code"` // ?ref= au moment de l'inscription (module Parrainage) — vrai flux d'inscription actif, contrairement à registerCustomer
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
			"INSERT INTO customers ("+col+", full_name) VALUES ($1,$2) RETURNING id", identifier, body.FullName).Scan(&id); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		isNew = true
		kit.Publish(s.kafka, "customer.registered", fmt.Sprint(id), map[string]any{
			"customer_id": id, col: identifier,
			"referral_code": body.ReferralCode, // consommé par loyalty-svc, vide si absent
			"at":            time.Now().UTC().Format(time.RFC3339),
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
		"identifier":      identifier,
		"full_name":       body.FullName,
	})
}

/* ---------- Clients : compte par mot de passe (distinct de OTP/Firebase) ---------- */

// registerCustomer — auto-login après inscription (comportement is_new_customer
// déjà en place pour OTP/Firebase). Réutilise hashPassword/randomToken déjà
// présents pour admins — même primitive crypto, pas de duplication.
func (s *server) registerCustomer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email        string `json:"email"`
		Password     string `json:"password"`
		FullName     string `json:"full_name"`
		ReferralCode string `json:"referral_code"` // ?ref= au moment de l'inscription (module Parrainage représentant)
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
		"referral_code": body.ReferralCode, // consommé par loyalty-svc (module Parrainage), vide si absent
		"at":            time.Now().UTC().Format(time.RFC3339),
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
	var mustReset bool
	err := s.db.QueryRow(r.Context(),
		"SELECT id, password_hash, salt, must_reset_password FROM customers WHERE lower(email) = lower($1)", body.Email,
	).Scan(&id, &hash, &salt, &mustReset)
	if err == pgx.ErrNoRows || hash == "" {
		// Compte importé (must_reset_password) : message dédié plutôt que
		// le "email ou mot de passe incorrect" générique, pour orienter
		// directement vers le flux "mot de passe oublié" côté frontend.
		if err == nil && mustReset {
			kit.Fail(w, 403, "password_reset_required", "compte importé — veuillez définir un mot de passe via « mot de passe oublié »")
			return
		}
		kit.Fail(w, 401, "invalid_credentials", "email ou mot de passe incorrect")
		return
	} else if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if hashPassword(salt, body.Password) != hash {
		kit.Fail(w, 401, "invalid_credentials", "email ou mot de passe incorrect")
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

// resetPassword — applique un nouveau mot de passe par email, SANS
// re-vérifier l'identité côté Go : protégé par un secret interne partagé
// avec le frontend (INTERNAL_API_SECRET), qui n'appelle cette route
// qu'après avoir déjà validé la preuve de possession de l'email via
// Firebase (confirmation d'un oobCode envoyé par mail). Jamais exposé
// directement au navigateur.
func (s *server) resetPassword(w http.ResponseWriter, r *http.Request) {
	secret := s.internalAPISecretStr
	if secret == "" || r.Header.Get("X-Internal-Secret") != secret {
		kit.Fail(w, 401, "unauthorized", "secret interne invalide ou absent")
		return
	}
	var body struct {
		Email       string `json:"email"`
		NewPassword string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Email == "" || len(body.NewPassword) < 8 {
		kit.Fail(w, 400, "missing_fields", "email et un mot de passe d'au moins 8 caractères sont obligatoires")
		return
	}
	salt := randomToken(12)
	tag, err := s.db.Exec(r.Context(),
		"UPDATE customers SET password_hash = $1, salt = $2, must_reset_password = FALSE WHERE lower(email) = lower($3)",
		hashPassword(salt, body.NewPassword), salt, body.Email)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "customer_not_found", "aucun compte avec cet email")
		return
	}
	kit.JSON(w, 200, map[string]any{"success": true})
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
		SELECT id, email, phone, preferred_lang, must_reset_password, vendor_id, created_at FROM customers
		ORDER BY id DESC LIMIT `+strconv.Itoa(pageSize)+` OFFSET `+strconv.Itoa((page-1)*pageSize))
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var email, phone *string // email/phone sont nullable (TEXT UNIQUE, pas NOT NULL) — un Scan vers *string
		var lang string          // évite l'échec silencieux qui laissait created_at à sa zero-value 0001-01-01
		var mustReset bool
		var vendorID *int64
		var at time.Time
		if err := rows.Scan(&id, &email, &phone, &lang, &mustReset, &vendorID, &at); err != nil {
			kit.Fail(w, 500, "db_error", "lecture client échouée : "+err.Error())
			return
		}
		item := map[string]any{
			"id": id, "preferred_lang": lang, "must_reset_password": mustReset,
			"created_at": at.UTC().Format(time.RFC3339),
		}
		if email != nil {
			item["email"] = *email
		} else {
			item["email"] = ""
		}
		if phone != nil {
			item["phone"] = *phone
		} else {
			item["phone"] = ""
		}
		if vendorID != nil {
			item["vendor_id"] = *vendorID
		}
		items = append(items, item)
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

// getCustomer — fiche complète (module Utilisateurs) : email/phone sont
// scannés en *string (nullable côté schéma, voir customers.email/phone)
// pour ne jamais confondre "client introuvable" (vraie 404) avec "client
// trouvé mais avec un champ NULL" (ancien bug : un Scan vers string sur
// une valeur NULL échouait et renvoyait 404 à tort — un client inscrit
// par téléphone seul, sans email, devenait invisible ici).
// Réservé aux admins OU au serveur Next.js lui-même (secret interne,
// même pattern que resetPassword/updateCustomerAddress) : cette route
// n'exigeait aucune authentification avant (faille — n'importe quel
// appelant interne au cluster pouvait énumérer email/téléphone/adresses
// par id), corrigé au même moment que le bug de scan ci-dessus. Le
// bypass secret interne a été ajouté ensuite : app/api/customer/route.ts
// (dashboard client) appelle cette route pour SON PROPRE compte après
// avoir déjà vérifié le JWT côté edge — sans lui, tout client non-admin
// consultant son propre profil recevait un 403.
func (s *server) getCustomer(w http.ResponseWriter, r *http.Request) {
	secret := s.internalAPISecretStr
	isInternal := secret != "" && r.Header.Get("X-Internal-Secret") == secret
	if !isInternal {
		if err := s.requireRole(r, "admin"); err != nil {
			kit.Fail(w, 403, "admin_required", err.Error())
			return
		}
	}
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	row := s.db.QueryRow(r.Context(), `
		SELECT id, email, phone, full_name, addresses, preferred_lang, must_reset_password, vendor_id, created_at
		FROM customers WHERE id = $1`, id)
	var cid int64
	var email, phone *string
	var name, lang string
	var addresses []byte
	var mustReset bool
	var vendorID *int64
	var at time.Time
	if err := row.Scan(&cid, &email, &phone, &name, &addresses, &lang, &mustReset, &vendorID, &at); err != nil {
		kit.Fail(w, 404, "customer_not_found", fmt.Sprintf("compte %d introuvable", id))
		return
	}
	out := map[string]any{
		"id": cid, "full_name": name,
		"addresses": json.RawMessage(addresses), "preferred_lang": lang,
		"must_reset_password": mustReset,
		"created_at":          at.UTC().Format(time.RFC3339),
	}
	if email != nil {
		out["email"] = *email
	} else {
		out["email"] = ""
	}
	if phone != nil {
		out["phone"] = *phone
	} else {
		out["phone"] = ""
	}
	if vendorID != nil {
		out["vendor_id"] = *vendorID
	}
	kit.JSON(w, 200, out)
}

// updateCustomerAddress — PATCH /customer/{id}/address {type, address}
// (type: "billing" | "shipping"). Comblait un vrai trou : le dashboard
// client (app/api/customer/route.ts PATCH) renvoyait un 501 explicite
// depuis la migration, faute d'endpoint d'écriture sur customers.addresses
// — les clients ne pouvaient plus modifier leur adresse de facturation/
// livraison. `addresses` est stocké comme un array JSONB libre (pas de
// billing/shipping distincts comme sous WooCommerce) : on upsert par
// `type` dans cet array plutôt que d'écraser les autres entrées.
//
// Protégé par le secret interne partagé avec le frontend (comme
// resetPassword) : Next.js a déjà vérifié le JWT du client côté edge avant
// d'appeler cette route, pas besoin de re-vérifier un rôle ici — mais
// l'appel doit prouver qu'il vient bien du serveur Next.js et pas d'un
// tiers qui devinerait un id.
func (s *server) updateCustomerAddress(w http.ResponseWriter, r *http.Request) {
	secret := s.internalAPISecretStr
	if secret == "" || r.Header.Get("X-Internal-Secret") != secret {
		kit.Fail(w, 401, "unauthorized", "secret interne invalide ou absent")
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		kit.Fail(w, 400, "invalid_id", "id client invalide")
		return
	}
	var body struct {
		Type    string         `json:"type"` // billing | shipping
		Address map[string]any `json:"address"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Type != "billing" && body.Type != "shipping" {
		kit.Fail(w, 400, "invalid_type", `type doit être "billing" ou "shipping"`)
		return
	}
	if body.Address == nil {
		kit.Fail(w, 400, "missing_address", "address obligatoire")
		return
	}

	var raw []byte
	if err := s.db.QueryRow(r.Context(), "SELECT addresses FROM customers WHERE id = $1", id).Scan(&raw); err != nil {
		kit.Fail(w, 404, "customer_not_found", fmt.Sprintf("compte %d introuvable", id))
		return
	}
	var addresses []map[string]any
	_ = json.Unmarshal(raw, &addresses)

	body.Address["type"] = body.Type
	replaced := false
	for i, a := range addresses {
		if a["type"] == body.Type {
			addresses[i] = body.Address
			replaced = true
			break
		}
	}
	if !replaced {
		addresses = append(addresses, body.Address)
	}

	updated, err := json.Marshal(addresses)
	if err != nil {
		kit.Fail(w, 500, "encode_error", err.Error())
		return
	}
	if _, err := s.db.Exec(r.Context(), "UPDATE customers SET addresses = $2 WHERE id = $1", id, updated); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"ok": true, "addresses": addresses})
}

// listAdmins — comptes du back-office (module Utilisateurs), jamais le
// hash/sel du mot de passe. totp_enabled exposé pour que l'UI affiche si
// la 2FA est active sans avoir à la deviner.
func (s *server) listAdmins(w http.ResponseWriter, r *http.Request) {
	if err := s.requireRole(r, "admin"); err != nil {
		kit.Fail(w, 403, "admin_required", err.Error())
		return
	}
	rows, err := s.db.Query(r.Context(),
		"SELECT id, email, role, totp_enabled, created_at FROM admins ORDER BY id")
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var email, role string
		var totpEnabled bool
		var at time.Time
		if err := rows.Scan(&id, &email, &role, &totpEnabled, &at); err != nil {
			kit.Fail(w, 500, "db_error", "lecture admin échouée : "+err.Error())
			return
		}
		items = append(items, map[string]any{
			"id": id, "email": email, "role": role, "totp_enabled": totpEnabled,
			"created_at": at.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{"items": items, "total": len(items)})
}

// impersonateVendor — "se connecter en tant que" (module Vendeurs) :
// émet un JWT customer normal pour le compte lié à cette boutique, comme
// un login classique, sauf déclenché par un admin plutôt qu'un mot de
// passe. Choisit le PREMIER customer trouvé avec ce vendor_id (un vendeur
// = un compte customer lié, jamais plusieurs dans le modèle actuel).
func (s *server) impersonateVendor(w http.ResponseWriter, r *http.Request) {
	if err := s.requireRole(r, "admin"); err != nil {
		kit.Fail(w, 403, "admin_required", err.Error())
		return
	}
	vendorID, _ := strconv.ParseInt(r.PathValue("vendor_id"), 10, 64)
	if vendorID == 0 {
		kit.Fail(w, 400, "invalid_vendor_id", "vendor_id invalide")
		return
	}
	var customerID int64
	if err := s.db.QueryRow(r.Context(),
		"SELECT id FROM customers WHERE vendor_id = $1 LIMIT 1", vendorID,
	).Scan(&customerID); err != nil {
		kit.Fail(w, 404, "no_linked_account", fmt.Sprintf("aucun compte client lié au vendeur %d", vendorID))
		return
	}
	jwt, expires := s.signJWT(map[string]any{
		"sub": customerID, "iss": "miad-auth", "role": "customer",
		"vendor_id": float64(vendorID), "impersonated_by_admin": true,
		"exp": time.Now().Add(s.jwtTTL).Unix(),
	})
	kit.JSON(w, 200, map[string]any{
		"session":   map[string]any{"jwt": jwt, "expires_at": expires},
		"vendor_id": vendorID, "customer_id": customerID,
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

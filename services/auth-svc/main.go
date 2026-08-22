// ============================================================
// auth-svc — OTP (SMS/email), sessions Redis + JWT HS256.
// Publie : customer.registered
// Le code OTP n'est JAMAIS renvoyé dans la réponse : seule une
// référence opaque circule (le code vit en Redis, TTL borné).
// ============================================================
package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/IBM/sarama"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"

	"github.com/miadmarket/miad-backend/internal/kit"
)

const schema = `
CREATE TABLE IF NOT EXISTS customers (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT UNIQUE,
  phone           TEXT UNIQUE,
  full_name       TEXT DEFAULT '',
  addresses       JSONB NOT NULL DEFAULT '[]',
  preferred_lang  TEXT NOT NULL DEFAULT 'fr',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
`

type server struct {
	db      *pgxpool.Pool
	redis   *goredis.Client
	kafka   sarama.SyncProducer
	jwtSec  []byte
	otpTTL  time.Duration
	jwtTTL  time.Duration
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

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	health.Add("redis", s.redis.Ping)
	health.Add("jwt_secret", func(ctx context.Context) error {
		if string(s.jwtSec) == "change-me" {
			return fmt.Errorf("JWT_SECRET par défaut — à changer impérativement avant la prod")
		}
		return nil
	})

	kit.Run("auth-svc", kit.Env("PORT_AUTH", "8086"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("POST /auth/otp/send", s.sendOTP)
		mux.HandleFunc("POST /auth/otp/verify", s.verifyOTP)
		mux.HandleFunc("GET /customer/{id}", s.getCustomer)
	})
}

func (s *server) sendOTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Identifier string `json:"identifier"`
		Channel    string `json:"channel"` // sms | email
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
	refBytes := make([]byte, 16)
	_, _ = rand.Read(refBytes)
	ref := base64.RawURLEncoding.EncodeToString(refBytes)

	if err := s.redis.Set(r.Context(), "otp:"+ref,
		body.Identifier+"|"+body.Channel+"|"+code, s.otpTTL).Err(); err != nil {
		kit.Fail(w, 503, "session_store_down", "Redis indisponible : impossible d'émettre un OTP — erreur explicite")
		return
	}

	// Envoi réel : brancher le fournisseur SMS/email (SMS_PROVIDER_URL).
	// Sans fournisseur configuré, le code est journalisé — DEV UNIQUEMENT,
	// et c'est dit explicitement dans la réponse comme dans les logs.
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
		kit.Fail(w, 401, "otp_expired_or_unknown", "OTP expiré ou référence inconnue — renvoyer un code via /auth/otp/send")
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
	_ = s.redis.Del(r.Context(), "otp:"+body.OtpRef).Err() // usage unique

	// Upsert customer (nouveau compte → événement customer.registered).
	var id int64
	var isNew bool
	col, other := "email", "phone"
	if channel == "sms" {
		col, other = "phone", "email"
	}
	err = s.db.QueryRow(r.Context(),
		"SELECT id FROM customers WHERE "+col+" = $1", identifier).Scan(&id)
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
	_ = other

	jwt, expires := s.signJWT(id)
	// Session Redis partagée entre instances d'auth-svc (révocation possible).
	_ = s.redis.Set(r.Context(), "session:"+jwt, fmt.Sprint(id), s.jwtTTL).Err()

	kit.JSON(w, 200, map[string]any{
		"session":          map[string]string{"jwt": jwt, "expires_at": expires},
		"is_new_customer":  isNew,
		"customer_id":      id,
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
	// L'historique de commandes appartient à order-svc : le frontend
	// l'appelle directement (GET /orders?customer_id=…) — jamais de
	// lecture croisée de base.
	kit.JSON(w, 200, map[string]any{
		"id": cid, "email": email, "phone": phone, "full_name": name,
		"addresses": json.RawMessage(addresses), "preferred_lang": lang,
		"created_at": at.UTC().Format(time.RFC3339),
	})
}

// ---------- JWT HS256 minimal (crypto stdlib, zéro dépendance) ----------

func (s *server) signJWT(customerID int64) (string, string) {
	expires := time.Now().Add(s.jwtTTL).UTC()
	header := b64([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload := b64([]byte(fmt.Sprintf(`{"sub":%d,"iss":"miad-auth","exp":%d}`, customerID, expires.Unix())))
	sig := b64(hmacSHA256(s.jwtSec, header+"."+payload))
	return header + "." + payload + "." + sig, expires.Format(time.RFC3339)
}

func hmacSHA256(key, msg []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(msg)
	return m.Sum(nil)
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func randInt(max int) int {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	n := int(b[0])<<24 | int(b[1])<<16 | int(b[2])<<8 | int(b[3])
	if n < 0 {
		n = -n
	}
	return n % max
}

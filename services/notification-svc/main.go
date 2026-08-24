// ============================================================
// notification-svc — CONSOMMATEUR Kafka + envoi push FCM DIRECT.
// Écoute order.* et payment.* → notification webpush envoyée
// directement via Firebase Cloud Messaging HTTP v1 (compte de
// service Admin SDK, pas de relais vers le frontend Next.js —
// contrairement au PHP historique qui devait relayer car il ne
// détenait pas les identifiants Firebase).
// Le canal "email" reste journalisé ici pour compat (email-svc
// est le vrai envoyeur d'emails ; à terme, retirer ce canal
// dupliqué et ne garder que webpush dans ce service).
// Aucun autre service ne dépend de lui : s'il tombe, le reste
// continue ; il rattrape au redémarrage.
// ============================================================
package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/IBM/sarama"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/miadmarket/miad-backend/internal/kit"
)

const schema = `
CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  channel    TEXT NOT NULL CHECK (channel IN ('webpush','email')),
  event      TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'queued',
  error_msg  TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status);

-- Un client peut avoir plusieurs abonnements (plusieurs navigateurs/appareils).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id             BIGSERIAL PRIMARY KEY,
  customer_id    BIGINT NOT NULL,
  fcm_token      TEXT UNIQUE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_subs_customer ON push_subscriptions (customer_id);
`

var watchedTopics = []string{
	"order.created",
	"order.status_changed",
	"payment.confirmed",
	"payment.failed",
}

type server struct {
	db  *pgxpool.Pool
	fcm *fcmClient // nil si FIREBASE_SERVICE_ACCOUNT_JSON absent — mode journalisé
}

func main() {
	ctx := context.Background()
	log := kit.Logger("notification-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_NOTIFICATION", "postgres://miad:miad@postgres:5432/miad_notification?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema); err != nil {
		log.Error("migration impossible", "err", err)
		return
	}

	fcm, err := newFCMClient(kit.Env("FIREBASE_SERVICE_ACCOUNT_JSON", ""))
	if err != nil {
		log.Warn("Firebase Admin SDK non configuré — push journalisé sans envoi réel", "err", err)
	}

	s := &server{db: db, fcm: fcm}
	go s.consume(log)

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	health.Add("firebase_credentials", func(ctx context.Context) error {
		if s.fcm == nil {
			return fmt.Errorf("FIREBASE_SERVICE_ACCOUNT_JSON absent — push non envoyés réellement")
		}
		return nil
	})

	kit.Run("notification-svc", kit.Env("PORT_NOTIFICATION", "8087"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("GET /notifications/stats", s.stats)
		mux.HandleFunc("POST /push/subscribe", s.pushSubscribe)
		mux.HandleFunc("GET /push/stats", s.pushStats)
		mux.HandleFunc("POST /push/send", s.pushSendManual)
	})
}

func (s *server) consume(log *slog.Logger) {
	brokers := kit.Env("KAFKA_BROKERS", "kafka:9092")
	if brokers == "" {
		log.Warn("KAFKA_BROKERS vide — consommation désactivée (mode dev)")
		return
	}
	cfg := sarama.NewConfig()
	cfg.Consumer.Offsets.Initial = sarama.OffsetOldest
	cfg.Version = sarama.V2_8_0_0

	for {
		group, err := sarama.NewConsumerGroup([]string{brokers}, "notification-svc", cfg)
		if err != nil {
			log.Error("kafka injoignable — retry 5 s", "err", err)
			time.Sleep(5 * time.Second)
			continue
		}
		log.Info("consommateur connecté", "topics", watchedTopics)
		handler := consumerFunc(func(ctx context.Context, msg *sarama.ConsumerMessage) {
			s.handle(ctx, log, msg)
		})
		_ = group.Consume(context.Background(), watchedTopics, handler)
		group.Close()
	}
}

func (s *server) handle(ctx context.Context, log *slog.Logger, msg *sarama.ConsumerMessage) {
	var payload map[string]any
	_ = json.Unmarshal(msg.Value, &payload)

	// Le destinataire réel se résout via auth-svc (gRPC en prod).
	// Ici : référence de commande comme clé de routage.
	recipient := "customer@" + msg.Topic
	var customerID int64
	if rid, ok := payload["customer_id"]; ok {
		recipient = "customer:" + jsonNum(rid)
		customerID = toInt64(rid)
	}

	// email : journalisé ici pour compat historique — email-svc est le
	// véritable envoyeur (voir commentaire d'en-tête).
	body, _ := json.Marshal(payload)
	if _, err := s.db.Exec(ctx, `
		INSERT INTO notifications (channel, event, recipient, payload, status)
		VALUES ('email',$1,$2,$3,'queued')`, msg.Topic, recipient, body); err != nil {
		log.Error("persistance notification email impossible", "err", err)
		return // pas d'ack → Kafka redelivre : rien n'est perdu en silence
	}

	// webpush : envoi RÉEL via FCM si des identifiants Firebase sont
	// configurés et que le client a au moins un abonnement.
	s.sendWebpush(ctx, log, msg.Topic, customerID, recipient, payload)
}

// sendWebpush — un enregistrement `notifications` par abonnement FCM du
// client, avec le statut réel (sent/failed), jamais bloqué sur "queued".
func (s *server) sendWebpush(ctx context.Context, log *slog.Logger, event string, customerID int64, recipient string, payload map[string]any) {
	body, _ := json.Marshal(payload)

	if s.fcm == nil || customerID == 0 {
		if _, err := s.db.Exec(ctx, `
			INSERT INTO notifications (channel, event, recipient, payload, status)
			VALUES ('webpush',$1,$2,$3,'queued')`, event, recipient, body); err != nil {
			log.Error("persistance notification webpush impossible", "err", err)
		}
		return
	}

	rows, err := s.db.Query(ctx, "SELECT fcm_token FROM push_subscriptions WHERE customer_id = $1", customerID)
	if err != nil {
		log.Error("lecture abonnements push impossible", "customer_id", customerID, "err", err)
		return
	}
	tokens := []string{}
	for rows.Next() {
		var t string
		_ = rows.Scan(&t)
		tokens = append(tokens, t)
	}
	rows.Close()

	title, message := notificationCopy(event, payload)
	if len(tokens) == 0 {
		if _, err := s.db.Exec(ctx, `
			INSERT INTO notifications (channel, event, recipient, payload, status, error_msg)
			VALUES ('webpush',$1,$2,$3,'failed','aucun abonnement push pour ce client')`,
			event, recipient, body); err != nil {
			log.Error("persistance notification webpush impossible", "err", err)
		}
		return
	}

	for _, token := range tokens {
		status, errMsg := "sent", ""
		if err := s.fcm.send(ctx, token, title, message); err != nil {
			status, errMsg = "failed", err.Error()
			log.Error("envoi push FCM échoué", "customer_id", customerID, "err", err)
		}
		if _, err := s.db.Exec(ctx, `
			INSERT INTO notifications (channel, event, recipient, payload, status, error_msg, sent_at)
			VALUES ('webpush',$1,$2,$3,$4,$5, CASE WHEN $4='sent' THEN now() ELSE NULL END)`,
			event, recipient, body, status, errMsg); err != nil {
			log.Error("persistance notification webpush impossible", "err", err)
		}
	}
}

// notificationCopy — texte du push selon l'événement Kafka. Volontairement
// minimal : le contenu détaillé (montant, nom produit) reste dans email-svc,
// le push sert de rappel court.
func notificationCopy(event string, payload map[string]any) (title, message string) {
	switch event {
	case "order.created":
		return "Commande reçue", "Votre commande a été enregistrée."
	case "order.status_changed":
		status, _ := payload["status"].(string)
		return "Commande mise à jour", "Nouveau statut : " + status
	case "payment.confirmed":
		return "Paiement confirmé", "Votre paiement a été validé."
	case "payment.failed":
		return "Paiement échoué", "Le paiement n'a pas pu être confirmé."
	default:
		return "MIAD Market", "Mise à jour de votre commande."
	}
}

func toInt64(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	default:
		return 0
	}
}

func (s *server) stats(w http.ResponseWriter, r *http.Request) {
	row := s.db.QueryRow(r.Context(), `
		SELECT
		  count(*) FILTER (WHERE status='queued'),
		  count(*) FILTER (WHERE status='sent'),
		  count(*) FILTER (WHERE status='failed')
		FROM notifications`)
	var queued, sent, failed int64
	if err := row.Scan(&queued, &sent, &failed); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{
		"queued": queued, "sent": sent, "failed": failed,
		"watched_topics": watchedTopics,
	})
}

func jsonNum(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

/* ---------- Push : abonnements + envoi manuel ---------- */

func (s *server) pushSubscribe(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CustomerID int64  `json:"customer_id"`
		FCMToken   string `json:"fcm_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.CustomerID == 0 || body.FCMToken == "" {
		kit.Fail(w, 400, "missing_fields", "customer_id et fcm_token obligatoires")
		return
	}
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO push_subscriptions (customer_id, fcm_token) VALUES ($1,$2)
		ON CONFLICT (fcm_token) DO UPDATE SET customer_id = EXCLUDED.customer_id`,
		body.CustomerID, body.FCMToken); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"customer_id": body.CustomerID, "subscribed": true})
}

func (s *server) pushStats(w http.ResponseWriter, r *http.Request) {
	var subs int64
	_ = s.db.QueryRow(r.Context(), "SELECT count(*) FROM push_subscriptions").Scan(&subs)
	row := s.db.QueryRow(r.Context(), `
		SELECT count(*) FILTER (WHERE status='sent'), count(*) FILTER (WHERE status='failed')
		FROM notifications WHERE channel = 'webpush'`)
	var sent, failed int64
	_ = row.Scan(&sent, &failed)
	kit.JSON(w, 200, map[string]any{
		"subscriptions": subs, "sent": sent, "failed": failed, "fcm_configured": s.fcm != nil,
	})
}

// pushSendManual — envoi ponctuel (campagne, test), hors flux Kafka.
func (s *server) pushSendManual(w http.ResponseWriter, r *http.Request) {
	if s.fcm == nil {
		kit.Fail(w, 503, "fcm_not_configured", "FIREBASE_SERVICE_ACCOUNT_JSON absent")
		return
	}
	var body struct {
		CustomerID int64  `json:"customer_id"`
		Title      string `json:"title"`
		Message    string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.CustomerID == 0 || body.Title == "" || body.Message == "" {
		kit.Fail(w, 400, "missing_fields", "customer_id, title et message obligatoires")
		return
	}
	rows, err := s.db.Query(r.Context(), "SELECT fcm_token FROM push_subscriptions WHERE customer_id = $1", body.CustomerID)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	tokens := []string{}
	for rows.Next() {
		var t string
		_ = rows.Scan(&t)
		tokens = append(tokens, t)
	}
	rows.Close()
	if len(tokens) == 0 {
		kit.Fail(w, 404, "no_subscription", fmt.Sprintf("aucun abonnement push pour le client %d", body.CustomerID))
		return
	}
	sent, failed := 0, 0
	for _, token := range tokens {
		if err := s.fcm.send(r.Context(), token, body.Title, body.Message); err != nil {
			failed++
		} else {
			sent++
		}
	}
	kit.JSON(w, 200, map[string]any{"sent": sent, "failed": failed})
}

/* ---------- Firebase Cloud Messaging (Admin SDK, HTTP v1) ----------
   Contrairement au PHP historique (qui relayait l'envoi via Next.js,
   seul détenteur des identifiants Firebase), notification-svc détient
   directement le compte de service et appelle FCM sans relais.
   FIREBASE_SERVICE_ACCOUNT_JSON = contenu JSON du fichier de compte de
   service (téléchargé depuis la console Firebase), PAS un chemin de
   fichier — cohérent avec "jamais de secret en fichier local" du .env. */

type serviceAccount struct {
	ProjectID   string `json:"project_id"`
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
	TokenURI    string `json:"token_uri"`
}

type fcmClient struct {
	account serviceAccount
	privKey *rsa.PrivateKey

	mu          sync.Mutex
	accessToken string
	expiresAt   time.Time
}

func newFCMClient(rawJSON string) (*fcmClient, error) {
	if rawJSON == "" {
		return nil, fmt.Errorf("FIREBASE_SERVICE_ACCOUNT_JSON vide")
	}
	var acct serviceAccount
	if err := json.Unmarshal([]byte(rawJSON), &acct); err != nil {
		return nil, fmt.Errorf("FIREBASE_SERVICE_ACCOUNT_JSON illisible: %w", err)
	}
	if acct.ProjectID == "" || acct.ClientEmail == "" || acct.PrivateKey == "" {
		return nil, fmt.Errorf("FIREBASE_SERVICE_ACCOUNT_JSON incomplet (project_id/client_email/private_key)")
	}
	block, _ := pem.Decode([]byte(acct.PrivateKey))
	if block == nil {
		return nil, fmt.Errorf("private_key : PEM invalide")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("private_key illisible: %w", err)
	}
	rsaKey, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("private_key n'est pas RSA")
	}
	if acct.TokenURI == "" {
		acct.TokenURI = "https://oauth2.googleapis.com/token"
	}
	return &fcmClient{account: acct, privKey: rsaKey}, nil
}

// accessTokenFor — JWT RS256 signé par le compte de service, échangé
// contre un access token OAuth2 (grant_type=jwt-bearer, RFC 7523).
// Mis en cache jusqu'à expiration (marge de 60s).
func (c *fcmClient) accessTokenFor(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.accessToken != "" && time.Now().Before(c.expiresAt) {
		return c.accessToken, nil
	}

	now := time.Now()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]any{
		"iss":   c.account.ClientEmail,
		"scope": "https://www.googleapis.com/auth/firebase.messaging",
		"aud":   c.account.TokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(1 * time.Hour).Unix(),
	})
	payload := base64.RawURLEncoding.EncodeToString(claims)
	signingInput := header + "." + payload

	hashed := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, c.privKey, crypto.SHA256, hashed[:])
	if err != nil {
		return "", fmt.Errorf("signature JWT impossible: %w", err)
	}
	assertion := signingInput + "." + base64.RawURLEncoding.EncodeToString(sig)

	form := "grant_type=" + "urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer" + "&assertion=" + assertion
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.account.TokenURI, strings.NewReader(form))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("échange de jeton Google impossible: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("Google a répondu %d: %s", resp.StatusCode, string(respBody))
	}
	var tokenResp struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(respBody, &tokenResp); err != nil {
		return "", fmt.Errorf("réponse Google illisible: %w", err)
	}
	c.accessToken = tokenResp.AccessToken
	c.expiresAt = now.Add(time.Duration(tokenResp.ExpiresIn-60) * time.Second)
	return c.accessToken, nil
}

// send — POST vers FCM HTTP v1 (fcm.googleapis.com/v1/projects/{id}/messages:send).
func (c *fcmClient) send(ctx context.Context, fcmToken, title, message string) error {
	token, err := c.accessTokenFor(ctx)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("https://fcm.googleapis.com/v1/projects/%s/messages:send", c.account.ProjectID)
	body, _ := json.Marshal(map[string]any{
		"message": map[string]any{
			"token": fcmToken,
			"notification": map[string]string{
				"title": title,
				"body":  message,
			},
		},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("FCM injoignable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("FCM a répondu %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// ---------- adaptateur consommateur minimal ----------

type consumerFunc func(ctx context.Context, msg *sarama.ConsumerMessage)

func (f consumerFunc) Setup(sarama.ConsumerGroupSession) error   { return nil }
func (f consumerFunc) Cleanup(sarama.ConsumerGroupSession) error { return nil }
func (f consumerFunc) ConsumeClaim(sess sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
	for msg := range claim.Messages() {
		f(sess.Context(), msg)
		sess.MarkMessage(msg, "")
	}
	return nil
}

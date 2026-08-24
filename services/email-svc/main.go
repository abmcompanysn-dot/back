// ============================================================
// email-svc — Service d'envoi et réception d'emails avec Resend
//
// Fonctionnalités :
//   - Envoi d'emails transactionnels via Resend API
//   - Templates HTML professionnels pour MIAD Market
//   - Gestion des événements Kafka (order.created, payment.confirmed, etc.)
//   - Webhook pour recevoir les emails (réponses clients)
//   - Retry automatique + logging détaillé
//   - Support OTP, confirmation commande, paiement, bienvenue
// ============================================================
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/IBM/sarama"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/miadmarket/miad-backend/internal/kit"
)

const schema = `
CREATE TABLE IF NOT EXISTS emails (
  id           BIGSERIAL PRIMARY KEY,
  to_addr      TEXT NOT NULL,
  from_addr    TEXT NOT NULL DEFAULT 'noreply@miadmarket.ca',
  subject      TEXT NOT NULL,
  template     TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'queued',
  resend_id    TEXT,
  error_msg    TEXT,
  attempts     INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails (status);
CREATE INDEX IF NOT EXISTS idx_emails_to ON emails (to_addr);
CREATE INDEX IF NOT EXISTS idx_emails_created ON emails (created_at);

CREATE TABLE IF NOT EXISTS email_events (
  id         BIGSERIAL PRIMARY KEY,
  email_id   BIGINT REFERENCES emails(id),
  event_type TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_events_email_id ON email_events (email_id);
`

var watchedTopics = []string{
	"order.created",
	"order.status_changed",
	"payment.confirmed",
	"payment.failed",
	"customer.registered",
}

type server struct {
	db          *pgxpool.Pool
	resendAPI   string
	fromEmail   string
	frontendURL string
	maxAttempts int
}

type EmailTemplate struct {
	Name       string
	SubjectTpl string
	BodyTpl    string
}

// Templates d'emails MIAD Market
var templates = map[string]EmailTemplate{
	"welcome": {
		Name:       "welcome",
		SubjectTpl: "Bienvenue chez MIAD Market !",
		BodyTpl:    welcomeEmailHTML,
	},
	"order_confirmation": {
		Name:       "order_confirmation",
		SubjectTpl: "Confirmation de commande #{{.OrderID}}",
		BodyTpl:    orderConfirmationHTML,
	},
	"payment_confirmed": {
		Name:       "payment_confirmed",
		SubjectTpl: "Paiement confirmé - Commande #{{.OrderID}}",
		BodyTpl:    paymentConfirmedHTML,
	},
	"payment_failed": {
		Name:       "payment_failed",
		SubjectTpl: "Échec du paiement - Commande #{{.OrderID}}",
		BodyTpl:    paymentFailedHTML,
	},
	"order_shipped": {
		Name:       "order_shipped",
		SubjectTpl: "Votre commande #{{.OrderID}} a été expédiée !",
		BodyTpl:    orderShippedHTML,
	},
	"otp_email": {
		Name:       "otp_email",
		SubjectTpl: "Votre code de vérification MIAD Market",
		BodyTpl:    otpEmailHTML,
	},
	"password_reset": {
		Name:       "password_reset",
		SubjectTpl: "Réinitialisation de mot de passe",
		BodyTpl:    passwordResetHTML,
	},
}

func main() {
	ctx := context.Background()
	log := kit.Logger("email-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_EMAIL", "postgres://miad:miad@postgres:5432/miad_email?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema); err != nil {
		log.Error("migration impossible", "err", err)
		return
	}

	resendAPI := kit.Env("RESEND_API_KEY", "")
	if resendAPI == "" {
		log.Warn("RESEND_API_KEY non définie — mode simulation activé")
	}

	s := &server{
		db:          db,
		resendAPI:   resendAPI,
		fromEmail:   kit.Env("FROM_EMAIL", "noreply@miadmarket.ca"),
		frontendURL: kit.Env("STOREFRONT_URL", "https://miadmarket.ca"),
		maxAttempts: 3,
	}

	// Démarrer le consommateur Kafka
	go s.consume(log)

	// Démarrer le worker d'envoi
	go s.emailWorker(log)

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	health.Add("resend_api", func(ctx context.Context) error {
		if s.resendAPI == "" {
			return fmt.Errorf("RESEND_API_KEY non configurée")
		}
		return nil
	})

	kit.Run("email-svc", kit.Env("PORT_EMAIL", "8089"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("GET /emails/stats", s.stats)
		mux.HandleFunc("POST /emails/send", s.sendEmail)
		mux.HandleFunc("POST /webhooks/resend", s.resendWebhook)
		mux.HandleFunc("POST /webhooks/inbound", s.inboundWebhook)
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
		group, err := sarama.NewConsumerGroup([]string{brokers}, "email-svc", cfg)
		if err != nil {
			log.Error("kafka injoignable — retry 5 s", "err", err)
			time.Sleep(5 * time.Second)
			continue
		}
		log.Info("consommateur email connecté", "topics", watchedTopics)
		handler := consumerFunc(func(ctx context.Context, msg *sarama.ConsumerMessage) {
			s.handleKafkaEvent(ctx, log, msg)
		})
		_ = group.Consume(context.Background(), watchedTopics, handler)
		group.Close()
	}
}

func (s *server) handleKafkaEvent(ctx context.Context, log *slog.Logger, msg *sarama.ConsumerMessage) {
	var payload map[string]any
	if err := json.Unmarshal(msg.Value, &payload); err != nil {
		log.Error("décodage payload kafka échoué", "err", err)
		return
	}

	log.Info("événement kafka reçu", "topic", msg.Topic, "payload", payload)

	switch msg.Topic {
	case "customer.registered":
		s.queueWelcomeEmail(ctx, log, payload)
	case "order.created":
		s.queueOrderConfirmation(ctx, log, payload)
	case "payment.confirmed":
		s.queuePaymentConfirmed(ctx, log, payload)
	case "payment.failed":
		s.queuePaymentFailed(ctx, log, payload)
	case "order.status_changed":
		if status, ok := payload["status"].(string); ok && status == "shipped" {
			s.queueOrderShipped(ctx, log, payload)
		}
	}
}

func (s *server) queueWelcomeEmail(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, _ := payload["email"].(string)
	if email == "" {
		log.Warn("email manquant pour welcome")
		return
	}
	s.queueEmail(ctx, log, email, "welcome", "Bienvenue chez MIAD Market !", payload)
}

func (s *server) queueOrderConfirmation(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, _ := payload["customer_email"].(string)
	if email == "" {
		log.Warn("email client manquant pour confirmation commande")
		return
	}
	subject := fmt.Sprintf("Confirmation de commande #%v", payload["order_id"])
	s.queueEmail(ctx, log, email, "order_confirmation", subject, payload)
}

func (s *server) queuePaymentConfirmed(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, _ := payload["customer_email"].(string)
	if email == "" {
		log.Warn("email client manquant pour paiement confirmé")
		return
	}
	subject := fmt.Sprintf("Paiement confirmé - Commande #%v", payload["order_id"])
	s.queueEmail(ctx, log, email, "payment_confirmed", subject, payload)
}

func (s *server) queuePaymentFailed(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, _ := payload["customer_email"].(string)
	if email == "" {
		log.Warn("email client manquant pour paiement échoué")
		return
	}
	subject := fmt.Sprintf("Échec du paiement - Commande #%v", payload["order_id"])
	s.queueEmail(ctx, log, email, "payment_failed", subject, payload)
}

func (s *server) queueOrderShipped(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, _ := payload["customer_email"].(string)
	if email == "" {
		log.Warn("email client manquant pour commande expédiée")
		return
	}
	subject := fmt.Sprintf("Votre commande #%v a été expédiée !", payload["order_id"])
	s.queueEmail(ctx, log, email, "order_shipped", subject, payload)
}

func (s *server) queueEmail(ctx context.Context, log *slog.Logger, to, templateName, subject string, payload map[string]any) {
	payloadJSON, _ := json.Marshal(payload)

	var emailID int64
	err := s.db.QueryRow(ctx, `
		INSERT INTO emails (to_addr, from_addr, subject, template, payload, status)
		VALUES ($1, $2, $3, $4, $5, 'queued')
		RETURNING id`,
		to, s.fromEmail, subject, templateName, payloadJSON,
	).Scan(&emailID)

	if err != nil {
		log.Error("échec mise en file email", "err", err)
		return
	}
	log.Info("email mis en file", "id", emailID, "to", to, "template", templateName)
}

func (s *server) emailWorker(log *slog.Logger) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		s.processQueue(log)
	}
}

func (s *server) processQueue(log *slog.Logger) {
	ctx := context.Background()

	rows, err := s.db.Query(ctx, `
		SELECT id, to_addr, from_addr, subject, template, payload, attempts
		FROM emails
		WHERE status = 'queued' AND attempts < $1
		ORDER BY created_at ASC
		LIMIT 10`, s.maxAttempts)

	if err != nil {
		log.Error("lecture file emails échouée", "err", err)
		return
	}
	defer rows.Close()

	type emailJob struct {
		id       int64
		to       string
		from     string
		subject  string
		template string
		payload  []byte
		attempts int
	}

	jobs := []emailJob{}
	for rows.Next() {
		var j emailJob
		if err := rows.Scan(&j.id, &j.to, &j.from, &j.subject, &j.template, &j.payload, &j.attempts); err != nil {
			log.Error("scan email échoué", "err", err)
			continue
		}
		jobs = append(jobs, j)
	}

	for _, job := range jobs {
		s.sendEmailJob(ctx, log, job)
	}
}

func (s *server) sendEmailJob(ctx context.Context, log *slog.Logger, job struct {
	id       int64
	to       string
	from     string
	subject  string
	template string
	payload  []byte
	attempts int
}) {
	// Mettre à jour le statut et les tentatives
	_, err := s.db.Exec(ctx, `
		UPDATE emails SET status = 'sending', attempts = attempts + 1
		WHERE id = $1`, job.id)
	if err != nil {
		log.Error("update statut sending échoué", "err", err)
		return
	}

	var payload map[string]any
	json.Unmarshal(job.payload, &payload)

	// Générer le contenu HTML
	htmlBody, err := s.renderTemplate(job.template, payload)
	if err != nil {
		s.markEmailFailed(ctx, log, job.id, fmt.Sprintf("template error: %v", err))
		return
	}

	// Envoyer via Resend
	if s.resendAPI == "" {
		// Mode simulation
		log.Info("[SIMULATION] Email envoyé", "to", job.to, "subject", job.subject, "template", job.template)
		s.markEmailSent(ctx, log, job.id, "simulated")
		return
	}

	resendID, err := s.sendViaResend(job.from, job.to, job.subject, htmlBody)
	if err != nil {
		s.markEmailFailed(ctx, log, job.id, err.Error())
		return
	}

	s.markEmailSent(ctx, log, job.id, resendID)
	log.Info("email envoyé avec succès", "id", job.id, "to", job.to, "resend_id", resendID)
}

func (s *server) sendViaResend(from, to, subject, htmlBody string) (string, error) {
	reqBody := map[string]any{
		"from":    from,
		"to":      []string{to},
		"subject": subject,
		"html":    htmlBody,
	}

	jsonData, _ := json.Marshal(reqBody)
	req, err := http.NewRequest("POST", "https://api.resend.com/emails", bytes.NewReader(jsonData))
	if err != nil {
		return "", fmt.Errorf("création requête Resend: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.resendAPI)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("envoi Resend: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Resend error %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		ID string `json:"id"`
	}
	json.Unmarshal(body, &result)
	return result.ID, nil
}

func (s *server) markEmailSent(ctx context.Context, log *slog.Logger, emailID int64, resendID string) {
	_, err := s.db.Exec(ctx, `
		UPDATE emails SET status = 'sent', resend_id = $1, sent_at = now()
		WHERE id = $2`, resendID, emailID)
	if err != nil {
		log.Error("update statut sent échoué", "err", err)
	}
}

func (s *server) markEmailFailed(ctx context.Context, log *slog.Logger, emailID int64, errMsg string) {
	// Vérifier si on peut retry
	var attempts int
	err := s.db.QueryRow(ctx, "SELECT attempts FROM emails WHERE id = $1", emailID).Scan(&attempts)
	if err != nil {
		log.Error("lecture attempts échouée", "err", err)
		return
	}

	status := "failed"
	if attempts < s.maxAttempts {
		status = "queued" // On remet en file pour retry
	}

	_, err = s.db.Exec(ctx, `
		UPDATE emails SET status = $1, error_msg = $2
		WHERE id = $3`, status, errMsg, emailID)
	if err != nil {
		log.Error("update statut failed échoué", "err", err)
	}

	// Logger l'événement
	s.logEmailEvent(ctx, emailID, "send_failed", map[string]any{"error": errMsg})
}

func (s *server) logEmailEvent(ctx context.Context, emailID int64, eventType string, payload map[string]any) {
	payloadJSON, _ := json.Marshal(payload)
	_, err := s.db.Exec(ctx, `
		INSERT INTO email_events (email_id, event_type, payload)
		VALUES ($1, $2, $3)`, emailID, eventType, payloadJSON)
	if err != nil {
		slog.Error("log événement email échoué", "err", err)
	}
}

func (s *server) renderTemplate(templateName string, data map[string]any) (string, error) {
	tpl, ok := templates[templateName]
	if !ok {
		return "", fmt.Errorf("template inconnu: %s", templateName)
	}

	tmpl, err := template.New(tpl.Name).Parse(tpl.BodyTpl)
	if err != nil {
		return "", fmt.Errorf("parse template: %w", err)
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("execute template: %w", err)
	}

	return buf.String(), nil
}

// ---------- Handlers HTTP ----------

func (s *server) stats(w http.ResponseWriter, r *http.Request) {
	row := s.db.QueryRow(r.Context(), `
		SELECT
		  count(*) FILTER (WHERE status='queued'),
		  count(*) FILTER (WHERE status='sent'),
		  count(*) FILTER (WHERE status='failed'),
		  count(*) FILTER (WHERE status='sending')
		FROM emails`)

	var queued, sent, failed, sending int64
	if err := row.Scan(&queued, &sent, &failed, &sending); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	kit.JSON(w, 200, map[string]any{
		"queued":         queued,
		"sent":           sent,
		"failed":         failed,
		"sending":        sending,
		"watched_topics": watchedTopics,
	})
}

func (s *server) sendEmail(w http.ResponseWriter, r *http.Request) {
	var body struct {
		To       string         `json:"to"`
		From     string         `json:"from"`
		Subject  string         `json:"subject"`
		Template string         `json:"template"`
		Payload  map[string]any `json:"payload"`
	}

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}

	if body.To == "" || body.Subject == "" {
		kit.Fail(w, 400, "missing_fields", "to et subject obligatoires")
		return
	}

	if body.From == "" {
		body.From = s.fromEmail
	}

	payloadJSON, _ := json.Marshal(body.Payload)

	var emailID int64
	err := s.db.QueryRow(r.Context(), `
		INSERT INTO emails (to_addr, from_addr, subject, template, payload, status)
		VALUES ($1, $2, $3, $4, $5, 'queued')
		RETURNING id`,
		body.To, body.From, body.Subject, body.Template, payloadJSON,
	).Scan(&emailID)

	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	kit.JSON(w, 201, map[string]any{
		"id":      emailID,
		"status":  "queued",
		"message": "email mis en file",
	})
}

func (s *server) resendWebhook(w http.ResponseWriter, r *http.Request) {
	// Webhook pour les événements Resend (delivered, opened, clicked, bounced, complained)
	var event struct {
		Type string `json:"type"`
		Data struct {
			EmailID string `json:"email_id"`
		} `json:"data"`
	}

	if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}

	log := kit.Logger("email-svc")
	log.Info("webhook Resend reçu", "type", event.Type, "email_id", event.Data.EmailID)

	// Trouver l'email par resend_id et mettre à jour
	ctx := r.Context()
	var emailID int64
	err := s.db.QueryRow(ctx, "SELECT id FROM emails WHERE resend_id = $1", event.Data.EmailID).Scan(&emailID)
	if err != nil {
		kit.Fail(w, 404, "email_not_found", "email introuvable")
		return
	}

	// Mettre à jour selon le type d'événement
	switch event.Type {
	case "email.delivered":
		_, _ = s.db.Exec(ctx, "UPDATE emails SET delivered_at = now() WHERE id = $1", emailID)
	case "email.opened", "email.clicked":
		// Tracker dans email_events
	}

	s.logEmailEvent(ctx, emailID, "resend_"+event.Type, map[string]any{"resend_id": event.Data.EmailID})

	kit.JSON(w, 200, map[string]string{"status": "ok"})
}

func (s *server) inboundWebhook(w http.ResponseWriter, r *http.Request) {
	// Webhook pour recevoir les emails entrants (réponses clients)
	// Resend forwards les emails reçus vers cette URL

	var inbound struct {
		From    string `json:"from"`
		To      string `json:"to"`
		Subject string `json:"subject"`
		Body    string `json:"text"` // ou "html"
	}

	if err := json.NewDecoder(r.Body).Decode(&inbound); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}

	log := kit.Logger("email-svc")
	log.Info("email entrant reçu", "from", inbound.From, "to", inbound.To, "subject", inbound.Subject)

	// Ici on peut :
	// - Stocker la réponse dans une table
	// - Forward vers un service de support
	// - Déclencher une notification

	kit.JSON(w, 200, map[string]string{"status": "received"})
}

// ---------- Templates HTML ----------

const welcomeEmailHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bienvenue chez MIAD Market</title>
</head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f4f4f4;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 0;">
        <table role="presentation" style="width:600px;border-collapse:collapse;background-color:#ffffff;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
          <tr>
            <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:40px;text-align:center;">
              <h1 style="color:#ffffff;margin:0;font-size:28px;">🎉 Bienvenue chez MIAD Market !</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 30px;">
              <p style="font-size:18px;color:#333333;margin-bottom:20px;">
                Bonjour {{if .full_name}}{{.full_name}}{{else}}Cher client{{end}},
              </p>
              <p style="font-size:16px;color:#555555;line-height:1.6;margin-bottom:20px;">
                Nous sommes ravis de vous accueillir sur <strong>MIAD Market</strong>, votre nouvelle destination shopping en ligne.
              </p>
              <p style="font-size:16px;color:#555555;line-height:1.6;margin-bottom:30px;">
                Découvrez des milliers de produits à prix imbattables, une livraison rapide et un service client dédié.
              </p>
              <table role="presentation" style="margin:30px 0;">
                <tr>
                  <td align="center" style="background-color:#667eea;padding:15px 30px;border-radius:8px;">
                    <a href="{{.frontend_url}}" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:bold;">Commencer mes achats →</a>
                  </td>
                </tr>
              </table>
              <p style="font-size:14px;color:#888888;margin-top:30px;">
                À très bientôt,<br>
                <strong>L'équipe MIAD Market</strong>
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8f9fa;padding:20px;text-align:center;border-top:1px solid #eeeeee;">
              <p style="font-size:12px;color:#999999;margin:0;">
                © 2024 MIAD Market. Tous droits réservés.<br>
                Vous recevez cet email car vous avez créé un compte sur miadmarket.ca
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const orderConfirmationHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirmation de commande</title>
</head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f4f4f4;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 0;">
        <table role="presentation" style="width:600px;border-collapse:collapse;background-color:#ffffff;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
          <tr>
            <td style="background:linear-gradient(135deg,#11998e 0%,#38ef7d 100%);padding:40px;text-align:center;">
              <h1 style="color:#ffffff;margin:0;font-size:28px;">✅ Commande confirmée !</h1>
              <p style="color:#ffffff;margin:10px 0 0 0;font-size:18px;">#{{.OrderID}}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 30px;">
              <p style="font-size:16px;color:#333333;margin-bottom:20px;">
                Merci pour votre commande ! Nous la préparons avec soin.
              </p>
              
              <table role="presentation" style="width:100%;border-collapse:collapse;margin:20px 0;background-color:#f8f9fa;">
                <tr>
                  <td style="padding:15px;border-bottom:1px solid #dddddd;">
                    <strong>Date de commande</strong><br>
                    <span style="color:#666666;">{{.CreatedAt}}</span>
                  </td>
                  <td style="padding:15px;border-bottom:1px solid #dddddd;">
                    <strong>Statut</strong><br>
                    <span style="color:#11998e;font-weight:bold;">Confirmée</span>
                  </td>
                </tr>
                {{if .TotalAmount}}
                <tr>
                  <td colspan="2" style="padding:15px;">
                    <strong>Montant total</strong><br>
                    <span style="color:#11998e;font-size:20px;font-weight:bold;">{{.TotalAmount}} Ar</span>
                  </td>
                </tr>
                {{end}}
              </table>
              
              {{if .Items}}
              <h3 style="color:#333333;margin:30px 0 15px 0;">Articles commandés :</h3>
              <table role="presentation" style="width:100%;border-collapse:collapse;">
                {{range .Items}}
                <tr>
                  <td style="padding:10px;border-bottom:1px solid #eeeeee;">• {{.Name}}</td>
                  <td align="right" style="padding:10px;border-bottom:1px solid #eeeeee;">{{.Quantity}} x {{.Price}}</td>
                </tr>
                {{end}}
              </table>
              {{end}}
              
              <p style="font-size:14px;color:#888888;margin-top:30px;">
                Vous recevrez un email lorsque votre commande sera expédiée.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8f9fa;padding:20px;text-align:center;border-top:1px solid #eeeeee;">
              <p style="font-size:12px;color:#999999;margin:0;">
                © 2024 MIAD Market. Tous droits réservés.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const paymentConfirmedHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Paiement confirmé</title>
</head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f4f4f4;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 0;">
        <table role="presentation" style="width:600px;border-collapse:collapse;background-color:#ffffff;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
          <tr>
            <td style="background:linear-gradient(135deg,#56ab2f 0%,#a8e063 100%);padding:40px;text-align:center;">
              <h1 style="color:#ffffff;margin:0;font-size:28px;">💳 Paiement confirmé !</h1>
              <p style="color:#ffffff;margin:10px 0 0 0;font-size:18px;">Commande #{{.OrderID}}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 30px;">
              <p style="font-size:16px;color:#333333;margin-bottom:20px;">
                Votre paiement a été traité avec succès.
              </p>
              
              <table role="presentation" style="width:100%;border-collapse:collapse;margin:20px 0;">
                <tr>
                  <td style="padding:15px;background-color:#e8f5e9;border-radius:8px;text-align:center;">
                    <span style="font-size:24px;color:#56ab2f;font-weight:bold;">{{.TotalAmount}} Ar</span>
                  </td>
                </tr>
              </table>
              
              <p style="font-size:14px;color:#888888;margin-top:30px;">
                Votre commande est maintenant en préparation.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8f9fa;padding:20px;text-align:center;border-top:1px solid #eeeeee;">
              <p style="font-size:12px;color:#999999;margin:0;">
                © 2024 MIAD Market. Tous droits réservés.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const paymentFailedHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Échec du paiement</title>
</head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f4f4f4;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 0;">
        <table role="presentation" style="width:600px;border-collapse:collapse;background-color:#ffffff;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
          <tr>
            <td style="background:linear-gradient(135deg,#eb3349 0%,#f45c43 100%);padding:40px;text-align:center;">
              <h1 style="color:#ffffff;margin:0;font-size:28px;">⚠️ Échec du paiement</h1>
              <p style="color:#ffffff;margin:10px 0 0 0;font-size:18px;">Commande #{{.OrderID}}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 30px;">
              <p style="font-size:16px;color:#333333;margin-bottom:20px;">
                Le paiement de votre commande n'a pas abouti.
              </p>
              
              <div style="background-color:#fff3cd;padding:20px;border-radius:8px;margin:20px 0;">
                <p style="margin:0;color:#856404;">
                  <strong>Raison :</strong> {{if .ErrorReason}}{{.ErrorReason}}{{else}}Problème de traitement{{end}}
                </p>
              </div>
              
              <table role="presentation" style="margin:30px 0;">
                <tr>
                  <td align="center" style="background-color:#eb3349;padding:15px 30px;border-radius:8px;">
                    <a href="{{.frontend_url}}/orders/{{.OrderID}}/pay" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:bold;">Réessayer le paiement →</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8f9fa;padding:20px;text-align:center;border-top:1px solid #eeeeee;">
              <p style="font-size:12px;color:#999999;margin:0;">
                © 2024 MIAD Market. Tous droits réservés.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const orderShippedHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commande expédiée</title>
</head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f4f4f4;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 0;">
        <table role="presentation" style="width:600px;border-collapse:collapse;background-color:#ffffff;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
          <tr>
            <td style="background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%);padding:40px;text-align:center;">
              <h1 style="color:#ffffff;margin:0;font-size:28px;">📦 Commande expédiée !</h1>
              <p style="color:#ffffff;margin:10px 0 0 0;font-size:18px;">#{{.OrderID}}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 30px;">
              <p style="font-size:16px;color:#333333;margin-bottom:20px;">
                Bonne nouvelle ! Votre commande est en route.
              </p>
              
              {{if .TrackingNumber}}
              <div style="background-color:#e3f2fd;padding:20px;border-radius:8px;margin:20px 0;">
                <p style="margin:0;color:#1976d2;">
                  <strong>Numéro de suivi :</strong> {{.TrackingNumber}}
                </p>
              </div>
              {{end}}
              
              {{if .Carrier}}
              <p style="font-size:14px;color:#666666;">
                Transporteur : <strong>{{.Carrier}}</strong>
              </p>
              {{end}}
              
              <p style="font-size:14px;color:#888888;margin-top:30px;">
                Livraison estimée : {{if .EstimatedDelivery}}{{.EstimatedDelivery}}{{else}}2-5 jours ouvrés{{end}}
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8f9fa;padding:20px;text-align:center;border-top:1px solid #eeeeee;">
              <p style="font-size:12px;color:#999999;margin:0;">
                © 2024 MIAD Market. Tous droits réservés.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const otpEmailHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Code de vérification</title>
</head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f4f4f4;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 0;">
        <table role="presentation" style="width:600px;border-collapse:collapse;background-color:#ffffff;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
          <tr>
            <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:40px;text-align:center;">
              <h1 style="color:#ffffff;margin:0;font-size:28px;">🔐 Votre code de vérification</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 30px;text-align:center;">
              <p style="font-size:16px;color:#333333;margin-bottom:30px;">
                Voici votre code de vérification MIAD Market :
              </p>
              
              <div style="background-color:#f8f9fa;padding:30px;border-radius:8px;margin:20px 0;display:inline-block;">
                <span style="font-size:36px;font-weight:bold;color:#667eea;letter-spacing:8px;">{{.Code}}</span>
              </div>
              
              <p style="font-size:14px;color:#888888;margin-top:20px;">
                Ce code expire dans {{.TTLMinutes}} minutes.<br>
                Ne le partagez avec personne.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8f9fa;padding:20px;text-align:center;border-top:1px solid #eeeeee;">
              <p style="font-size:12px;color:#999999;margin:0;">
                © 2024 MIAD Market. Tous droits réservés.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const passwordResetHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Réinitialisation de mot de passe</title>
</head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f4f4f4;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 0;">
        <table role="presentation" style="width:600px;border-collapse:collapse;background-color:#ffffff;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
          <tr>
            <td style="background:linear-gradient(135deg,#4facfe 0%,#00f2fe 100%);padding:40px;text-align:center;">
              <h1 style="color:#ffffff;margin:0;font-size:28px;">🔑 Réinitialisation de mot de passe</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 30px;">
              <p style="font-size:16px;color:#333333;margin-bottom:20px;">
                Vous avez demandé à réinitialiser votre mot de passe.
              </p>
              
              <table role="presentation" style="margin:30px 0;">
                <tr>
                  <td align="center" style="background-color:#4facfe;padding:15px 30px;border-radius:8px;">
                    <a href="{{.ResetURL}}" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:bold;">Réinitialiser mon mot de passe →</a>
                  </td>
                </tr>
              </table>
              
              <p style="font-size:14px;color:#888888;margin-top:20px;">
                Ce lien expire dans 1 heure.<br>
                Si vous n'avez pas fait cette demande, ignorez cet email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8f9fa;padding:20px;text-align:center;border-top:1px solid #eeeeee;">
              <p style="font-size:12px;color:#999999;margin:0;">
                © 2024 MIAD Market. Tous droits réservés.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

// ---------- Consumer adapter ----------

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

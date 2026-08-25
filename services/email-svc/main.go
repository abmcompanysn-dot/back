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
//
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
	"strings"
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

-- Modèles d'emails éditables depuis le dashboard admin (Marketing >
-- Modèles de messages) — plus figés dans le binaire Go : modifier
-- subject/body_html ici a un effet immédiat, sans redéploiement.
CREATE TABLE IF NOT EXISTS email_templates (
  name       TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body_html  TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
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
	orderURL    string
	authURL     string
	maxAttempts int

	settings *kit.SettingsStore
}

func (s *server) settingsFields() []kit.SettingsField {
	return []kit.SettingsField{
		{Key: "resend_api_key", Ptr: &s.resendAPI, Secret: true, Description: "Clé API du service d'envoi d'emails Resend — vide = mode simulation (email journalisé, jamais envoyé)"},
		{Key: "from_email", Ptr: &s.fromEmail, Description: "Adresse email expéditeur pour tous les emails transactionnels"},
		{Key: "storefront_url", Ptr: &s.frontendURL, Description: "URL du site public, utilisée dans le contenu des emails (liens)"},
	}
}

const settingsTable = "email_settings"

type EmailTemplate struct {
	Name      string `json:"name"`
	Label     string `json:"label"`
	Subject   string `json:"subject"`
	BodyHTML  string `json:"body_html"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

// seedTemplates — valeurs par défaut insérées UNE SEULE FOIS au premier
// démarrage (ON CONFLICT DO NOTHING dans seedEmailTemplates) : ensuite la
// table email_templates est la seule source de vérité, éditable depuis
// le dashboard admin (Marketing > Modèles de messages) sans redéploiement.
var seedTemplates = []EmailTemplate{
	{Name: "welcome", Label: "Bienvenue", Subject: "Bienvenue chez MIAD Market !", BodyHTML: welcomeEmailHTML},
	{Name: "order_confirmation", Label: "Confirmation de commande", Subject: "Confirmation de commande #{{.order_id}}", BodyHTML: orderConfirmationHTML},
	{Name: "payment_confirmed", Label: "Paiement confirmé", Subject: "Paiement confirmé - Commande #{{.order_id}}", BodyHTML: paymentConfirmedHTML},
	{Name: "payment_failed", Label: "Paiement échoué", Subject: "Échec du paiement - Commande #{{.order_id}}", BodyHTML: paymentFailedHTML},
	{Name: "order_shipped", Label: "Commande expédiée", Subject: "Votre commande #{{.order_id}} a été expédiée !", BodyHTML: orderShippedHTML},
	{Name: "otp_email", Label: "Code de vérification (OTP)", Subject: "Votre code de vérification MIAD Market", BodyHTML: otpEmailHTML},
	{Name: "password_reset", Label: "Réinitialisation de mot de passe", Subject: "Réinitialisation de mot de passe", BodyHTML: passwordResetHTML},
	{Name: "rep_message_notification", Label: "Nouveau message représentant", Subject: "💬 Nouveau message de {{.client_name}} — MIAD Market", BodyHTML: repMessageNotificationHTML},
}

// getSettings/putSettings — Configuration Système (page admin).
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
	kit.JSON(w, 200, map[string]any{"ok": true, "updated": len(toSave)})
}

func seedEmailTemplates(ctx context.Context, db *pgxpool.Pool) error {
	for _, t := range seedTemplates {
		_, err := db.Exec(ctx, `
			INSERT INTO email_templates (name, label, subject, body_html)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (name) DO NOTHING`,
			t.Name, t.Label, t.Subject, t.BodyHTML)
		if err != nil {
			return fmt.Errorf("seed template %s: %w", t.Name, err)
		}
	}
	return nil
}

func main() {
	ctx := context.Background()
	log := kit.Logger("email-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_EMAIL", "postgres://miad:miad@postgres:5432/miad_email?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema+kit.SettingsStoreSchema(settingsTable)); err != nil {
		log.Error("migration impossible", "err", err)
		return
	}

	s := &server{
		db:          db,
		resendAPI:   kit.Env("RESEND_API_KEY", ""),
		fromEmail:   kit.Env("FROM_EMAIL", "noreply@miadmarket.ca"),
		frontendURL: kit.Env("STOREFRONT_URL", "https://miadmarket.ca"),
		orderURL:    kit.Env("ORDER_SVC_URL", "http://order-svc:8083"),
		authURL:     kit.Env("AUTH_SVC_URL", "http://auth-svc:8086"),
		maxAttempts: 3,
	}
	s.settings = kit.NewSettingsStore(db, settingsTable, s.settingsFields())
	if err := s.settings.Load(ctx); err != nil {
		log.Error("chargement email_settings impossible", "err", err)
	}
	if s.resendAPI == "" {
		log.Warn("RESEND_API_KEY non définie — mode simulation activé")
	}

	if err := seedEmailTemplates(ctx, db); err != nil {
		log.Error("seed email_templates échoué", "err", err)
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
		mux.HandleFunc("GET /settings", s.getSettings)
		mux.HandleFunc("PUT /settings", s.putSettings)
		mux.HandleFunc("GET /emails/stats", s.stats)
		mux.HandleFunc("POST /emails/send", s.sendEmail)
		mux.HandleFunc("GET /email-templates", s.listTemplates)
		mux.HandleFunc("GET /email-templates/{name}", s.getTemplate)
		mux.HandleFunc("PUT /email-templates/{name}", s.updateTemplate)
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

// resolveOrderContact enrichit un payload d'événement commande/paiement
// (qui ne porte toujours que order_id + customer_id, jamais l'email — ni
// order-svc ni payment-svc ne connaissent l'email du client) en appelant
// order-svc puis auth-svc. Sans ça, customer_email est TOUJOURS absent du
// payload Kafka et les 4 emails commande/paiement ne partent jamais
// (confirmé en lisant order-svc et payment-svc : aucun des deux ne
// publie jamais customer_email).
// emailOrderLine/emailShippingAddress — shape exposé aux templates HTML
// (champs capitalisés pour {{.Items}}/{{.Shipping}} en Go template, alors
// qu'order-svc renvoie du snake_case en JSON — deux vocabulaires distincts
// pour la même donnée, volontairement, comme le reste de ce fichier fait
// déjà pour {{.Items}} dans order_confirmation).
type emailOrderLine struct {
	Name     string
	Quantity int
	Price    string
}

type emailShippingAddress struct {
	FullName string
	Address1 string
	City     string
	Postcode string
	Country  string
	Phone    string
}

func (s *server) resolveOrderContact(ctx context.Context, payload map[string]any) (email string, err error) {
	orderID := fmt.Sprint(payload["order_id"])
	if orderID == "" || orderID == "<nil>" {
		return "", fmt.Errorf("order_id manquant dans le payload")
	}
	var order struct {
		CustomerID int64   `json:"customer_id"`
		TotalUSD   float64 `json:"total_usd"`
		Lines      []struct {
			Name      string  `json:"name"`
			Quantity  int     `json:"quantity"`
			UnitPrice float64 `json:"unit_price_usd"`
		} `json:"lines"`
		ShippingAddress map[string]any `json:"shipping_address"`
	}
	if err := fetchJSON(ctx, s.orderURL+"/orders/"+orderID, &order); err != nil {
		return "", fmt.Errorf("order-svc: %w", err)
	}
	payload["total_usd"] = order.TotalUSD

	// Détails de la commande — utilisés par order_confirmation ET
	// order_shipped (le fondateur a explicitement demandé que l'email
	// d'expédition affiche lui aussi les articles, pas seulement le
	// numéro de suivi).
	items := make([]emailOrderLine, 0, len(order.Lines))
	for _, l := range order.Lines {
		items = append(items, emailOrderLine{
			Name: l.Name, Quantity: l.Quantity,
			Price: fmt.Sprintf("%.2f $", l.UnitPrice),
		})
	}
	payload["Items"] = items

	// Adresse de livraison — jamais transmise avant ce correctif, alors que
	// order-svc l'expose depuis le début (order.shipping_address).
	if order.ShippingAddress != nil {
		addr := emailShippingAddress{
			FullName: strings.TrimSpace(strAt(order.ShippingAddress, "first_name") + " " + strAt(order.ShippingAddress, "last_name")),
			Address1: strAt(order.ShippingAddress, "address_1"),
			City:     strAt(order.ShippingAddress, "city"),
			Postcode: strAt(order.ShippingAddress, "postcode"),
			Country:  strAt(order.ShippingAddress, "country"),
			Phone:    strAt(order.ShippingAddress, "phone"),
		}
		if addr.FullName == "" {
			addr.FullName = strAt(order.ShippingAddress, "full_name")
		}
		payload["Shipping"] = addr
	}

	if order.CustomerID == 0 {
		return "", fmt.Errorf("commande %s sans customer_id", orderID)
	}
	var customer struct {
		Email string `json:"email"`
	}
	if err := fetchJSON(ctx, s.authURL+"/customer/"+fmt.Sprint(order.CustomerID), &customer); err != nil {
		return "", fmt.Errorf("auth-svc: %w", err)
	}
	if customer.Email == "" {
		return "", fmt.Errorf("client %d inscrit par téléphone, sans email", order.CustomerID)
	}
	return customer.Email, nil
}

func strAt(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func fetchJSON(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("statut %d: %s", resp.StatusCode, string(body))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (s *server) queueOrderConfirmation(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, err := s.resolveOrderContact(ctx, payload)
	if err != nil {
		log.Warn("email client introuvable pour confirmation commande", "err", err)
		return
	}
	subject := fmt.Sprintf("Confirmation de commande #%v", payload["order_id"])
	s.queueEmail(ctx, log, email, "order_confirmation", subject, payload)
}

func (s *server) queuePaymentConfirmed(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, err := s.resolveOrderContact(ctx, payload)
	if err != nil {
		log.Warn("email client introuvable pour paiement confirmé", "err", err)
		return
	}
	subject := fmt.Sprintf("Paiement confirmé - Commande #%v", payload["order_id"])
	s.queueEmail(ctx, log, email, "payment_confirmed", subject, payload)
}

func (s *server) queuePaymentFailed(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, err := s.resolveOrderContact(ctx, payload)
	if err != nil {
		log.Warn("email client introuvable pour paiement échoué", "err", err)
		return
	}
	subject := fmt.Sprintf("Échec du paiement - Commande #%v", payload["order_id"])
	s.queueEmail(ctx, log, email, "payment_failed", subject, payload)
}

func (s *server) queueOrderShipped(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, err := s.resolveOrderContact(ctx, payload)
	if err != nil {
		log.Warn("email client introuvable pour commande expédiée", "err", err)
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
	htmlBody, err := s.renderTemplate(ctx, job.template, payload)
	if err != nil {
		s.markEmailFailed(ctx, log, job.id, fmt.Sprintf("template error: %v", err))
		return
	}

	// Le sujet est re-rendu depuis email_templates (pas job.subject, figé
	// à la mise en file) : une modification du modèle dans le dashboard
	// admin s'applique même aux emails déjà en file d'attente.
	subject := job.subject
	if _, tplSubject, err := s.loadTemplate(ctx, job.template); err == nil && tplSubject != "" {
		if rendered, err := renderText(tplSubject, payload); err == nil {
			subject = rendered
		}
	}

	// Envoyer via Resend
	if s.resendAPI == "" {
		// Mode simulation
		log.Info("[SIMULATION] Email envoyé", "to", job.to, "subject", subject, "template", job.template)
		s.markEmailSent(ctx, log, job.id, "simulated")
		return
	}

	resendID, err := s.sendViaResend(job.from, job.to, subject, htmlBody)
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

func (s *server) renderTemplate(ctx context.Context, templateName string, data map[string]any) (string, error) {
	bodyHTML, _, err := s.loadTemplate(ctx, templateName)
	if err != nil {
		return "", err
	}
	if _, ok := data["frontend_url"]; !ok {
		data["frontend_url"] = s.frontendURL
	}

	tmpl, err := template.New(templateName).Parse(bodyHTML)
	if err != nil {
		return "", fmt.Errorf("parse template: %w", err)
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("execute template: %w", err)
	}

	return buf.String(), nil
}

// loadTemplate lit le modèle depuis email_templates (source de vérité,
// éditable depuis le dashboard admin) — renvoie (body_html, subject, err).
func (s *server) loadTemplate(ctx context.Context, name string) (bodyHTML, subject string, err error) {
	row := s.db.QueryRow(ctx, `SELECT body_html, subject FROM email_templates WHERE name = $1`, name)
	if err := row.Scan(&bodyHTML, &subject); err != nil {
		return "", "", fmt.Errorf("template inconnu: %s (%w)", name, err)
	}
	return bodyHTML, subject, nil
}

func renderText(tpl string, data map[string]any) (string, error) {
	t, err := template.New("subject").Parse(tpl)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := t.Execute(&buf, data); err != nil {
		return "", err
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

func (s *server) listTemplates(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `
		SELECT name, label, subject, body_html, updated_at
		FROM email_templates ORDER BY name`)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	out := []EmailTemplate{}
	for rows.Next() {
		var t EmailTemplate
		var updatedAt time.Time
		if err := rows.Scan(&t.Name, &t.Label, &t.Subject, &t.BodyHTML, &updatedAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		t.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
		out = append(out, t)
	}
	kit.JSON(w, 200, map[string]any{"templates": out})
}

func (s *server) getTemplate(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	row := s.db.QueryRow(r.Context(), `
		SELECT name, label, subject, body_html, updated_at
		FROM email_templates WHERE name = $1`, name)
	var t EmailTemplate
	var updatedAt time.Time
	if err := row.Scan(&t.Name, &t.Label, &t.Subject, &t.BodyHTML, &updatedAt); err != nil {
		kit.Fail(w, 404, "template_not_found", fmt.Sprintf("modèle %q introuvable", name))
		return
	}
	t.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	kit.JSON(w, 200, t)
}

// updateTemplate — édite subject/body_html depuis le dashboard admin.
// Valide que le HTML compile comme gabarit Go AVANT d'écrire en base :
// un template cassé enregistré ferait échouer silencieusement tous les
// envois futurs de cet email (voir sendEmailJob → markEmailFailed).
func (s *server) updateTemplate(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var body struct {
		Label    string `json:"label"`
		Subject  string `json:"subject"`
		BodyHTML string `json:"body_html"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Subject == "" || body.BodyHTML == "" {
		kit.Fail(w, 400, "missing_fields", "subject et body_html obligatoires")
		return
	}
	if _, err := template.New("check").Parse(body.Subject); err != nil {
		kit.Fail(w, 400, "invalid_subject_template", err.Error())
		return
	}
	if _, err := template.New("check").Parse(body.BodyHTML); err != nil {
		kit.Fail(w, 400, "invalid_body_template", err.Error())
		return
	}

	tag, err := s.db.Exec(r.Context(), `
		UPDATE email_templates SET label = COALESCE(NULLIF($2, ''), label),
		       subject = $3, body_html = $4, updated_at = now()
		WHERE name = $1`, name, body.Label, body.Subject, body.BodyHTML)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "template_not_found", fmt.Sprintf("modèle %q introuvable", name))
		return
	}
	kit.JSON(w, 200, map[string]string{"status": "updated"})
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

// ---------- Charte graphique MIAD Market ----------
// Header/pied de page communs à tous les templates transactionnels — vert
// de marque #005826, orange CTA #F5A623, logo hébergé sur miadmarket.ca
// (repris de EmailBlast.tsx, le composant d'emailing marketing existant,
// pour que les emails transactionnels et marketing aient la même identité
// visuelle). Les emails HTML n'ont pas de vrai système d'include, donc ce
// bloc est dupliqué dans chaque const *HTML ci-dessous plutôt que composé
// dynamiquement — plus simple à débugger client par client (Gmail/Outlook
// rendent différemment) et cohérent avec le style "un seul gros literal
// HTML par template" déjà en place dans ce fichier.
const miadEmailLogoURL = "https://miadmarket.ca/logo/logo.png"

const welcomeEmailHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bienvenue chez MIAD Market</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f0;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" style="width:560px;max-width:100%;border-collapse:collapse;background-color:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
          <tr>
            <td style="background-color:#005826;padding:20px 28px;text-align:center;">
              <img src="https://miadmarket.ca/logo/logo.png" alt="MIAD Market" style="max-height:40px;">
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px;">
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 16px;">Bienvenue chez MIAD Market !</h1>
              <p style="font-size:15px;color:#333333;margin-bottom:16px;">
                Bonjour {{if .full_name}}{{.full_name}}{{else}}Cher client{{end}},
              </p>
              <p style="font-size:14px;color:#555555;line-height:1.65;margin-bottom:16px;">
                Nous sommes ravis de vous accueillir sur <strong>MIAD Market</strong>, votre nouvelle destination shopping en ligne.
              </p>
              <p style="font-size:14px;color:#555555;line-height:1.65;margin-bottom:24px;">
                Découvrez des milliers de produits à prix imbattables, une livraison rapide et un service client dédié.
              </p>
              <div style="text-align:center;margin:24px 0;">
                <a href="{{.frontend_url}}" style="display:inline-block;background:#F5A623;color:#111111;font-weight:800;padding:12px 28px;border-radius:40px;font-size:0.82rem;text-transform:uppercase;text-decoration:none;">Commencer mes achats</a>
              </div>
              <p style="font-size:13px;color:#888888;margin-top:24px;">
                À très bientôt,<br>
                <strong>L'équipe MIAD Market</strong>
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0 0 4px;"><strong style="color:#ffffff;">MIAD Market</strong> — L'excellence africaine partagée avec le monde.</p>
              <p style="margin:0 0 4px;">Vous recevez cet email car vous avez créé un compte sur miadmarket.ca</p>
              <p style="margin:0;">Ceci est un email automatique, merci de ne pas y répondre.</p>
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
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f0;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" style="width:560px;max-width:100%;border-collapse:collapse;background-color:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
          <tr>
            <td style="background-color:#005826;padding:20px 28px;text-align:center;">
              <img src="https://miadmarket.ca/logo/logo.png" alt="MIAD Market" style="max-height:40px;">
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px;">
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Commande confirmée !</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Merci pour votre commande ! Nous la préparons avec soin.
              </p>

              <table role="presentation" style="width:100%;border-collapse:collapse;margin:20px 0;background-color:#f9fafb;border-radius:8px;overflow:hidden;">
                <tr>
                  <td style="padding:14px 16px;border-bottom:1px solid #e5e7eb;">
                    <strong style="font-size:12px;color:#005826;">Date de commande</strong><br>
                    <span style="color:#555555;font-size:14px;">{{.CreatedAt}}</span>
                  </td>
                  <td style="padding:14px 16px;border-bottom:1px solid #e5e7eb;">
                    <strong style="font-size:12px;color:#005826;">Statut</strong><br>
                    <span style="color:#005826;font-weight:bold;font-size:14px;">Confirmée</span>
                  </td>
                </tr>
                {{if .total_usd}}
                <tr>
                  <td colspan="2" style="padding:14px 16px;">
                    <strong style="font-size:12px;color:#005826;">Montant total</strong><br>
                    <span style="color:#005826;font-size:20px;font-weight:bold;">{{.total_usd}} $ US</span>
                  </td>
                </tr>
                {{end}}
              </table>

              {{if .Items}}
              <h3 style="color:#005826;font-size:14px;margin:28px 0 12px;">Articles commandés :</h3>
              <table role="presentation" style="width:100%;border-collapse:collapse;">
                {{range .Items}}
                <tr>
                  <td style="padding:10px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#333333;">{{.Name}}</td>
                  <td align="right" style="padding:10px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#555555;">{{.Quantity}} x {{.Price}}</td>
                </tr>
                {{end}}
              </table>
              {{end}}

              <p style="font-size:13px;color:#888888;margin-top:28px;">
                Vous recevrez un email lorsque votre commande sera expédiée.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0 0 4px;"><strong style="color:#ffffff;">MIAD Market</strong> — L'excellence africaine partagée avec le monde.</p>
              <p style="margin:0;">Ceci est un email automatique, merci de ne pas y répondre.</p>
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
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f0;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" style="width:560px;max-width:100%;border-collapse:collapse;background-color:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
          <tr>
            <td style="background-color:#005826;padding:20px 28px;text-align:center;">
              <img src="https://miadmarket.ca/logo/logo.png" alt="MIAD Market" style="max-height:40px;">
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px;">
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Paiement confirmé !</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Votre paiement a été traité avec succès.
              </p>

              <table role="presentation" style="width:100%;border-collapse:collapse;margin:20px 0;">
                <tr>
                  <td style="padding:18px;background-color:#f0f9f0;border-radius:8px;text-align:center;">
                    <span style="font-size:24px;color:#005826;font-weight:bold;">{{.total_usd}} $ US</span>
                  </td>
                </tr>
              </table>

              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Votre commande est maintenant en préparation.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0 0 4px;"><strong style="color:#ffffff;">MIAD Market</strong> — L'excellence africaine partagée avec le monde.</p>
              <p style="margin:0;">Ceci est un email automatique, merci de ne pas y répondre.</p>
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
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f0;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" style="width:560px;max-width:100%;border-collapse:collapse;background-color:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
          <tr>
            <td style="background-color:#005826;padding:20px 28px;text-align:center;">
              <img src="https://miadmarket.ca/logo/logo.png" alt="MIAD Market" style="max-height:40px;">
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px;">
              <h1 style="color:#c0392b;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Échec du paiement</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Le paiement de votre commande n'a pas abouti.
              </p>

              <div style="background-color:#fdf2f2;border-left:4px solid #c0392b;padding:16px 20px;border-radius:6px;margin:20px 0;">
                <p style="margin:0;color:#7d241a;font-size:14px;">
                  <strong>Raison :</strong> {{if .error_reason}}{{.error_reason}}{{else}}Problème de traitement{{end}}
                </p>
              </div>

              <div style="text-align:center;margin:28px 0;">
                <a href="{{.frontend_url}}/orders/{{.order_id}}/pay" style="display:inline-block;background:#F5A623;color:#111111;font-weight:800;padding:12px 28px;border-radius:40px;font-size:0.82rem;text-transform:uppercase;text-decoration:none;">Réessayer le paiement</a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0 0 4px;"><strong style="color:#ffffff;">MIAD Market</strong> — L'excellence africaine partagée avec le monde.</p>
              <p style="margin:0;">Ceci est un email automatique, merci de ne pas y répondre.</p>
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
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f0;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" style="width:560px;max-width:100%;border-collapse:collapse;background-color:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
          <tr>
            <td style="background-color:#005826;padding:20px 28px;text-align:center;">
              <img src="https://miadmarket.ca/logo/logo.png" alt="MIAD Market" style="max-height:40px;">
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px;">
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Commande expédiée !</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Bonne nouvelle ! Votre commande est en route.
              </p>

              {{if .TrackingNumber}}
              <div style="background-color:#f0f9f0;padding:16px 20px;border-radius:8px;margin:20px 0;">
                <p style="margin:0;color:#005826;font-size:14px;">
                  <strong>Numéro de suivi :</strong> {{.TrackingNumber}}
                </p>
              </div>
              {{end}}

              {{if .Carrier}}
              <p style="font-size:13px;color:#666666;margin-bottom:20px;">
                Transporteur : <strong>{{.Carrier}}</strong>
              </p>
              {{end}}

              {{if .Items}}
              <h3 style="color:#005826;font-size:14px;margin:24px 0 12px;">Articles expédiés :</h3>
              <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:8px;">
                {{range .Items}}
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#333333;">{{.Name}}</td>
                  <td align="right" style="padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#555555;">{{.Quantity}} x {{.Price}}</td>
                </tr>
                {{end}}
              </table>
              {{end}}

              {{if .Shipping}}
              <h3 style="color:#005826;font-size:14px;margin:24px 0 12px;">Adresse de livraison :</h3>
              <div style="background-color:#f9fafb;border-radius:8px;padding:16px 20px;font-size:14px;color:#333333;line-height:1.6;">
                {{if .Shipping.FullName}}<strong>{{.Shipping.FullName}}</strong><br>{{end}}
                {{if .Shipping.Address1}}{{.Shipping.Address1}}<br>{{end}}
                {{if .Shipping.City}}{{.Shipping.City}}{{end}}{{if .Shipping.Postcode}} {{.Shipping.Postcode}}{{end}}<br>
                {{if .Shipping.Country}}{{.Shipping.Country}}<br>{{end}}
                {{if .Shipping.Phone}}Tél. {{.Shipping.Phone}}{{end}}
              </div>
              {{end}}

              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Livraison estimée : {{if .EstimatedDelivery}}{{.EstimatedDelivery}}{{else}}2-5 jours ouvrés{{end}}
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0 0 4px;"><strong style="color:#ffffff;">MIAD Market</strong> — L'excellence africaine partagée avec le monde.</p>
              <p style="margin:0;">Ceci est un email automatique, merci de ne pas y répondre.</p>
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
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f0;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" style="width:560px;max-width:100%;border-collapse:collapse;background-color:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
          <tr>
            <td style="background-color:#005826;padding:20px 28px;text-align:center;">
              <img src="https://miadmarket.ca/logo/logo.png" alt="MIAD Market" style="max-height:40px;">
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px;text-align:center;">
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 20px;">Votre code de vérification</h1>
              <p style="font-size:14px;color:#333333;margin-bottom:24px;">
                Voici votre code de vérification MIAD Market :
              </p>

              <div style="background-color:#f0f9f0;padding:24px;border-radius:8px;margin:20px 0;display:inline-block;">
                <span style="font-size:34px;font-weight:bold;color:#005826;letter-spacing:8px;">{{.Code}}</span>
              </div>

              <p style="font-size:13px;color:#888888;margin-top:20px;">
                Ce code expire dans {{.TTLMinutes}} minutes.<br>
                Ne le partagez avec personne.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0 0 4px;"><strong style="color:#ffffff;">MIAD Market</strong> — L'excellence africaine partagée avec le monde.</p>
              <p style="margin:0;">Ceci est un email automatique, merci de ne pas y répondre.</p>
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
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f0;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" style="width:560px;max-width:100%;border-collapse:collapse;background-color:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
          <tr>
            <td style="background-color:#005826;padding:20px 28px;text-align:center;">
              <img src="https://miadmarket.ca/logo/logo.png" alt="MIAD Market" style="max-height:40px;">
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px;">
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 20px;">Réinitialisation de mot de passe</h1>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Vous avez demandé à réinitialiser votre mot de passe.
              </p>

              <div style="text-align:center;margin:28px 0;">
                <a href="{{.reset_url}}" style="display:inline-block;background:#F5A623;color:#111111;font-weight:800;padding:12px 28px;border-radius:40px;font-size:0.82rem;text-transform:uppercase;text-decoration:none;">Réinitialiser mon mot de passe</a>
              </div>

              <p style="font-size:13px;color:#888888;margin-top:20px;">
                Ce lien expire dans 1 heure.<br>
                Si vous n'avez pas fait cette demande, ignorez cet email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0 0 4px;"><strong style="color:#ffffff;">MIAD Market</strong> — L'excellence africaine partagée avec le monde.</p>
              <p style="margin:0;">Ceci est un email automatique, merci de ne pas y répondre.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

// repMessageNotificationHTML — notifie un représentant qu'un client lui a
// écrit (formulaire de contact public, voir app/api/messages/route.ts côté
// frontend). Portage direct du HTML précédemment envoyé en dur depuis
// Next.js vers wp-json/miad/v1/send-email — même mise en page, désormais un
// vrai modèle éditable depuis le dashboard admin comme les autres.
const repMessageNotificationHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nouveau message client</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f0;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" style="width:560px;max-width:100%;border-collapse:collapse;background-color:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
          <tr>
            <td style="background-color:#005826;padding:20px 28px;text-align:center;">
              <img src="https://miadmarket.ca/logo/logo.png" alt="MIAD Market" style="max-height:40px;">
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px;">
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 20px;">Nouveau message client</h1>
              <p style="margin:0 0 16px;font-size:14px;color:#333333;">Bonjour <strong>{{.rep_name}}</strong>,</p>
              <p style="margin:0 0 20px;font-size:14px;color:#374151;">
                <strong>{{.client_name}}</strong>{{if .client_email}} ({{.client_email}}){{end}} vous a envoyé un message :
              </p>
              <div style="background:#f9fafb;border:1px solid #e5e7eb;border-left:4px solid #005826;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
                <p style="margin:0;font-size:14px;color:#1f2937;line-height:1.6;">"{{.message}}"</p>
              </div>
              <div style="text-align:center;margin:24px 0;">
                <a href="{{.dashboard_url}}" style="display:inline-block;background:#F5A623;color:#111111;font-weight:800;padding:12px 28px;border-radius:40px;font-size:0.82rem;text-transform:uppercase;text-decoration:none;">Répondre maintenant</a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0;"><strong style="color:#ffffff;">MIAD Market</strong> — L'excellence africaine partagée avec le monde.</p>
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

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
	"strconv"
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
	"vendor.registered",
	"payout_request.created",
	"payout_request.approved",
	"payout_request.rejected",
	"review.created",
	"product.status_changed",
	"return.created",
	"return.status_changed",
	"vendor.suspension_changed",
	"customer.address_updated",
}

type server struct {
	db          *pgxpool.Pool
	resendAPI   string
	fromEmail   string
	frontendURL string
	orderURL    string
	authURL     string
	vendorURL   string
	catalogURL  string
	maxAttempts int
	notifyEmail string

	// internalAPISecret — même secret partagé que le frontend Next.js
	// (INTERNAL_API_SECRET). auth-svc/GET /customer/{id} exige soit un JWT
	// admin, soit ce header (voir auth-svc/getCustomer) : sans lui, TOUTE
	// résolution d'email client échoue en 403 et aucun email commande ne
	// part jamais (confirmé en prod le 2026-08-26 — répété sur 100% des
	// commandes dans les logs email-svc).
	internalAPISecret string

	settings *kit.SettingsStore
}

func (s *server) settingsFields() []kit.SettingsField {
	return []kit.SettingsField{
		{Key: "resend_api_key", Ptr: &s.resendAPI, Secret: true, Description: "Clé API du service d'envoi d'emails Resend — vide = mode simulation (email journalisé, jamais envoyé)"},
		{Key: "from_email", Ptr: &s.fromEmail, Description: "Adresse email expéditeur pour tous les emails transactionnels"},
		{Key: "storefront_url", Ptr: &s.frontendURL, Description: "URL du site public, utilisée dans le contenu des emails (liens)"},
		{Key: "notify_email", Ptr: &s.notifyEmail, Description: "Adresse email de l'équipe MIAD — reçoit les notifications internes (nouveau vendeur, retrait demandé, etc.), équivalent de l'admin email WooCommerce"},
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
	{Name: "order_completed", Label: "Commande livrée", Subject: "Votre commande #{{.order_id}} est arrivée !", BodyHTML: orderCompletedHTML},
	{Name: "order_cancelled", Label: "Commande annulée", Subject: "Commande #{{.order_id}} annulée", BodyHTML: orderCancelledHTML},
	{Name: "order_failed", Label: "Commande échouée (paiement)", Subject: "Problème avec votre commande #{{.order_id}}", BodyHTML: orderFailedHTML},
	{Name: "order_pending", Label: "Commande en attente de paiement", Subject: "Commande #{{.order_id}} en attente de paiement", BodyHTML: orderPendingHTML},
	{Name: "order_refunded", Label: "Commande remboursée", Subject: "Commande #{{.order_id}} remboursée", BodyHTML: orderRefundedHTML},
	{Name: "otp_email", Label: "Code de vérification (OTP)", Subject: "Votre code de vérification MIAD Market", BodyHTML: otpEmailHTML},
	{Name: "password_reset", Label: "Réinitialisation de mot de passe", Subject: "Réinitialisation de mot de passe", BodyHTML: passwordResetHTML},
	{Name: "rep_message_notification", Label: "Nouveau message représentant", Subject: "💬 Nouveau message de {{.client_name}} — MIAD Market", BodyHTML: repMessageNotificationHTML},
	{Name: "new_vendor_registered", Label: "Nouveau vendeur inscrit (interne)", Subject: "Nouveau vendeur inscrit — {{.name}}", BodyHTML: newVendorRegisteredHTML},
	{Name: "new_withdrawal_request", Label: "Nouvelle demande de retrait (interne)", Subject: "Nouvelle demande de retrait — #{{.payout_id}}", BodyHTML: newWithdrawalRequestHTML},
	{Name: "withdrawal_approved", Label: "Retrait approuvé", Subject: "Votre retrait #{{.payout_id}} a été approuvé", BodyHTML: withdrawalApprovedHTML},
	{Name: "withdrawal_rejected", Label: "Retrait rejeté", Subject: "Votre retrait #{{.payout_id}} a été rejeté", BodyHTML: withdrawalRejectedHTML},
	{Name: "new_product_review", Label: "Nouvel avis produit (vendeur)", Subject: "Nouvel avis sur {{.product_name}}", BodyHTML: newProductReviewHTML},
	{Name: "product_approved", Label: "Produit approuvé", Subject: "Votre produit {{.product_name}} a été publié", BodyHTML: productApprovedHTML},
	{Name: "product_rejected", Label: "Produit rejeté", Subject: "Votre produit {{.product_name}} n'a pas été approuvé", BodyHTML: productRejectedHTML},
	{Name: "new_refund_request", Label: "Nouvelle demande de remboursement (interne)", Subject: "Nouvelle demande de remboursement — commande #{{.order_id}}", BodyHTML: newRefundRequestHTML},
	{Name: "refund_processed", Label: "Remboursement accepté", Subject: "Remboursement accepté — commande #{{.order_id}}", BodyHTML: refundProcessedHTML},
	{Name: "refund_canceled", Label: "Remboursement refusé", Subject: "Demande de remboursement refusée — commande #{{.order_id}}", BodyHTML: refundCanceledHTML},
	{Name: "vendor_contact_message", Label: "Message client → vendeur", Subject: "Nouveau message de {{.client_name}}", BodyHTML: vendorContactMessageHTML},
	{Name: "vendor_new_order", Label: "Nouvelle commande (vendeur)", Subject: "Nouvelle commande #{{.order_id}}", BodyHTML: vendorNewOrderHTML},
	{Name: "admin_new_order", Label: "Nouvelle commande (admin)", Subject: "Nouvelle commande #{{.order_id}}", BodyHTML: adminNewOrderHTML},
	{Name: "rep_new_order", Label: "Nouvelle commande (représentant)", Subject: "Nouvelle commande #{{.order_id}} — {{.rep_zone}}", BodyHTML: repNewOrderHTML},
	{Name: "vendor_completed_order", Label: "Commande livrée (vendeur)", Subject: "Commande #{{.order_id}} livrée", BodyHTML: vendorCompletedOrderHTML},
	{Name: "vendor_disabled", Label: "Boutique suspendue", Subject: "Votre boutique a été suspendue", BodyHTML: vendorDisabledHTML},
	{Name: "vendor_enabled", Label: "Boutique réactivée", Subject: "Votre boutique a été réactivée", BodyHTML: vendorEnabledHTML},
	{Name: "address_updated", Label: "Adresse modifiée", Subject: "Votre adresse a été mise à jour", BodyHTML: addressUpdatedHTML},
	{Name: "broadcast", Label: "Message diffusé (admin)", Subject: "Message MIAD Market", BodyHTML: broadcastHTML},
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
		vendorURL:   kit.Env("VENDOR_SVC_URL", "http://vendor-svc:8082"),
		catalogURL:  kit.Env("CATALOG_SVC_URL", "http://catalog-svc:8081"),
		maxAttempts: 3,
		notifyEmail: kit.Env("NOTIFY_EMAIL", "miadmarket25@gmail.com"),

		internalAPISecret: kit.Env("INTERNAL_API_SECRET", ""),
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
		mux.HandleFunc("POST /emails/broadcast", s.broadcastEmail)
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
		// Le client n'est PLUS notifié ici (2026-08-27) : order.created est
		// publié une fois PAR SOUS-COMMANDE VENDEUR (pas pour le groupe),
		// donc un panier multi-boutique envoyait un email par boutique, et
		// ce avant même que le paiement soit confirmé. La confirmation
		// client se fait désormais uniquement sur payment.confirmed
		// (queuePaymentConfirmed, ci-dessous), publié une seule fois par
		// commande groupée (order_id = parent_order_id depuis "paiement
		// unique par commande groupée"). Vendeur et admin restent notifiés
		// ici : ils doivent être prévenus tôt, avant paiement, pour préparer.
		s.queueVendorNewOrder(ctx, log, payload)
		s.queueAdminNewOrder(ctx, log, payload)
	case "payment.confirmed":
		s.queuePaymentConfirmed(ctx, log, payload)
	case "payment.failed":
		s.queuePaymentFailed(ctx, log, payload)
	case "vendor.registered":
		s.queueNewVendorRegistered(ctx, log, payload)
	case "payout_request.created":
		s.queueNewWithdrawalRequest(ctx, log, payload)
	case "payout_request.approved":
		s.queueWithdrawalApproved(ctx, log, payload)
	case "payout_request.rejected":
		s.queueWithdrawalRejected(ctx, log, payload)
	case "review.created":
		s.queueNewProductReview(ctx, log, payload)
	case "product.status_changed":
		status, _ := payload["status"].(string)
		switch status {
		case "active":
			s.queueProductApproved(ctx, log, payload)
		case "rejected":
			s.queueProductRejected(ctx, log, payload)
		}
	case "return.created":
		s.queueNewRefundRequest(ctx, log, payload)
	case "return.status_changed":
		status, _ := payload["status"].(string)
		switch status {
		case "accepted":
			s.queueRefundProcessed(ctx, log, payload)
		case "rejected":
			s.queueRefundCanceled(ctx, log, payload)
		}
	case "customer.address_updated":
		s.queueAddressUpdated(ctx, log, payload)
	case "vendor.suspension_changed":
		suspended, _ := payload["suspended"].(bool)
		if suspended {
			s.queueVendorDisabled(ctx, log, payload)
		} else {
			s.queueVendorEnabled(ctx, log, payload)
		}
	case "order.status_changed":
		status, _ := payload["status"].(string)
		switch status {
		case "shipped":
			s.queueOrderShipped(ctx, log, payload)
		case "delivered":
			s.queueOrderCompleted(ctx, log, payload)
			s.queueVendorCompletedOrder(ctx, log, payload)
		case "cancelled":
			s.queueOrderCancelled(ctx, log, payload)
		case "payment_expired":
			s.queueOrderFailed(ctx, log, payload)
		case "pending_payment":
			s.queueOrderPending(ctx, log, payload)
		case "refunded":
			s.queueOrderRefunded(ctx, log, payload)
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
	Image    string
}

type emailShippingAddress struct {
	FullName string
	Address1 string
	City     string
	Postcode string
	Country  string
	Phone    string
}

// orderLine — shape interne commun, alimenté soit par GET /orders/{id}
// (sous-commande, un vendeur), soit par GET /orders/parent/{id} (commande
// groupée, formats JSON différents — voir plus bas).
type orderLine struct {
	ProductID int64
	Name      string
	Quantity  int
	UnitPrice float64
}

func (s *server) resolveOrderContact(ctx context.Context, payload map[string]any) (email string, err error) {
	orderID := fmt.Sprint(payload["order_id"])
	if orderID == "" || orderID == "<nil>" {
		return "", fmt.Errorf("order_id manquant dans le payload")
	}
	var customerID int64
	var totalUSD float64
	var lines []orderLine
	var shippingAddress map[string]any

	// payment.confirmed/payment.failed portent désormais le PARENT_ORDER_ID
	// (paiement unique par commande groupée depuis le 2026-08-26, voir
	// payment-svc) — un parent a status='group', customer_id correct mais
	// lines=[] (les vrais articles sont dans les sous-commandes). Sans ce
	// double chemin, l'email de confirmation de paiement partait bien au
	// bon client mais sans AUCUN article/image (lines toujours vide sur un
	// parent) — c'est justement ce que le fondateur a signalé le
	// 2026-08-27. order.created/order.status_changed continuent de porter
	// un id de sous-commande (order-svc publie ces events par vendeur),
	// donc GET /orders/{id} reste le bon chemin pour eux.
	// Détection parent vs sous-commande : /orders/{id} interroge la table
	// orders PAR SON id — un parent_order_id n'y a jamais de ligne propre
	// (c'est une vue agrégée construite à la volée par /orders/parent/{id},
	// voir order-svc), donc /orders/{id} y répondait TOUJOURS 404 pour un
	// vrai parent, et isParent restait donc TOUJOURS false. resolveOrderContact
	// retombait alors sur la branche sous-commande, qui refaisait le même
	// appel /orders/{id} et échouait à nouveau — payment.confirmed (qui
	// porte le parent_order_id depuis "paiement unique par commande
	// groupée") ne trouvait alors jamais le client, et aucun email de
	// confirmation ne partait jamais (confirmé le 2026-08-28 : "email client
	// introuvable pour paiement confirmé... commande 361 introuvable").
	// On tente maintenant /orders/parent/{id} EN PREMIER : son succès est
	// la vraie preuve qu'il s'agit d'un parent.
	var parentProbe struct {
		LineItems []struct {
			ProductID int64  `json:"product_id"`
			Name      string `json:"name"`
			Quantity  int    `json:"quantity"`
			Price     string `json:"price"`
		} `json:"line_items"`
		Total string `json:"total"`
	}
	isParent := fetchJSON(ctx, s.orderURL+"/orders/parent/"+orderID, &parentProbe) == nil

	if isParent {
		parent := parentProbe
		if t, err := strconv.ParseFloat(parent.Total, 64); err == nil {
			totalUSD = t
		}
		for _, l := range parent.LineItems {
			price, _ := strconv.ParseFloat(l.Price, 64)
			lines = append(lines, orderLine{ProductID: l.ProductID, Name: l.Name, Quantity: l.Quantity, UnitPrice: price})
		}
		// Le parent (status='group') porte le bon customer_id malgré des
		// lines vides — pas besoin d'un appel supplémentaire pour ça.
		var parentOrder struct {
			CustomerID      int64          `json:"customer_id"`
			ShippingAddress map[string]any `json:"shipping_address"`
		}
		if err := fetchJSON(ctx, s.orderURL+"/orders/"+orderID, &parentOrder); err == nil {
			customerID = parentOrder.CustomerID
			shippingAddress = parentOrder.ShippingAddress
		}
	} else {
		var order struct {
			CustomerID int64   `json:"customer_id"`
			TotalUSD   float64 `json:"total_usd"`
			Lines      []struct {
				ProductID int64   `json:"product_id"`
				Name      string  `json:"name"`
				Quantity  int     `json:"quantity"`
				UnitPrice float64 `json:"unit_price_usd"`
			} `json:"lines"`
			ShippingAddress map[string]any `json:"shipping_address"`
		}
		if err := fetchJSON(ctx, s.orderURL+"/orders/"+orderID, &order); err != nil {
			return "", fmt.Errorf("order-svc: %w", err)
		}
		customerID = order.CustomerID
		totalUSD = order.TotalUSD
		shippingAddress = order.ShippingAddress
		for _, l := range order.Lines {
			lines = append(lines, orderLine{ProductID: l.ProductID, Name: l.Name, Quantity: l.Quantity, UnitPrice: l.UnitPrice})
		}
	}
	payload["total_usd"] = totalUSD

	// Images produits — un seul appel batch à catalog-svc (GET
	// /products?include=id1,id2,...) plutôt qu'un appel par ligne. Best
	// effort : un produit introuvable/supprimé ne doit jamais faire
	// échouer l'email, juste laisser Image vide pour cette ligne.
	images := s.fetchProductImages(ctx, lines)

	// Détails de la commande — utilisés par order_confirmation ET
	// order_shipped (le fondateur a explicitement demandé que l'email
	// d'expédition affiche lui aussi les articles, pas seulement le
	// numéro de suivi).
	items := make([]emailOrderLine, 0, len(lines))
	for _, l := range lines {
		items = append(items, emailOrderLine{
			Name: l.Name, Quantity: l.Quantity,
			Price: fmt.Sprintf("%.2f $", l.UnitPrice),
			Image: images[l.ProductID],
		})
	}
	payload["Items"] = items

	// Adresse de livraison — jamais transmise avant ce correctif, alors que
	// order-svc l'expose depuis le début (order.shipping_address).
	if shippingAddress != nil {
		addr := emailShippingAddress{
			FullName: strings.TrimSpace(strAt(shippingAddress, "first_name") + " " + strAt(shippingAddress, "last_name")),
			Address1: strAt(shippingAddress, "address_1"),
			City:     strAt(shippingAddress, "city"),
			Postcode: strAt(shippingAddress, "postcode"),
			Country:  strAt(shippingAddress, "country"),
			Phone:    strAt(shippingAddress, "phone"),
		}
		if addr.FullName == "" {
			addr.FullName = strAt(shippingAddress, "full_name")
		}
		payload["Shipping"] = addr
	}

	if customerID == 0 {
		return "", fmt.Errorf("commande %s sans customer_id", orderID)
	}
	var customer struct {
		Email string `json:"email"`
	}
	// GET /customer/{id} exige un rôle admin OU X-Internal-Secret (voir
	// auth-svc/getCustomer) — sans ce header, 403 systématique et aucun
	// email commande ne part jamais (bug réel en prod, pas un cas limite).
	headers := map[string]string{}
	if s.internalAPISecret != "" {
		headers["X-Internal-Secret"] = s.internalAPISecret
	}
	if err := fetchJSONWithHeaders(ctx, s.authURL+"/customer/"+fmt.Sprint(customerID), headers, &customer); err != nil {
		return "", fmt.Errorf("auth-svc: %w", err)
	}
	if customer.Email == "" {
		return "", fmt.Errorf("client %d inscrit par téléphone, sans email", customerID)
	}
	return customer.Email, nil
}

// fetchProductImages — résout l'image de chaque produit acheté en UN seul
// appel batch à catalog-svc (GET /products?include=id1,id2,...), pas un
// appel par ligne. Best effort : renvoie une map partielle (voire vide) si
// catalog-svc est injoignable ou qu'un produit a été supprimé depuis —
// l'email doit toujours partir, avec ou sans images.
func (s *server) fetchProductImages(ctx context.Context, lines []orderLine) map[int64]string {
	images := map[int64]string{}
	ids := make([]string, 0, len(lines))
	for _, l := range lines {
		if l.ProductID > 0 {
			ids = append(ids, strconv.FormatInt(l.ProductID, 10))
		}
	}
	if len(ids) == 0 {
		return images
	}
	var resp struct {
		Items []struct {
			ID    int64  `json:"id"`
			Image string `json:"image"`
		} `json:"items"`
	}
	if err := fetchJSON(ctx, s.catalogURL+"/products?include="+strings.Join(ids, ","), &resp); err != nil {
		return images // best effort — email part quand même sans images
	}
	for _, p := range resp.Items {
		images[p.ID] = p.Image
	}
	return images
}

// resolveVendorEmail — même besoin que resolveOrderContact côté client :
// payout_request.* ne porte que vendor_id, jamais l'email (payment-svc ne
// le connaît pas). Un seul appel GET /vendors/{id} suffit (pas de detour
// order-svc comme pour les commandes).
func (s *server) resolveVendorEmail(ctx context.Context, vendorID int64) (string, error) {
	var vendor struct {
		Email string `json:"email"`
		Name  string `json:"name"`
	}
	if err := fetchJSON(ctx, fmt.Sprintf("%s/vendors/%d", s.vendorURL, vendorID), &vendor); err != nil {
		return "", fmt.Errorf("vendor-svc: %w", err)
	}
	if vendor.Email == "" {
		return "", fmt.Errorf("vendeur %d sans email", vendorID)
	}
	return vendor.Email, nil
}

func strAt(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func fetchJSON(ctx context.Context, url string, out any) error {
	return fetchJSONWithHeaders(ctx, url, nil, out)
}

// fetchJSONWithHeaders — variante de fetchJSON acceptant des en-têtes
// supplémentaires, utilisée pour X-Internal-Secret vers auth-svc (voir
// resolveOrderContact) : certains endpoints internes exigent une preuve
// que l'appelant est bien un service backend, pas un tiers qui devinerait
// un ID (même mécanisme que updateCustomerAddress côté frontend Next.js).
func fetchJSONWithHeaders(ctx context.Context, url string, headers map[string]string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
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

func (s *server) queueOrderCompleted(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, err := s.resolveOrderContact(ctx, payload)
	if err != nil {
		log.Warn("email client introuvable pour commande terminée", "err", err)
		return
	}
	subject := fmt.Sprintf("Votre commande #%v est arrivée !", payload["order_id"])
	s.queueEmail(ctx, log, email, "order_completed", subject, payload)
}

func (s *server) queueOrderCancelled(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, err := s.resolveOrderContact(ctx, payload)
	if err != nil {
		log.Warn("email client introuvable pour commande annulée", "err", err)
		return
	}
	subject := fmt.Sprintf("Commande #%v annulée", payload["order_id"])
	s.queueEmail(ctx, log, email, "order_cancelled", subject, payload)
}

func (s *server) queueOrderFailed(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, err := s.resolveOrderContact(ctx, payload)
	if err != nil {
		log.Warn("email client introuvable pour commande échouée", "err", err)
		return
	}
	subject := fmt.Sprintf("Problème avec votre commande #%v", payload["order_id"])
	s.queueEmail(ctx, log, email, "order_failed", subject, payload)
}

func (s *server) queueOrderPending(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, err := s.resolveOrderContact(ctx, payload)
	if err != nil {
		log.Warn("email client introuvable pour commande en attente", "err", err)
		return
	}
	subject := fmt.Sprintf("Commande #%v en attente de paiement", payload["order_id"])
	s.queueEmail(ctx, log, email, "order_pending", subject, payload)
}

func (s *server) queueOrderRefunded(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, err := s.resolveOrderContact(ctx, payload)
	if err != nil {
		log.Warn("email client introuvable pour commande remboursée", "err", err)
		return
	}
	subject := fmt.Sprintf("Commande #%v remboursée", payload["order_id"])
	s.queueEmail(ctx, log, email, "order_refunded", subject, payload)
}

// queueNewVendorRegistered — notification interne (équipe MIAD, pas le
// vendeur) : équivalent de "New Seller Registered" côté WooCommerce/Dokan.
func (s *server) queueNewVendorRegistered(ctx context.Context, log *slog.Logger, payload map[string]any) {
	if s.notifyEmail == "" {
		log.Warn("notify_email non configuré — email nouveau vendeur ignoré")
		return
	}
	name, _ := payload["name"].(string)
	subject := fmt.Sprintf("Nouveau vendeur inscrit — %s", name)
	s.queueEmail(ctx, log, s.notifyEmail, "new_vendor_registered", subject, payload)
}

// queueNewWithdrawalRequest — notification interne (équipe MIAD) : équivalent
// de "New Withdrawal Request" côté WooCommerce/Dokan.
func (s *server) queueNewWithdrawalRequest(ctx context.Context, log *slog.Logger, payload map[string]any) {
	if s.notifyEmail == "" {
		log.Warn("notify_email non configuré — email nouvelle demande de retrait ignoré")
		return
	}
	subject := fmt.Sprintf("Nouvelle demande de retrait — #%v", payload["payout_id"])
	s.queueEmail(ctx, log, s.notifyEmail, "new_withdrawal_request", subject, payload)
}

func (s *server) queueWithdrawalApproved(ctx context.Context, log *slog.Logger, payload map[string]any) {
	vendorID, _ := payload["vendor_id"].(float64)
	email, err := s.resolveVendorEmail(ctx, int64(vendorID))
	if err != nil {
		log.Warn("email vendeur introuvable pour retrait approuvé", "err", err)
		return
	}
	subject := fmt.Sprintf("Votre retrait #%v a été approuvé", payload["payout_id"])
	s.queueEmail(ctx, log, email, "withdrawal_approved", subject, payload)
}

func (s *server) queueWithdrawalRejected(ctx context.Context, log *slog.Logger, payload map[string]any) {
	vendorID, _ := payload["vendor_id"].(float64)
	email, err := s.resolveVendorEmail(ctx, int64(vendorID))
	if err != nil {
		log.Warn("email vendeur introuvable pour retrait rejeté", "err", err)
		return
	}
	subject := fmt.Sprintf("Votre retrait #%v a été rejeté", payload["payout_id"])
	s.queueEmail(ctx, log, email, "withdrawal_rejected", subject, payload)
}

// queueNewProductReview — équivalent de "Vendor Product Review" côté
// WooCommerce/Dokan : notifie le vendeur qu'un client a laissé un avis.
func (s *server) queueNewProductReview(ctx context.Context, log *slog.Logger, payload map[string]any) {
	vendorID, _ := payload["vendor_id"].(float64)
	email, err := s.resolveVendorEmail(ctx, int64(vendorID))
	if err != nil {
		log.Warn("email vendeur introuvable pour nouvel avis", "err", err)
		return
	}
	subject := fmt.Sprintf("Nouvel avis sur %v", payload["product_name"])
	s.queueEmail(ctx, log, email, "new_product_review", subject, payload)
}

// queueProductApproved/queueProductRejected — équivalent de "New Pending
// Product" / "Pending Product Published" / "Product Rejected" côté
// WooCommerce/Dokan.
func (s *server) queueProductApproved(ctx context.Context, log *slog.Logger, payload map[string]any) {
	vendorID, _ := payload["vendor_id"].(float64)
	email, err := s.resolveVendorEmail(ctx, int64(vendorID))
	if err != nil {
		log.Warn("email vendeur introuvable pour produit approuvé", "err", err)
		return
	}
	subject := fmt.Sprintf("Votre produit %v a été publié", payload["product_name"])
	s.queueEmail(ctx, log, email, "product_approved", subject, payload)
}

func (s *server) queueProductRejected(ctx context.Context, log *slog.Logger, payload map[string]any) {
	vendorID, _ := payload["vendor_id"].(float64)
	email, err := s.resolveVendorEmail(ctx, int64(vendorID))
	if err != nil {
		log.Warn("email vendeur introuvable pour produit rejeté", "err", err)
		return
	}
	subject := fmt.Sprintf("Votre produit %v n'a pas été approuvé", payload["product_name"])
	s.queueEmail(ctx, log, email, "product_rejected", subject, payload)
}

// queueNewRefundRequest — notification interne (équipe MIAD) : équivalent
// de "New Refund Request" côté WooCommerce/Dokan.
func (s *server) queueNewRefundRequest(ctx context.Context, log *slog.Logger, payload map[string]any) {
	if s.notifyEmail == "" {
		log.Warn("notify_email non configuré — email nouvelle demande de remboursement ignoré")
		return
	}
	subject := fmt.Sprintf("Nouvelle demande de remboursement — commande #%v", payload["order_id"])
	s.queueEmail(ctx, log, s.notifyEmail, "new_refund_request", subject, payload)
}

// queueRefundProcessed/queueRefundCanceled — notifient le CLIENT (résultat
// de sa demande) — équivalent de "Refund Processed"/"Refund Canceled".
func (s *server) queueRefundProcessed(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, err := s.resolveOrderContact(ctx, payload)
	if err != nil {
		log.Warn("email client introuvable pour remboursement traité", "err", err)
		return
	}
	subject := fmt.Sprintf("Remboursement accepté — commande #%v", payload["order_id"])
	s.queueEmail(ctx, log, email, "refund_processed", subject, payload)
}

func (s *server) queueRefundCanceled(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, err := s.resolveOrderContact(ctx, payload)
	if err != nil {
		log.Warn("email client introuvable pour remboursement refusé", "err", err)
		return
	}
	subject := fmt.Sprintf("Demande de remboursement refusée — commande #%v", payload["order_id"])
	s.queueEmail(ctx, log, email, "refund_canceled", subject, payload)
}

// queueVendorNewOrder/queueVendorCompletedOrder — notifient le VENDEUR (pas
// le client) — équivalent de "Vendor New Order"/"Vendor Completed Order"
// côté WooCommerce/Dokan. resolveOrderContact enrichit le payload (Items,
// total_usd) mais renvoie l'email du CLIENT — on l'ignore ici, seul
// l'enrichissement du payload nous intéresse.
func (s *server) queueVendorNewOrder(ctx context.Context, log *slog.Logger, payload map[string]any) {
	vendorID, _ := payload["vendor_id"].(float64)
	if vendorID == 0 {
		return
	}
	if _, err := s.resolveOrderContact(ctx, payload); err != nil {
		log.Warn("enrichissement commande impossible pour notif vendeur", "err", err)
	}
	email, err := s.resolveVendorEmail(ctx, int64(vendorID))
	if err != nil {
		log.Warn("email vendeur introuvable pour nouvelle commande", "err", err)
		return
	}
	subject := fmt.Sprintf("Nouvelle commande #%v", payload["order_id"])
	s.queueEmail(ctx, log, email, "vendor_new_order", subject, payload)
}

// queueAdminNewOrder — un email par admin actif (SELECT email FROM admins,
// décision actée : pas de rôle "super admin" distinct aujourd'hui, donc
// tous les admins reçoivent la même notification). Résolution via
// auth-svc/GET /internal/admin-emails, protégé par X-Internal-Secret
// (aucun JWT admin disponible ici — c'est un consumer Kafka pur).
func (s *server) queueAdminNewOrder(ctx context.Context, log *slog.Logger, payload map[string]any) {
	if _, err := s.resolveOrderContact(ctx, payload); err != nil {
		log.Warn("enrichissement commande impossible pour notif admin", "err", err)
	}
	headers := map[string]string{}
	if s.internalAPISecret != "" {
		headers["X-Internal-Secret"] = s.internalAPISecret
	}
	var resp struct {
		Items []struct {
			Email string `json:"email"`
		} `json:"items"`
	}
	if err := fetchJSONWithHeaders(ctx, s.authURL+"/internal/admin-emails", headers, &resp); err != nil {
		log.Warn("liste admins introuvable pour notif nouvelle commande", "err", err)
		return
	}
	subject := fmt.Sprintf("Nouvelle commande #%v", payload["order_id"])
	for _, a := range resp.Items {
		if a.Email == "" {
			continue
		}
		s.queueEmail(ctx, log, a.Email, "admin_new_order", subject, payload)
	}
}

func (s *server) queueVendorCompletedOrder(ctx context.Context, log *slog.Logger, payload map[string]any) {
	vendorID, _ := payload["vendor_id"].(float64)
	if vendorID == 0 {
		return
	}
	email, err := s.resolveVendorEmail(ctx, int64(vendorID))
	if err != nil {
		log.Warn("email vendeur introuvable pour commande livrée", "err", err)
		return
	}
	subject := fmt.Sprintf("Commande #%v livrée", payload["order_id"])
	s.queueEmail(ctx, log, email, "vendor_completed_order", subject, payload)
}

// queueVendorDisabled/queueVendorEnabled — équivalent de "Vendor Disable"/
// "Vendor Enable" côté Dokan (suspended_until posé/levé par un admin).
func (s *server) queueVendorDisabled(ctx context.Context, log *slog.Logger, payload map[string]any) {
	vendorID, _ := payload["vendor_id"].(float64)
	email, err := s.resolveVendorEmail(ctx, int64(vendorID))
	if err != nil {
		log.Warn("email vendeur introuvable pour désactivation", "err", err)
		return
	}
	s.queueEmail(ctx, log, email, "vendor_disabled", "Votre boutique a été suspendue", payload)
}

func (s *server) queueVendorEnabled(ctx context.Context, log *slog.Logger, payload map[string]any) {
	vendorID, _ := payload["vendor_id"].(float64)
	email, err := s.resolveVendorEmail(ctx, int64(vendorID))
	if err != nil {
		log.Warn("email vendeur introuvable pour réactivation", "err", err)
		return
	}
	s.queueEmail(ctx, log, email, "vendor_enabled", "Votre boutique a été réactivée", payload)
}

// queueAddressUpdated — confirmation quand le client modifie son adresse
// de facturation/livraison depuis son dashboard (demandé le 2026-08-26).
// L'email lui-même est déjà dans le payload (fourni par auth-svc), pas
// besoin de resolveOrderContact ici.
func (s *server) queueAddressUpdated(ctx context.Context, log *slog.Logger, payload map[string]any) {
	email, _ := payload["email"].(string)
	if email == "" {
		log.Warn("email manquant pour confirmation adresse modifiée")
		return
	}
	addrType, _ := payload["type"].(string)
	label := "de facturation"
	if addrType == "shipping" {
		label = "de livraison"
	}
	s.queueEmail(ctx, log, email, "address_updated", "Votre adresse "+label+" a été mise à jour", payload)
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

// broadcastEmail — POST /emails/broadcast {audience, subject, body}, calqué
// sur notification-svc.pushBroadcast (même forme de réponse sent/failed/
// total). "body" est du texte brut saisi par l'admin (pas de HTML libre à
// faire confiance) : échappé puis converti en <br> pour les retours à la
// ligne, jamais interprété comme balisage — voir template "broadcast"
// (BodyHTML: broadcastHTML) qui l'insère via {{.body_html}} en tant que
// template.HTML (donc SANS ré-échappement, sûr uniquement parce que le
// texte a déjà été échappé ici avant la conversion en <br>).
func (s *server) broadcastEmail(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Audience string `json:"audience"` // "vendors" | "admins" | "customers"
		Subject  string `json:"subject"`
		Body     string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Subject == "" || body.Body == "" {
		kit.Fail(w, 400, "missing_fields", "subject et body obligatoires")
		return
	}
	recipients, err := s.resolveBroadcastAudience(r.Context(), body.Audience)
	if err != nil {
		kit.Fail(w, 400, "invalid_audience", err.Error())
		return
	}
	if len(recipients) == 0 {
		kit.Fail(w, 404, "no_recipients", "aucun destinataire trouvé pour cette audience")
		return
	}

	bodyHTML := template.HTML(strings.ReplaceAll(template.HTMLEscapeString(body.Body), "\n", "<br>"))
	payload := map[string]any{"subject": body.Subject, "body_html": bodyHTML}

	log := kit.Logger("email-svc")
	sent, failed := 0, 0
	for _, to := range recipients {
		if to == "" {
			continue
		}
		if _, err := s.db.Exec(r.Context(), `
			INSERT INTO emails (to_addr, from_addr, subject, template, payload, status)
			VALUES ($1, $2, $3, 'broadcast', $4, 'queued')`,
			to, s.fromEmail, body.Subject, mustMarshal(payload)); err != nil {
			log.Error("broadcast: échec mise en file", "to", to, "err", err)
			failed++
			continue
		}
		sent++
	}
	kit.JSON(w, 200, map[string]any{"sent": sent, "failed": failed, "total": len(recipients)})
}

// resolveBroadcastAudience — réutilise les listes déjà exposées par les
// autres services (aucune nouvelle route de lecture) : vendor-svc/GET
// /vendors (paginé, itéré entièrement), auth-svc/GET /internal/admin-emails
// (déjà créé pour queueAdminNewOrder), auth-svc/GET /customers (paginé,
// protégé par X-Internal-Secret comme le reste des appels internes).
func (s *server) resolveBroadcastAudience(ctx context.Context, audience string) ([]string, error) {
	switch audience {
	case "admins":
		headers := map[string]string{}
		if s.internalAPISecret != "" {
			headers["X-Internal-Secret"] = s.internalAPISecret
		}
		var resp struct {
			Items []struct {
				Email string `json:"email"`
			} `json:"items"`
		}
		if err := fetchJSONWithHeaders(ctx, s.authURL+"/internal/admin-emails", headers, &resp); err != nil {
			return nil, err
		}
		emails := make([]string, 0, len(resp.Items))
		for _, a := range resp.Items {
			emails = append(emails, a.Email)
		}
		return emails, nil

	case "vendors":
		emails := []string{}
		page := 1
		for {
			var resp struct {
				Items []struct {
					Email string `json:"email"`
				} `json:"items"`
				HasMore bool `json:"has_more"`
			}
			url := fmt.Sprintf("%s/vendors?page=%d&page_size=100", s.vendorURL, page)
			if err := fetchJSON(ctx, url, &resp); err != nil {
				return nil, err
			}
			for _, v := range resp.Items {
				if v.Email != "" {
					emails = append(emails, v.Email)
				}
			}
			if !resp.HasMore || len(resp.Items) == 0 {
				break
			}
			page++
		}
		return emails, nil

	case "customers":
		emails := []string{}
		page := 1
		headers := map[string]string{}
		if s.internalAPISecret != "" {
			headers["X-Internal-Secret"] = s.internalAPISecret
		}
		for {
			var resp struct {
				Items []struct {
					Email string `json:"email"`
				} `json:"items"`
				HasMore bool `json:"has_more"`
			}
			url := fmt.Sprintf("%s/internal/customer-emails?page=%d&page_size=100", s.authURL, page)
			if err := fetchJSONWithHeaders(ctx, url, headers, &resp); err != nil {
				return nil, err
			}
			for _, c := range resp.Items {
				if c.Email != "" {
					emails = append(emails, c.Email)
				}
			}
			if !resp.HasMore || len(resp.Items) == 0 {
				break
			}
			page++
		}
		return emails, nil

	default:
		return nil, fmt.Errorf("audience %q inconnue — attendu: vendors, admins, customers", audience)
	}
}

func mustMarshal(v any) []byte {
	b, _ := json.Marshal(v)
	return b
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
                  <td style="padding:10px 0;border-bottom:1px solid #eeeeee;width:52px;">
                    {{if .Image}}<img src="{{.Image}}" alt="{{.Name}}" width="44" height="44" style="width:44px;height:44px;border-radius:6px;object-fit:cover;display:block;">{{end}}
                  </td>
                  <td style="padding:10px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#333333;">{{.Name}}</td>
                  <td align="right" style="padding:10px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#555555;">{{.Quantity}} x {{.Price}}</td>
                </tr>
                {{end}}
              </table>
              {{end}}

              {{if .Shipping}}
              <h3 style="color:#005826;font-size:14px;margin:28px 0 12px;">Adresse de livraison :</h3>
              <table role="presentation" style="width:100%;border-collapse:collapse;background-color:#f9fafb;border-radius:8px;">
                <tr>
                  <td style="padding:14px 16px;font-size:14px;color:#333333;line-height:1.5;">
                    {{.Shipping.FullName}}<br>
                    {{.Shipping.Address1}}<br>
                    {{.Shipping.City}}{{if .Shipping.Postcode}} {{.Shipping.Postcode}}{{end}}, {{.Shipping.Country}}<br>
                    {{if .Shipping.Phone}}{{.Shipping.Phone}}{{end}}
                  </td>
                </tr>
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
                Votre paiement a été traité avec succès. Nous préparons votre commande.
              </p>

              <table role="presentation" style="width:100%;border-collapse:collapse;margin:20px 0;">
                <tr>
                  <td style="padding:18px;background-color:#f0f9f0;border-radius:8px;text-align:center;">
                    <span style="font-size:24px;color:#005826;font-weight:bold;">{{.total_usd}} $ US</span>
                  </td>
                </tr>
              </table>

              {{if .Items}}
              <h3 style="color:#005826;font-size:14px;margin:28px 0 12px;">Articles commandés :</h3>
              <table role="presentation" style="width:100%;border-collapse:collapse;">
                {{range .Items}}
                <tr>
                  <td style="padding:10px 0;border-bottom:1px solid #eeeeee;width:52px;">
                    {{if .Image}}<img src="{{.Image}}" alt="{{.Name}}" width="44" height="44" style="width:44px;height:44px;border-radius:6px;object-fit:cover;display:block;">{{end}}
                  </td>
                  <td style="padding:10px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#333333;">{{.Name}}</td>
                  <td align="right" style="padding:10px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#555555;">{{.Quantity}} x {{.Price}}</td>
                </tr>
                {{end}}
              </table>
              {{end}}

              {{if .Shipping}}
              <h3 style="color:#005826;font-size:14px;margin:28px 0 12px;">Adresse de livraison :</h3>
              <table role="presentation" style="width:100%;border-collapse:collapse;background-color:#f9fafb;border-radius:8px;">
                <tr>
                  <td style="padding:14px 16px;font-size:14px;color:#333333;line-height:1.5;">
                    {{.Shipping.FullName}}<br>
                    {{.Shipping.Address1}}<br>
                    {{.Shipping.City}}{{if .Shipping.Postcode}} {{.Shipping.Postcode}}{{end}}, {{.Shipping.Country}}<br>
                    {{if .Shipping.Phone}}{{.Shipping.Phone}}{{end}}
                  </td>
                </tr>
              </table>
              {{end}}

              <p style="font-size:13px;color:#888888;margin-top:24px;">
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

const orderCompletedHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commande livrée</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Commande livrée !</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Votre commande est arrivée. Merci d'avoir choisi MIAD Market !
              </p>

              {{if .Items}}
              <h3 style="color:#005826;font-size:14px;margin:24px 0 12px;">Articles livrés :</h3>
              <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:8px;">
                {{range .Items}}
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#333333;">{{.Name}}</td>
                  <td align="right" style="padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#555555;">{{.Quantity}} x {{.Price}}</td>
                </tr>
                {{end}}
              </table>
              {{end}}

              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Une question sur votre commande ? Contactez-nous, on est là pour vous.
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

const orderCancelledHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commande annulée</title>
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
              <h1 style="color:#c0392b;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Commande annulée</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Votre commande a été annulée. Si vous n'êtes pas à l'origine de cette annulation, contactez-nous.
              </p>

              {{if .Items}}
              <h3 style="color:#005826;font-size:14px;margin:24px 0 12px;">Articles concernés :</h3>
              <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:8px;">
                {{range .Items}}
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#333333;">{{.Name}}</td>
                  <td align="right" style="padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#555555;">{{.Quantity}} x {{.Price}}</td>
                </tr>
                {{end}}
              </table>
              {{end}}

              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Si un paiement avait déjà été effectué, il sera remboursé selon nos délais habituels.
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

const orderFailedHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Problème avec votre commande</title>
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
              <h1 style="color:#c0392b;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Le paiement n'a pas abouti</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Nous n'avons pas pu confirmer le paiement de votre commande dans le délai imparti. Elle n'a pas été traitée.
              </p>

              {{if .Items}}
              <h3 style="color:#005826;font-size:14px;margin:24px 0 12px;">Articles concernés :</h3>
              <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:8px;">
                {{range .Items}}
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#333333;">{{.Name}}</td>
                  <td align="right" style="padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#555555;">{{.Quantity}} x {{.Price}}</td>
                </tr>
                {{end}}
              </table>
              {{end}}

              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Vous pouvez repasser commande à tout moment depuis le site.
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

const orderPendingHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commande en attente de paiement</title>
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
              <h1 style="color:#F5A623;font-size:1.3rem;font-weight:800;margin:0 0 6px;">En attente de paiement</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Votre commande a bien été enregistrée et attend la confirmation du paiement.
              </p>

              {{if .Items}}
              <h3 style="color:#005826;font-size:14px;margin:24px 0 12px;">Articles :</h3>
              <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:8px;">
                {{range .Items}}
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#333333;">{{.Name}}</td>
                  <td align="right" style="padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#555555;">{{.Quantity}} x {{.Price}}</td>
                </tr>
                {{end}}
              </table>
              {{end}}

              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Dès le paiement confirmé, vous recevrez un email de confirmation.
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

const orderRefundedHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commande remboursée</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Commande remboursée</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Le remboursement de votre commande a été traité. Le délai de réception dépend de votre méthode de paiement.
              </p>

              {{if .Items}}
              <h3 style="color:#005826;font-size:14px;margin:24px 0 12px;">Articles concernés :</h3>
              <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:8px;">
                {{range .Items}}
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#333333;">{{.Name}}</td>
                  <td align="right" style="padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#555555;">{{.Quantity}} x {{.Price}}</td>
                </tr>
                {{end}}
              </table>
              {{end}}

              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Une question sur ce remboursement ? Contactez-nous, on est là pour vous.
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

const newVendorRegisteredHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nouveau vendeur inscrit</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Nouveau vendeur inscrit</h1>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Un nouveau vendeur vient de s'inscrire sur MIAD Market.
              </p>
              <div style="background-color:#f9fafb;border-radius:8px;padding:16px 20px;font-size:14px;color:#333333;line-height:1.8;">
                <strong>Boutique :</strong> {{.name}}<br>
                {{if .email}}<strong>Email :</strong> {{.email}}<br>{{end}}
                <strong>ID vendeur :</strong> #{{.vendor_id}}
              </div>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0;"><strong style="color:#ffffff;">MIAD Market</strong> — Notification interne.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const newWithdrawalRequestHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nouvelle demande de retrait</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Nouvelle demande de retrait</h1>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Un vendeur a demandé un retrait de solde.
              </p>
              <div style="background-color:#f9fafb;border-radius:8px;padding:16px 20px;font-size:14px;color:#333333;line-height:1.8;">
                <strong>Demande :</strong> #{{.payout_id}}<br>
                <strong>Vendeur :</strong> #{{.vendor_id}}<br>
                <strong>Montant :</strong> {{.amount_usd}} $
              </div>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0;"><strong style="color:#ffffff;">MIAD Market</strong> — Notification interne.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const withdrawalApprovedHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Retrait approuvé</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Retrait approuvé !</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Demande #{{.payout_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Votre demande de retrait de <strong>{{.amount_usd}} $</strong> a été approuvée et traitée.
              </p>
              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Le délai de réception dépend de votre mode de retrait.
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

const withdrawalRejectedHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Retrait rejeté</title>
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
              <h1 style="color:#c0392b;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Retrait rejeté</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Demande #{{.payout_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Votre demande de retrait de <strong>{{.amount_usd}} $</strong> n'a pas pu être traitée.
              </p>
              {{if .admin_note}}
              <div style="background-color:#fdf2f2;border-radius:8px;padding:16px 20px;margin:20px 0;">
                <p style="margin:0;color:#c0392b;font-size:14px;"><strong>Motif :</strong> {{.admin_note}}</p>
              </div>
              {{end}}
              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Contactez-nous si vous avez des questions sur cette décision.
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

const newProductReviewHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nouvel avis produit</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Nouvel avis reçu !</h1>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Un client a laissé un avis sur <strong>{{.product_name}}</strong>.
              </p>
              <div style="background-color:#f9fafb;border-radius:8px;padding:16px 20px;font-size:14px;color:#333333;">
                <p style="margin:0 0 8px;">
                  <strong>Note :</strong> {{.rating}}/5 ⭐
                </p>
                {{if .comment}}<p style="margin:0;font-style:italic;">"{{.comment}}"</p>{{end}}
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

const productApprovedHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Produit approuvé</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Produit publié !</h1>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Votre produit <strong>{{.product_name}}</strong> a été approuvé et est maintenant visible sur MIAD Market.
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

const productRejectedHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Produit rejeté</title>
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
              <h1 style="color:#c0392b;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Produit non approuvé</h1>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Votre produit <strong>{{.product_name}}</strong> n'a pas été approuvé pour publication.
              </p>
              {{if .reason}}
              <div style="background-color:#fdf2f2;border-radius:8px;padding:16px 20px;margin:20px 0;">
                <p style="margin:0;color:#c0392b;font-size:14px;"><strong>Motif :</strong> {{.reason}}</p>
              </div>
              {{end}}
              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Corrigez les points signalés et contactez-nous pour une nouvelle soumission.
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

const newRefundRequestHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nouvelle demande de remboursement</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Nouvelle demande de remboursement</h1>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Un client a demandé un remboursement sur la commande #{{.order_id}}.
              </p>
              <div style="background-color:#f9fafb;border-radius:8px;padding:16px 20px;font-size:14px;color:#333333;line-height:1.8;">
                <strong>Motif :</strong> {{.reason}}<br>
                <strong>Vendeur :</strong> #{{.vendor_id}}
              </div>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0;"><strong style="color:#ffffff;">MIAD Market</strong> — Notification interne.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const refundProcessedHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Remboursement accepté</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Remboursement accepté</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Votre demande de remboursement a été acceptée. Le montant vous sera reversé selon les délais habituels de votre méthode de paiement.
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

const refundCanceledHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Demande de remboursement refusée</title>
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
              <h1 style="color:#c0392b;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Demande refusée</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Votre demande de remboursement n'a pas été acceptée.
              </p>
              {{if .admin_note}}
              <div style="background-color:#fdf2f2;border-radius:8px;padding:16px 20px;margin:20px 0;">
                <p style="margin:0;color:#c0392b;font-size:14px;"><strong>Motif :</strong> {{.admin_note}}</p>
              </div>
              {{end}}
              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Contactez-nous si vous avez des questions sur cette décision.
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

const vendorContactMessageHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nouveau message</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Nouveau message pour {{.vendor_name}}</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">
                De {{.client_name}}{{if .client_email}} ({{.client_email}}){{end}}
              </p>
              <div style="background-color:#f9fafb;border-radius:8px;padding:16px 20px;font-size:14px;color:#333333;white-space:pre-wrap;">{{.message}}</div>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0;"><strong style="color:#ffffff;">MIAD Market</strong> — Répondez directement à ce client par email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const vendorNewOrderHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nouvelle commande</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Nouvelle commande !</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Vous avez reçu une nouvelle commande. Préparez-la dès que possible.
              </p>
              {{if .total_usd}}
              <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:16px;background-color:#f9fafb;border-radius:8px;">
                <tr>
                  <td style="padding:14px 16px;">
                    <strong style="font-size:12px;color:#005826;">Montant total</strong><br>
                    <span style="color:#005826;font-size:20px;font-weight:bold;">{{.total_usd}} $ US</span>
                  </td>
                </tr>
              </table>
              {{end}}
              {{if .Items}}
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
              <h3 style="color:#005826;font-size:14px;margin:20px 0 12px;">Adresse de livraison :</h3>
              <table role="presentation" style="width:100%;border-collapse:collapse;background-color:#f9fafb;border-radius:8px;">
                <tr>
                  <td style="padding:14px 16px;font-size:14px;color:#333333;line-height:1.5;">
                    {{.Shipping.FullName}}<br>
                    {{.Shipping.Address1}}<br>
                    {{.Shipping.City}}{{if .Shipping.Postcode}} {{.Shipping.Postcode}}{{end}}, {{.Shipping.Country}}<br>
                    {{if .Shipping.Phone}}{{.Shipping.Phone}}{{end}}
                  </td>
                </tr>
              </table>
              {{end}}
              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Gérez cette commande depuis votre tableau de bord vendeur.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0;"><strong style="color:#ffffff;">MIAD Market</strong> — Notification vendeur.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const adminNewOrderHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nouvelle commande</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">📦 Nouvelle commande</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}} — client #{{.customer_id}} — boutique #{{.vendor_id}}</p>
              {{if .total_usd}}
              <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:16px;background-color:#f9fafb;border-radius:8px;">
                <tr>
                  <td style="padding:14px 16px;">
                    <strong style="font-size:12px;color:#005826;">Montant total</strong><br>
                    <span style="color:#005826;font-size:20px;font-weight:bold;">{{.total_usd}} $ US</span>
                  </td>
                </tr>
              </table>
              {{end}}
              {{if .Items}}
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
              <h3 style="color:#005826;font-size:14px;margin:20px 0 12px;">Adresse de livraison :</h3>
              <table role="presentation" style="width:100%;border-collapse:collapse;background-color:#f9fafb;border-radius:8px;">
                <tr>
                  <td style="padding:14px 16px;font-size:14px;color:#333333;line-height:1.5;">
                    {{.Shipping.FullName}}<br>
                    {{.Shipping.Address1}}<br>
                    {{.Shipping.City}}{{if .Shipping.Postcode}} {{.Shipping.Postcode}}{{end}}, {{.Shipping.Country}}<br>
                    {{if .Shipping.Phone}}{{.Shipping.Phone}}{{end}}
                  </td>
                </tr>
              </table>
              {{end}}
              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Vue d'ensemble — gérez cette commande depuis le tableau de bord admin.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0;"><strong style="color:#ffffff;">MIAD Market</strong> — Notification admin.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const repNewOrderHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nouvelle commande</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">🔔 Nouvelle commande — {{.rep_zone}}</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}} — {{.vendor_name}}</p>
              {{if .total_usd}}
              <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:16px;background-color:#f9fafb;border-radius:8px;">
                <tr>
                  <td style="padding:14px 16px;">
                    <strong style="font-size:12px;color:#005826;">Montant total</strong><br>
                    <span style="color:#005826;font-size:20px;font-weight:bold;">{{.total_usd}} $ US</span>
                  </td>
                </tr>
              </table>
              {{end}}
              {{if .customer_name}}
              <p style="font-size:14px;color:#333333;margin:0 0 12px;"><strong>Client :</strong> {{.customer_name}}</p>
              {{end}}
              {{if .shipping_summary}}
              <p style="font-size:14px;color:#333333;margin:0 0 20px;"><strong>Adresse :</strong> {{.shipping_summary}}</p>
              {{end}}
              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Gérez cette commande depuis votre tableau de bord représentant.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0;"><strong style="color:#ffffff;">MIAD Market</strong> — Notification représentant.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const vendorCompletedOrderHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commande livrée</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Commande livrée</h1>
              <p style="color:#888888;font-size:13px;margin:0 0 20px;">Commande #{{.order_id}}</p>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Votre commande a été marquée comme livrée. Le paiement correspondant sera crédité sur votre solde.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0;"><strong style="color:#ffffff;">MIAD Market</strong> — Notification vendeur.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const vendorDisabledHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Boutique suspendue</title>
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
              <h1 style="color:#c0392b;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Boutique suspendue</h1>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Votre boutique a été temporairement suspendue sur MIAD Market.
              </p>
              {{if .message}}
              <div style="background-color:#fdf2f2;border-radius:8px;padding:16px 20px;margin:20px 0;">
                <p style="margin:0;color:#c0392b;font-size:14px;">{{.message}}</p>
              </div>
              {{end}}
              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Contactez-nous si vous avez des questions.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0;"><strong style="color:#ffffff;">MIAD Market</strong> — Notification vendeur.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const vendorEnabledHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Boutique réactivée</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Boutique réactivée !</h1>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Bonne nouvelle : votre boutique est de nouveau active sur MIAD Market.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#005826;color:rgba(255,255,255,0.75);padding:20px 28px;text-align:center;font-size:0.7rem;border-top:3px solid #F5A623;">
              <p style="margin:0;"><strong style="color:#ffffff;">MIAD Market</strong> — Notification vendeur.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

// broadcastHTML — {{.body_html}} est du HTML de confiance (déjà échappé/
// mis en forme côté broadcastEmail avant d'être inséré ici, voir
// nl2brEscaped), passé comme template.HTML pour ne pas être ré-échappé par
// html/template — jamais de contenu utilisateur brut non filtré ailleurs
// dans ce fichier ne suit ce chemin, uniquement ce template dédié.
const broadcastHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MIAD Market</title>
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
            <td style="padding:32px 28px;font-size:14px;color:#333333;line-height:1.6;">
              {{.body_html}}
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

const addressUpdatedHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Adresse mise à jour</title>
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
              <h1 style="color:#005826;font-size:1.3rem;font-weight:800;margin:0 0 6px;">Adresse mise à jour</h1>
              <p style="font-size:14px;color:#333333;margin-bottom:20px;">
                Votre adresse {{if eq .type "shipping"}}de livraison{{else}}de facturation{{end}} a été modifiée avec succès.
              </p>
              {{if .address}}
              <div style="background-color:#f9fafb;border-radius:8px;padding:16px 20px;font-size:14px;color:#333333;line-height:1.8;">
                {{if .address.first_name}}{{.address.first_name}} {{.address.last_name}}<br>{{end}}
                {{if .address.address_1}}{{.address.address_1}}<br>{{end}}
                {{if .address.city}}{{.address.city}}{{end}}{{if .address.postcode}} {{.address.postcode}}{{end}}<br>
                {{if .address.country}}{{.address.country}}{{end}}
              </div>
              {{end}}
              <p style="font-size:13px;color:#888888;margin-top:24px;">
                Si vous n'êtes pas à l'origine de cette modification, contactez-nous immédiatement.
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

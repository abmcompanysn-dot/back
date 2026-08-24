// ============================================================
// payment-svc — Stripe (carte, PaymentIntent + Elements EMBARQUÉ,
// PAS de redirection Checkout — le frontend affiche son propre
// formulaire de carte) + PayDunya (Wave, Orange Money, redirection).
// Consomme order.created → pré-crée le paiement PayDunya (asynchrone,
// redirection de toute façon). Pour Stripe : POST /payments/init est
// SYNCHRONE et crée le PaymentIntent à la demande — le frontend en a
// besoin immédiatement pour afficher Stripe Elements, il ne peut pas
// attendre un aller-retour Kafka.
// Publie payment.confirmed / payment.failed.
// payments.order_id : référence logique, jamais de FK SQL.
// ============================================================
package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/IBM/sarama"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/miadmarket/miad-backend/internal/kit"
)

const schema = `
CREATE TABLE IF NOT EXISTS payments (
  id           BIGSERIAL PRIMARY KEY,
  order_id     BIGINT NOT NULL,
  provider     TEXT NOT NULL CHECK (provider IN ('stripe','paydunya')),
  provider_ref TEXT DEFAULT '',
  client_secret TEXT DEFAULT '', -- Stripe PaymentIntent uniquement (Elements embarqué) ; jamais rempli pour PayDunya
  redirect_url TEXT DEFAULT '',
  amount_usd   DOUBLE PRECISION NOT NULL DEFAULT 0, -- USD réel (voir catalog-svc) ; converti en XOF uniquement à l'appel PayDunya
  currency     TEXT NOT NULL DEFAULT 'USD',
  status       TEXT NOT NULL DEFAULT 'initiated',
  method       TEXT DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments (provider_ref);
`

type server struct {
	db          *pgxpool.Pool
	producer    sarama.SyncProducer
	orderURL    string
	shippingURL string // source des exchange-rates pour la conversion PayDunya (USD -> XOF)
}

func main() {
	ctx := context.Background()
	log := kit.Logger("payment-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_PAYMENT", "postgres://miad:miad@postgres:5432/miad_payment?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema); err != nil {
		log.Error("migration impossible", "err", err)
		return
	}

	s := &server{
		db:          db,
		producer:    kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		orderURL:    kit.Env("ORDER_SVC_URL", "http://order-svc:8083"),
		shippingURL: kit.Env("SHIPPING_SVC_URL", "http://shipping-svc:8085"),
	}

	go s.consumeOrders(log)

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	health.Add("stripe_key", func(ctx context.Context) error {
		if kit.Env("STRIPE_SECRET_KEY", "") == "" {
			return fmt.Errorf("STRIPE_SECRET_KEY absente — paiements carte inopérants")
		}
		return nil
	})
	health.Add("paydunya_keys", func(ctx context.Context) error {
		if kit.Env("PAYDUNYA_API_KEY_PRIVATE", "") == "" {
			return fmt.Errorf("clé PayDunya absente — paiements mobiles inopérants")
		}
		return nil
	})

	kit.Run("payment-svc", kit.Env("PORT_PAYMENT", "8084"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("POST /payments/init", s.initPayment)
		mux.HandleFunc("GET /payments", s.listPayments)
		mux.HandleFunc("GET /payments/order/{order_id}", s.getPayment)
		mux.HandleFunc("GET /payment-methods", s.listPaymentMethods)
		mux.HandleFunc("POST /payments/webhook/stripe", s.stripeWebhook)
		mux.HandleFunc("POST /payments/webhook/paydunya", s.paydunyaCallback)
	})
}

// listPaymentMethods — liste statique dérivée de la présence des clés
// d'env déjà lues au démarrage (voir health-checks stripe_key/paydunya_keys
// ci-dessus) : pas de table, pas de persistance, juste un reflet de ce qui
// est réellement configuré. Format proche WooCommerce (wc/v3/payment_gateways)
// pour compatibilité frontend (gateway id/title/enabled).
func (s *server) listPaymentMethods(w http.ResponseWriter, r *http.Request) {
	gateways := []map[string]any{
		{
			"id": "stripe", "title": "Carte bancaire", "method_title": "Stripe",
			"enabled": kit.Env("STRIPE_SECRET_KEY", "") != "",
		},
		{
			"id": "paydunya", "title": "Mobile Money / PayDunya", "method_title": "PayDunya",
			"enabled": kit.Env("PAYDUNYA_API_KEY_PRIVATE", "") != "",
		},
	}
	kit.JSON(w, 200, map[string]any{"gateways": gateways})
}

/* ---------- Consommation order.created ---------- */

type orderCreatedEvent struct {
	OrderID       int64   `json:"order_id"`
	Reference     string  `json:"reference"`
	TotalUSD      float64 `json:"total_usd"`
	PaymentMethod string  `json:"payment_method"`
}

func (s *server) consumeOrders(log *slog.Logger) {
	brokers := kit.Env("KAFKA_BROKERS", "kafka:9092")
	if brokers == "" {
		log.Warn("KAFKA_BROKERS vide — consommation désactivée (mode dev)")
		return
	}
	cfg := sarama.NewConfig()
	cfg.Consumer.Offsets.Initial = sarama.OffsetOldest
	cfg.Version = sarama.V2_8_0_0
	for {
		group, err := sarama.NewConsumerGroup([]string{brokers}, "payment-svc", cfg)
		if err != nil {
			log.Error("kafka injoignable — retry 5 s", "err", err)
			time.Sleep(5 * time.Second)
			continue
		}
		log.Info("consommateur Kafka connecté", "topics", "order.created")
		handler := consumerFunc(func(ctx context.Context, msg *sarama.ConsumerMessage) {
			if msg.Topic != "order.created" {
				return
			}
			var ev orderCreatedEvent
			if err := json.Unmarshal(msg.Value, &ev); err != nil {
				log.Error("événement illisible", "err", err)
				return
			}
			s.initiateFor(ctx, log, ev)
		})
		_ = group.Consume(context.Background(), []string{"order.created"}, handler)
		group.Close()
	}
}

// initiateFor — pré-crée le paiement dès order.created (Kafka), ET la
// session chez le fournisseur pour PayDunya (redirection, pas besoin
// d'un aller-retour synchrone). Pour Stripe, la ligne "initiated" est
// posée ici mais le PaymentIntent réel est créé au premier appel de
// POST /payments/init (voir initPayment) : le frontend en a besoin
// immédiatement pour Stripe Elements, il ne peut pas attendre que ce
// consommateur Kafka ait tourné. Les deux chemins convergent sur la
// même ligne "payments" (idempotent via ON CONFLICT).
func (s *server) initiateFor(ctx context.Context, log *slog.Logger, ev orderCreatedEvent) {
	provider := ev.PaymentMethod
	if provider == "" {
		provider = "stripe"
	}
	var id int64
	err := s.db.QueryRow(ctx, `
		INSERT INTO payments (order_id, provider, amount_usd, status)
		VALUES ($1, $2, $3, 'initiated')
		ON CONFLICT DO NOTHING RETURNING id`, ev.OrderID, provider, ev.TotalUSD).Scan(&id)
	if err != nil {
		log.Warn("paiement déjà initié", "order_id", ev.OrderID)
		return
	}
	if provider != "paydunya" {
		return // Stripe : PaymentIntent créé à la demande via POST /payments/init
	}

	ref, redirect, err := s.createPayDunyaInvoice(ctx, ev)
	if err != nil {
		// EXPLICITE : le paiement est marqué failed, l'événement part sur Kafka.
		_, _ = s.db.Exec(ctx, "UPDATE payments SET status='failed' WHERE id=$1", id)
		kit.Publish(s.producer, "payment.failed", fmt.Sprint(ev.OrderID), map[string]any{
			"order_id": ev.OrderID, "provider": provider, "reason": err.Error(),
			"at": time.Now().UTC().Format(time.RFC3339),
		})
		log.Error("création de facture PayDunya impossible", "order_id", ev.OrderID, "err", err)
		return
	}
	_, _ = s.db.Exec(ctx, "UPDATE payments SET provider_ref=$2, redirect_url=$3 WHERE id=$1", id, ref, redirect)
	log.Info("facture PayDunya créée", "payment_id", id, "order_id", ev.OrderID, "ref", ref)
}

/* ---------- Fournisseurs réels ---------- */

// createStripePaymentIntent — PaymentIntent (PAS Checkout Session) :
// le frontend affiche son propre formulaire de carte via Stripe Elements
// et confirme le paiement lui-même avec le client_secret renvoyé ici,
// sans jamais quitter le site. order_id part en métadonnée (pas
// client_reference_id, propre à Checkout Session) — c'est là que le
// webhook stripeWebhook le relit pour retrouver la commande.
func createStripePaymentIntent(orderID int64, reference string, totalUSD float64) (id, clientSecret string, err error) {
	key := kit.Env("STRIPE_SECRET_KEY", "")
	if key == "" {
		return "", "", fmt.Errorf("STRIPE_SECRET_KEY absente")
	}
	// Stripe attend amount dans la plus PETITE unité de la devise.
	// USD a 2 décimales (cents) — contrairement au XOF (zéro décimale)
	// utilisé auparavant ici, qui n'aurait pas eu besoin de ce ×100.
	amountCents := int64(math.Round(totalUSD * 100))
	form := url.Values{}
	form.Set("amount", strconv.FormatInt(amountCents, 10))
	form.Set("currency", "usd")
	form.Set("automatic_payment_methods[enabled]", "true")
	form.Set("description", "Commande MIAD "+reference)
	form.Set("metadata[order_id]", strconv.FormatInt(orderID, 10))
	form.Set("metadata[reference]", reference)

	req, _ := http.NewRequest(http.MethodPost, "https://api.stripe.com/v1/payment_intents",
		strings.NewReader(form.Encode()))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return "", "", fmt.Errorf("Stripe a refusé (%d): %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var doc struct {
		ID           string `json:"id"`
		ClientSecret string `json:"client_secret"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", "", err
	}
	return doc.ID, doc.ClientSecret, nil
}

// createPayDunyaInvoice — PayDunya (Wave, Orange Money) facture en XOF,
// devise locale UEMOA de ses moyens de paiement mobile ; le stockage
// interne reste en USD (source de vérité), converti ici uniquement pour
// cet appel via le taux exposé par shipping-svc (exchange_rates,
// source UNIQUE — voir shipping-svc/main.go).
func (s *server) createPayDunyaInvoice(ctx context.Context, ev orderCreatedEvent) (ref, redirect string, err error) {
	priv := kit.Env("PAYDUNYA_API_KEY_PRIVATE", "")
	pub := kit.Env("PAYDUNYA_API_KEY_PUBLIC", "")
	master := kit.Env("PAYDUNYA_MASTER_KEY", "")
	if priv == "" {
		return "", "", fmt.Errorf("PAYDUNYA_API_KEY_PRIVATE absente")
	}
	rateXOF, err := s.fetchExchangeRate(ctx, "XOF")
	if err != nil {
		return "", "", fmt.Errorf("taux XOF indisponible pour la conversion PayDunya: %w", err)
	}
	amountXOF := int64(math.Round(ev.TotalUSD * rateXOF))

	front := kit.Env("STOREFRONT_URL", "http://localhost:3000")
	payload := map[string]any{
		"invoice": map[string]any{
			"total_amount": amountXOF,
			"description":  "Commande MIAD " + ev.Reference,
			"items": []map[string]any{{
				"name": "Commande " + ev.Reference, "quantity": 1, "unit_price": amountXOF,
			}},
		},
		"actions": map[string]any{
			"return_url": front + "/checkout/success?order=" + strconv.FormatInt(ev.OrderID, 10),
			"cancel_url": front + "/checkout/cancel?order=" + strconv.FormatInt(ev.OrderID, 10),
		},
		"custom_data": map[string]any{"order_id": ev.OrderID},
	}
	body, _ := json.Marshal(payload)
	base := kit.Env("PAYDUNYA_API_BASE", "https://app.paydunya.com")
	req, _ := http.NewRequest(http.MethodPost, base+"/checkout-api/v1/checkout/invoice", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("PAYDUNYA-MASTER-KEY", master)
	req.Header.Set("PAYDUNYA-PRIVATE-KEY", priv)
	req.Header.Set("PAYDUNYA-PUBLIC-KEY", pub)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return "", "", fmt.Errorf("PayDunya a refusé (%d): %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var doc struct {
		ResponseCode string `json:"response_code"`
		ResponseText string `json:"response_text"`
		Token        string `json:"token"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", "", err
	}
	if doc.ResponseCode != "0000" || doc.Token == "" {
		return "", "", fmt.Errorf("PayDunya: %s (%s)", doc.ResponseText, doc.ResponseCode)
	}
	return doc.Token, base + "/checkout-api/v1/checkout/invoice/" + doc.Token, nil
}

// fetchExchangeRate — lit shipping-svc/exchange-rates (source UNIQUE des
// taux, voir shipping-svc/main.go). Échec EXPLICITE si indisponible :
// jamais de taux par défaut codé en dur ici, qui divergerait de la
// table exchange_rates au premier ajustement admin.
func (s *server) fetchExchangeRate(ctx context.Context, currency string) (float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.shippingURL+"/exchange-rates", nil)
	if err != nil {
		return 0, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("shipping-svc injoignable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("shipping-svc a répondu %d", resp.StatusCode)
	}
	var body struct {
		Rates []struct {
			Currency   string  `json:"currency"`
			RatePerUSD float64 `json:"rate_per_usd"`
		} `json:"rates"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0, err
	}
	for _, r := range body.Rates {
		if r.Currency == currency {
			return r.RatePerUSD, nil
		}
	}
	return 0, fmt.Errorf("taux %s absent de exchange_rates", currency)
}

/* ---------- Webhooks ---------- */

// stripeWebhook — vérification HMAC réelle de Stripe-Signature.
func (s *server) stripeWebhook(w http.ResponseWriter, r *http.Request) {
	secret := kit.Env("STRIPE_WEBHOOK_SECRET", "")
	if secret == "" {
		kit.Fail(w, 503, "webhook_not_configured", "STRIPE_WEBHOOK_SECRET absente — webhook refusé")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		kit.Fail(w, 400, "body_unreadable", err.Error())
		return
	}
	sig := r.Header.Get("Stripe-Signature")
	if !validStripeSignature(body, sig, secret) {
		kit.Fail(w, 401, "bad_signature", "signature Stripe invalide — événement rejeté")
		return
	}
	var event struct {
		Type string `json:"type"`
		Data struct {
			Object struct {
				ID       string `json:"id"`
				Metadata struct {
					OrderID string `json:"order_id"`
				} `json:"metadata"`
			} `json:"object"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &event); err != nil {
		kit.Fail(w, 400, "invalid_event", err.Error())
		return
	}
	orderID, _ := strconv.ParseInt(event.Data.Object.Metadata.OrderID, 10, 64)
	switch event.Type {
	case "payment_intent.succeeded":
		s.confirmPayment(w, r, orderID, "stripe", event.Data.Object.ID)
	case "payment_intent.payment_failed", "payment_intent.canceled":
		s.markFailed(w, r, orderID, "stripe")
	default:
		kit.JSON(w, 200, map[string]string{"received": event.Type})
	}
}

func validStripeSignature(body []byte, header, secret string) bool {
	var t, v1 string
	for _, part := range strings.Split(header, ",") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch kv[0] {
		case "t":
			t = kv[1]
		case "v1":
			v1 = kv[1]
		}
	}
	if t == "" || v1 == "" || !strings.HasPrefix(secret, "whsec_") {
		return false
	}
	ts, err := strconv.ParseInt(t, 10, 64)
	if err != nil || time.Now().Unix()-ts > 300 {
		return false // tolérance 5 minutes
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(secret, "whsec_"))
	if err != nil {
		key = []byte(strings.TrimPrefix(secret, "whsec_"))
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(t + "."))
	mac.Write(body)
	return hmac.Equal([]byte(hex.EncodeToString(mac.Sum(nil))), []byte(v1))
}

// paydunyaCallback — PayDunya notifie avec le token de la facture.
func (s *server) paydunyaCallback(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		kit.Fail(w, 400, "body_unreadable", err.Error())
		return
	}
	var doc struct {
		Data struct {
			Invoice struct {
				Token  string `json:"token"`
				Status string `json:"status"`
			} `json:"invoice"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		kit.Fail(w, 400, "invalid_callback", err.Error())
		return
	}
	token := doc.Data.Invoice.Token
	var orderID int64
	if err := s.db.QueryRow(r.Context(), "SELECT order_id FROM payments WHERE provider_ref=$1", token).Scan(&orderID); err != nil {
		kit.Fail(w, 404, "unknown_token", "facture PayDunya inconnue: "+token)
		return
	}
	if strings.EqualFold(doc.Data.Invoice.Status, "completed") {
		s.confirmPayment(w, r, orderID, "paydunya", token)
	} else {
		s.markFailed(w, r, orderID, "paydunya")
	}
}

/* ---------- Mutations ---------- */

func (s *server) confirmPayment(w http.ResponseWriter, r *http.Request, orderID int64, provider, ref string) {
	res, err := s.db.Exec(r.Context(), `
		UPDATE payments SET status='confirmed', provider_ref=CASE WHEN provider_ref='' THEN $2 ELSE provider_ref END,
		       confirmed_at=now()
		WHERE order_id=$1 AND status IN ('initiated','failed')`, orderID, ref)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if res.RowsAffected() == 0 {
		kit.Fail(w, 409, "not_confirmable", "aucun paiement en attente pour cette commande")
		return
	}
	kit.Publish(s.producer, "payment.confirmed", fmt.Sprint(orderID), map[string]any{
		"order_id": orderID, "provider": provider, "at": time.Now().UTC().Format(time.RFC3339),
	})
	if resp, err := http.Post(fmt.Sprintf("%s/orders/%d/confirm", s.orderURL, orderID), "application/json", nil); err == nil {
		resp.Body.Close()
	} else {
		slog.Error("order-svc injoignable — payment.confirmed reste sur Kafka", "err", err)
	}
	kit.JSON(w, 200, map[string]string{"received": "true"})
}

func (s *server) markFailed(w http.ResponseWriter, r *http.Request, orderID int64, provider string) {
	_, _ = s.db.Exec(r.Context(), "UPDATE payments SET status='failed' WHERE order_id=$1 AND status='initiated'", orderID)
	kit.Publish(s.producer, "payment.failed", fmt.Sprint(orderID), map[string]any{
		"order_id": orderID, "provider": provider, "at": time.Now().UTC().Format(time.RFC3339),
	})
	kit.JSON(w, 200, map[string]string{"received": "true"})
}

/* ---------- Lectures ---------- */

// initPayment — SYNCHRONE, contrairement au flux Kafka pur historique.
// Le frontend (Stripe Elements) a besoin du client_secret immédiatement
// pour afficher son formulaire de carte ; il ne peut pas attendre le
// consommateur order.created. Idempotent : si le PaymentIntent existe
// déjà (créé par initiateFor ou un appel précédent), le renvoie tel quel
// plutôt que d'en créer un second pour la même commande.
func (s *server) initPayment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OrderID   int64  `json:"order_id"`
		Reference string `json:"reference"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.OrderID == 0 {
		kit.Fail(w, 400, "invalid_body", "order_id obligatoire")
		return
	}
	ctx := r.Context()

	var id int64
	var provider, status, redirect, ref, clientSecret string
	var amount float64
	err := s.db.QueryRow(ctx, `
		SELECT id, provider, amount_usd, status, redirect_url, provider_ref, client_secret
		FROM payments WHERE order_id=$1 ORDER BY id DESC LIMIT 1`, body.OrderID,
	).Scan(&id, &provider, &amount, &status, &redirect, &ref, &clientSecret)
	if err != nil {
		kit.Fail(w, 404, "payment_not_found",
			fmt.Sprintf("aucun paiement pour la commande %d — order.created a-t-il été consommé ?", body.OrderID))
		return
	}

	if provider == "stripe" && clientSecret == "" && (status == "initiated" || status == "failed") {
		reference := body.Reference
		if reference == "" {
			reference = fmt.Sprintf("MIAD-%d", body.OrderID)
		}
		piID, secret, err := createStripePaymentIntent(body.OrderID, reference, amount)
		if err != nil {
			kit.Fail(w, 502, "stripe_error", fmt.Sprintf("création du PaymentIntent impossible: %v", err))
			return
		}
		if _, err := s.db.Exec(ctx,
			"UPDATE payments SET provider_ref=$2, client_secret=$3, status='initiated' WHERE id=$1",
			id, piID, secret); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		ref, clientSecret = piID, secret
	}

	kit.JSON(w, 200, map[string]any{
		"payment": map[string]any{
			"order_id": body.OrderID, "provider": provider, "provider_ref": ref,
			"amount_usd": amount, "currency": "USD", "status": status,
		},
		"client_secret": clientSecret, // Stripe Elements (vide pour PayDunya)
		"redirect_url":  redirect,     // PayDunya uniquement
	})
}

func (s *server) listPayments(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(kit.EnvOr(r.URL.Query().Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(r.URL.Query().Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}
	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM payments").Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT id, order_id, provider, amount_usd, status, method, created_at FROM payments
		ORDER BY id DESC LIMIT `+strconv.Itoa(pageSize)+` OFFSET `+strconv.Itoa((page-1)*pageSize))
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, orderID int64
		var amount float64
		var provider, status, method string
		var at time.Time
		_ = rows.Scan(&id, &orderID, &provider, &amount, &status, &method, &at)
		items = append(items, map[string]any{
			"id": id, "order_id": orderID, "provider": provider,
			"amount_usd": amount, "currency": "USD", "status": status, "method": method,
			"created_at": at.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

func (s *server) getPayment(w http.ResponseWriter, r *http.Request) {
	var orderID int64
	fmt.Sscanf(r.PathValue("order_id"), "%d", &orderID)
	row := s.db.QueryRow(r.Context(), `
		SELECT id, order_id, provider, provider_ref, amount_usd, currency, status, method, created_at
		FROM payments WHERE order_id=$1 ORDER BY id DESC LIMIT 1`, orderID)
	var id int64
	var amount float64
	var provider, ref, currency, status, method string
	var at time.Time
	if err := row.Scan(&id, &orderID, &provider, &ref, &amount, &currency, &status, &method, &at); err != nil {
		kit.Fail(w, 404, "payment_not_found", fmt.Sprintf("aucun paiement pour la commande %d", orderID))
		return
	}
	kit.JSON(w, 200, map[string]any{
		"id": id, "order_id": orderID, "provider": provider, "provider_ref": ref,
		"amount_usd": amount, "currency": currency, "status": status, "method": method,
		"created_at": at.UTC().Format(time.RFC3339),
	})
}

/* ---------- adaptateur consommateur ---------- */

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

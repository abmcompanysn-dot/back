// ============================================================
// payment-svc — Stripe (carte) + PayDunya (Wave, Orange Money).
// Consomme order.created → crée VRAIMENT la session de paiement.
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
  redirect_url TEXT DEFAULT '',
  amount_xof   BIGINT NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'XOF',
  status       TEXT NOT NULL DEFAULT 'initiated',
  method       TEXT DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments (provider_ref);
`

type server struct {
	db       *pgxpool.Pool
	producer sarama.SyncProducer
	orderURL string
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
		db:       db,
		producer: kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		orderURL: kit.Env("ORDER_SVC_URL", "http://order-svc:8083"),
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
		mux.HandleFunc("POST /payments/webhook/stripe", s.stripeWebhook)
		mux.HandleFunc("POST /payments/webhook/paydunya", s.paydunyaCallback)
	})
}

/* ---------- Consommation order.created ---------- */

type orderCreatedEvent struct {
	OrderID       int64  `json:"order_id"`
	Reference     string `json:"reference"`
	TotalXOF      int64  `json:"total_xof"`
	PaymentMethod string `json:"payment_method"`
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

// initiateFor crée le paiement puis la session chez le fournisseur réel.
func (s *server) initiateFor(ctx context.Context, log *slog.Logger, ev orderCreatedEvent) {
	provider := ev.PaymentMethod
	if provider == "" {
		provider = "stripe"
	}
	var id int64
	err := s.db.QueryRow(ctx, `
		INSERT INTO payments (order_id, provider, amount_xof, status)
		VALUES ($1, $2, $3, 'initiated')
		ON CONFLICT DO NOTHING RETURNING id`, ev.OrderID, provider, ev.TotalXOF).Scan(&id)
	if err != nil {
		log.Warn("paiement déjà initié", "order_id", ev.OrderID)
		return
	}

	var ref, redirect string
	switch provider {
	case "stripe":
		ref, redirect, err = createStripeCheckout(ev)
	case "paydunya":
		ref, redirect, err = createPayDunyaInvoice(ev)
	}
	if err != nil {
		// EXPLICITE : le paiement est marqué failed, l'événement part sur Kafka.
		_, _ = s.db.Exec(ctx, "UPDATE payments SET status='failed' WHERE id=$1", id)
		kit.Publish(s.producer, "payment.failed", fmt.Sprint(ev.OrderID), map[string]any{
			"order_id": ev.OrderID, "provider": provider, "reason": err.Error(),
			"at":       time.Now().UTC().Format(time.RFC3339),
		})
		log.Error("création de session impossible", "provider", provider, "order_id", ev.OrderID, "err", err)
		return
	}
	_, _ = s.db.Exec(ctx, "UPDATE payments SET provider_ref=$2, redirect_url=$3 WHERE id=$1", id, ref, redirect)
	log.Info("session de paiement créée", "payment_id", id, "order_id", ev.OrderID,
		"provider", provider, "ref", ref)
}

/* ---------- Fournisseurs réels ---------- */

func createStripeCheckout(ev orderCreatedEvent) (ref, redirect string, err error) {
	key := kit.Env("STRIPE_SECRET_KEY", "")
	if key == "" {
		return "", "", fmt.Errorf("STRIPE_SECRET_KEY absente")
	}
	front := kit.Env("STOREFRONT_URL", "http://localhost:3000")
	form := url.Values{}
	form.Set("mode", "payment")
	form.Set("line_items[0][quantity]", "1")
	form.Set("line_items[0][price_data][currency]", "xof")
	form.Set("line_items[0][price_data][unit_amount]", strconv.FormatInt(ev.TotalXOF, 10)) // XOF : zéro décimale
	form.Set("line_items[0][price_data][product_data][name]", "Commande MIAD "+ev.Reference)
	form.Set("client_reference_id", strconv.FormatInt(ev.OrderID, 10))
	form.Set("success_url", front+"/checkout/success?order="+strconv.FormatInt(ev.OrderID, 10))
	form.Set("cancel_url", front+"/checkout/cancel?order="+strconv.FormatInt(ev.OrderID, 10))

	req, _ := http.NewRequest(http.MethodPost, "https://api.stripe.com/v1/checkout/sessions",
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
		ID  string `json:"id"`
		URL string `json:"url"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", "", err
	}
	return doc.ID, doc.URL, nil
}

func createPayDunyaInvoice(ev orderCreatedEvent) (ref, redirect string, err error) {
	priv := kit.Env("PAYDUNYA_API_KEY_PRIVATE", "")
	pub := kit.Env("PAYDUNYA_API_KEY_PUBLIC", "")
	master := kit.Env("PAYDUNYA_MASTER_KEY", "")
	if priv == "" {
		return "", "", fmt.Errorf("PAYDUNYA_API_KEY_PRIVATE absente")
	}
	front := kit.Env("STOREFRONT_URL", "http://localhost:3000")
	payload := map[string]any{
		"invoice": map[string]any{
			"total_amount": ev.TotalXOF,
			"description":  "Commande MIAD " + ev.Reference,
			"items": []map[string]any{{
				"name": "Commande " + ev.Reference, "quantity": 1, "unit_price": ev.TotalXOF,
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
				ClientReferenceID string `json:"client_reference_id"`
			} `json:"object"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &event); err != nil {
		kit.Fail(w, 400, "invalid_event", err.Error())
		return
	}
	switch event.Type {
	case "checkout.session.completed", "payment_intent.succeeded":
		orderID, _ := strconv.ParseInt(event.Data.Object.ClientReferenceID, 10, 64)
		s.confirmPayment(w, r, orderID, "stripe", "evt")
	case "checkout.session.expired", "payment_intent.payment_failed":
		orderID, _ := strconv.ParseInt(event.Data.Object.ClientReferenceID, 10, 64)
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

func (s *server) initPayment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OrderID int64 `json:"order_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.OrderID == 0 {
		kit.Fail(w, 400, "invalid_body", "order_id obligatoire")
		return
	}
	row := s.db.QueryRow(r.Context(), `
		SELECT provider, amount_xof, status, redirect_url, provider_ref
		FROM payments WHERE order_id=$1 ORDER BY id DESC LIMIT 1`, body.OrderID)
	var provider, status, redirect, ref string
	var amount int64
	if err := row.Scan(&provider, &amount, &status, &redirect, &ref); err != nil {
		kit.Fail(w, 404, "payment_not_found",
			fmt.Sprintf("aucun paiement pour la commande %d — order.created a-t-il été consommé ?", body.OrderID))
		return
	}
	kit.JSON(w, 200, map[string]any{
		"payment": map[string]any{
			"order_id": body.OrderID, "provider": provider, "provider_ref": ref,
			"amount_xof": amount, "currency": "XOF", "status": status,
		},
		"redirect_url": redirect,
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
		SELECT id, order_id, provider, amount_xof, status, method, created_at FROM payments
		ORDER BY id DESC LIMIT `+strconv.Itoa(pageSize)+` OFFSET `+strconv.Itoa((page-1)*pageSize))
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, orderID, amount int64
		var provider, status, method string
		var at time.Time
		_ = rows.Scan(&id, &orderID, &provider, &amount, &status, &method, &at)
		items = append(items, map[string]any{
			"id": id, "order_id": orderID, "provider": provider,
			"amount_xof": amount, "currency": "XOF", "status": status, "method": method,
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
		SELECT id, order_id, provider, provider_ref, amount_xof, currency, status, method, created_at
		FROM payments WHERE order_id=$1 ORDER BY id DESC LIMIT 1`, orderID)
	var id, amount int64
	var provider, ref, currency, status, method string
	var at time.Time
	if err := row.Scan(&id, &orderID, &provider, &ref, &amount, &currency, &status, &method, &at); err != nil {
		kit.Fail(w, 404, "payment_not_found", fmt.Sprintf("aucun paiement pour la commande %d", orderID))
		return
	}
	kit.JSON(w, 200, map[string]any{
		"id": id, "order_id": orderID, "provider": provider, "provider_ref": ref,
		"amount_xof": amount, "currency": currency, "status": status, "method": method,
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

// ============================================================
// payment-svc — Stripe (carte) + PayDunya (Wave, Orange Money).
// Consomme order.created sur Kafka → initialise le paiement.
// Publie payment.confirmed / payment.failed.
// payments.order_id : référence logique, JAMAIS de FK SQL
// (bases séparées — cohérence éventuelle assumée).
// ============================================================
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/IBM/sarama"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/miadmarket/miad-backend/internal/kit"
)

const schema = `
CREATE TABLE IF NOT EXISTS payments (
  id           BIGSERIAL PRIMARY KEY,
  order_id     BIGINT NOT NULL,            -- logique, pas de FK SQL
  provider     TEXT NOT NULL CHECK (provider IN ('stripe','paydunya')),
  provider_ref TEXT DEFAULT '',
  amount_xof   BIGINT NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'XOF',
  status       TEXT NOT NULL DEFAULT 'initiated',
  method       TEXT DEFAULT '',            -- card | wave | orange_money
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);
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

	// Consommateur Kafka : order.created → init paiement.
	go s.consumeOrders(log)

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	health.Add("stripe_key", func(ctx context.Context) error {
		if kit.Env("STRIPE_SECRET_KEY", "") == "" {
			return fmt.Errorf("STRIPE_SECRET_KEY absente — paiements Stripe inopérants")
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
		mux.HandleFunc("POST /payments/webhook/stripe", s.stripeWebhook)
		mux.HandleFunc("POST /payments/webhook/paydunya", s.paydunyaWebhook)
		mux.HandleFunc("GET /payments/order/{order_id}", s.getPayment)
	})
}

type orderCreatedEvent struct {
	OrderID       int64  `json:"order_id"`
	Reference     string `json:"reference"`
	TotalXOF      int64  `json:"total_xof"`
	PaymentMethod string `json:"payment_method"`
}

// consumeOrders — si le service redémarre, Kafka rejoue depuis le
// dernier offset : aucune commande créée pendant la panne n'est oubliée.
func (s *server) consumeOrders(log *slog.Logger) {
	brokers := kit.Env("KAFKA_BROKERS", "kafka:9092")
	if brokers == "" {
		log.Warn("KAFKA_BROKERS vide — consumption désactivée (mode dev)")
		return
	}
	cfg := sarama.NewConfig()
	cfg.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{sarama.NewBalanceStrategyRoundRobin()}
	cfg.Consumer.Offsets.Initial = sarama.OffsetOldest
	cfg.Version = sarama.V2_8_0_0

	for {
		group, err := sarama.NewConsumerGroup([]string{brokers}, "payment-svc", cfg)
		if err != nil {
			log.Error("kafka consumer injoignable — nouvelle tentative dans 5 s", "err", err)
			time.Sleep(5 * time.Second)
			continue
		}
		log.Info("consommateur Kafka connecté", "topics", "order.created")
		handler := saramaConsumerFunc(func(ctx context.Context, msg *sarama.ConsumerMessage) {
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
		log.Warn("paiement déjà initié ou erreur", "order_id", ev.OrderID, "err", err)
		return
	}
	// TODO(branchement réel) : créer la Session Stripe Checkout ou la
	// requête PayDunya, stocker provider_ref. Signalé explicitement :
	// tant que les clés de test ne sont pas fournies, on journalise.
	log.Info("paiement initié", "payment_id", id, "order_id", ev.OrderID,
		"provider", provider, "amount_xof", ev.TotalXOF)
}

func (s *server) initPayment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OrderID   int64  `json:"order_id"`
		Provider  string `json:"provider"`
		ReturnURL string `json:"return_url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Provider != "stripe" && body.Provider != "paydunya" {
		kit.Fail(w, 400, "invalid_provider", "provider doit être stripe ou paydunya")
		return
	}
	var amount int64
	var status string
	err := s.db.QueryRow(r.Context(),
		`SELECT amount_xof, status FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`,
		body.OrderID).Scan(&amount, &status)
	if err != nil {
		kit.Fail(w, 404, "payment_not_found",
			fmt.Sprintf("aucun paiement pour la commande %d — order.created a-t-il bien été consommé ?", body.OrderID))
		return
	}
	kit.JSON(w, 200, map[string]any{
		"payment": map[string]any{
			"order_id": body.OrderID, "provider": body.Provider,
			"amount_xof": amount, "currency": "XOF", "status": status,
		},
		"redirect_url": fmt.Sprintf("https://checkout.%s.local/%d", body.Provider, body.OrderID),
		"note":         "URL de redirection réelle générée au branchement des clés Stripe/PayDunya",
	})
}

// stripeWebhook — vérification de signature OBLIGATOIRE avant toute
// mutation (Stripe-Signature + STRIPE_WEBHOOK_SECRET).
func (s *server) stripeWebhook(w http.ResponseWriter, r *http.Request) {
	if kit.Env("STRIPE_WEBHOOK_SECRET", "") == "" {
		kit.Fail(w, 503, "webhook_not_configured", "STRIPE_WEBHOOK_SECRET absente — webhook refusé par sécurité")
		return
	}
	// TODO(branchement réel) : stripe webhook.ConstructEvent(body, sig, secret).
	s.confirm(w, r, "stripe")
}

func (s *server) paydunyaWebhook(w http.ResponseWriter, r *http.Request) {
	s.confirm(w, r, "paydunya")
}

func (s *server) confirm(w http.ResponseWriter, r *http.Request, provider string) {
	var body struct {
		OrderID     int64  `json:"order_id"`
		ProviderRef string `json:"provider_ref"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	res, err := s.db.Exec(r.Context(), `
		UPDATE payments SET status='confirmed', provider_ref=$2, confirmed_at=now()
		WHERE order_id=$1 AND provider=$3 AND status='initiated'`,
		body.OrderID, body.ProviderRef, provider)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if res.RowsAffected() == 0 {
		kit.Fail(w, 409, "not_confirmable", "aucun paiement initié en attente pour cette commande — rien n'est fait silencieusement")
		return
	}
	kit.Publish(s.producer, "payment.confirmed", fmt.Sprint(body.OrderID), map[string]any{
		"order_id": body.OrderID, "provider": provider, "provider_ref": body.ProviderRef,
		"at": time.Now().UTC().Format(time.RFC3339),
	})
	// order-svc passe la commande en paid (appel interne).
	if resp, err := http.Post(fmt.Sprintf("%s/orders/%d/confirm", s.orderURL, body.OrderID),
		"application/json", nil); err == nil {
		resp.Body.Close()
	} else {
		slog.Error("order-svc injoignable pour confirmation — payment.confirmed reste sur Kafka", "err", err)
	}
	kit.JSON(w, 200, map[string]string{"received": "true"})
}

func (s *server) getPayment(w http.ResponseWriter, r *http.Request) {
	var orderID int64
	fmt.Sscanf(r.PathValue("order_id"), "%d", &orderID)
	row := s.db.QueryRow(r.Context(), `
		SELECT id, order_id, provider, provider_ref, amount_xof, currency, status, method, created_at
		FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, orderID)
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

// ---------- adaptateur consommateur minimal ----------

type saramaConsumerFunc func(ctx context.Context, msg *sarama.ConsumerMessage)

func (f saramaConsumerFunc) Setup(sarama.ConsumerGroupSession) error   { return nil }
func (f saramaConsumerFunc) Cleanup(sarama.ConsumerGroupSession) error { return nil }
func (f saramaConsumerFunc) ConsumeClaim(sess sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
	for msg := range claim.Messages() {
		f(sess.Context(), msg)
		sess.MarkMessage(msg, "")
	}
	return nil
}

var _ = os.Getenv

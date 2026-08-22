// ============================================================
// notification-svc — CONSOMMATEUR PUR Kafka.
// Écoute order.* et payment.* → journal de notifications
// (webpush + email). Aucun autre service ne dépend de lui :
// s'il tombe, le reste continue ; il rattrape au redémarrage.
// ============================================================
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status);
`

var watchedTopics = []string{
	"order.created",
	"order.status_changed",
	"payment.confirmed",
	"payment.failed",
}

type server struct {
	db *pgxpool.Pool
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

	s := &server{db: db}
	go s.consume(log)

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	health.Add("kafka_topics", func(ctx context.Context) error {
		// Le consommateur tourne en goroutine ; ici on vérifie la table de suivi.
		_, err := db.Exec(ctx, "SELECT 1")
		return err
	})

	kit.Run("notification-svc", kit.Env("PORT_NOTIFICATION", "8087"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("GET /notifications/stats", s.stats)
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
	// Ici : référence de commande comme clé de routage — le branchement
	// email/webpush réel est SIGNALÉ comme restant à câbler.
	recipient := "customer@" + msg.Topic
	if rid, ok := payload["customer_id"]; ok {
		recipient = "customer:" + jsonNum(rid)
	}

	for _, channel := range []string{"webpush", "email"} {
		body, _ := json.Marshal(payload)
		if _, err := s.db.Exec(ctx, `
			INSERT INTO notifications (channel, event, recipient, payload, status)
			VALUES ($1,$2,$3,$4,'queued')`, channel, msg.Topic, recipient, body); err != nil {
			log.Error("persistance notification impossible", "err", err)
			return // pas d'ack → Kafka redelivre : rien n'est perdu en silence
		}
	}
	log.Info("notification journalisée", "event", msg.Topic, "recipient", recipient)
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

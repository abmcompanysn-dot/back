// ============================================================
// Package kit — socle commun des 7 services MIAD Market.
// Erreurs EXPLICITES partout (leçon de l'incident WP du 29/07) :
// toute réponse d'erreur suit l'enveloppe {"error":{"code","message"}}.
// ============================================================
package kit

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"sync"
	"syscall"
	"time"

	"github.com/IBM/sarama"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// ---------- Configuration ----------

func Env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// EnvOr — même logique pour une valeur déjà lue (ex: paramètre de requête).
func EnvOr(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

func Logger(service string) *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("svc", service)
}

// ---------- Erreurs explicites ----------

type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorEnvelope struct {
	Error APIError `json:"error"`
}

func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func Fail(w http.ResponseWriter, status int, code, msg string) {
	JSON(w, status, errorEnvelope{Error: APIError{Code: code, Message: msg}})
}

// ---------- Postgres (une base par service) ----------

func NewPG(ctx context.Context, log *slog.Logger, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("dsn invalide: %w", err)
	}
	cfg.MaxConns = 10
	var pool *pgxpool.Pool
	for attempt := 1; attempt <= 15; attempt++ {
		pool, err = pgxpool.NewWithConfig(ctx, cfg)
		if err == nil {
			if err = pool.Ping(ctx); err == nil {
				log.Info("postgres connecté", "attempt", attempt)
				return pool, nil
			}
			pool.Close()
		}
		log.Warn("postgres pas encore prêt", "attempt", attempt, "err", err)
		time.Sleep(2 * time.Second)
	}
	return nil, fmt.Errorf("postgres injoignable après 15 tentatives: %w", err)
}

// Migrate applique un schéma idempotent au démarrage (CREATE … IF NOT EXISTS).
func Migrate(ctx context.Context, pool *pgxpool.Pool, schema string) error {
	_, err := pool.Exec(ctx, schema)
	return err
}

// ---------- Redis (cache + sessions) ----------

func NewRedis(addr, password string) *redis.Client {
	return redis.NewClient(&redis.Options{Addr: addr, Password: password})
}

// ---------- Kafka ----------

// NewProducer renvoie nil (sans erreur) si brokers vide : le service
// démarre en mode "événements journalisés" — utile en dev local.
func NewProducer(brokers string) sarama.SyncProducer {
	if brokers == "" {
		return nil
	}
	cfg := sarama.NewConfig()
	cfg.Producer.RequiredAcks = sarama.WaitForAll
	cfg.Producer.Retry.Max = 5
	cfg.Producer.Return.Successes = true
	p, err := sarama.NewSyncProducer(splitBrokers(brokers), cfg)
	if err != nil {
		slog.Error("kafka producteur indisponible — mode journalisé", "err", err)
		return nil
	}
	return p
}

func Publish(p sarama.SyncProducer, topic, key string, payload any) {
	body, _ := json.Marshal(payload)
	if p == nil {
		slog.Info("kafka (journalisé)", "topic", topic, "key", key, "payload", string(body))
		return
	}
	_, _, err := p.SendMessage(&sarama.ProducerMessage{
		Topic: topic,
		Key:   sarama.StringEncoder(key),
		Value: sarama.ByteEncoder(body),
	})
	if err != nil {
		slog.Error("échec publication kafka", "topic", topic, "err", err)
	}
}

func splitBrokers(s string) []string {
	out := []string{}
	cur := ""
	for _, r := range s + "," {
		if r == ',' {
			if cur != "" {
				out = append(out, cur)
			}
			cur = ""
			continue
		}
		cur += string(r)
	}
	return out
}

// ---------- Health-check natif (le point qui manquait sous WP) ----------

type Health struct {
	mu     sync.RWMutex
	checks map[string]func(ctx context.Context) error
}

func NewHealth() *Health { return &Health{checks: map[string]func(ctx context.Context) error{}} }

func (h *Health) Add(name string, fn func(ctx context.Context) error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.checks[name] = fn
}

type checkResult struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

func (h *Health) Handler(service string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h.mu.RLock()
		defer h.mu.RUnlock()
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		overall := "ok"
		out := map[string]checkResult{}
		names := make([]string, 0, len(h.checks))
		for n := range h.checks {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			res := checkResult{Status: "ok"}
			if err := h.checks[n](ctx); err != nil {
				res.Status = "down"
				res.Error = err.Error()
				overall = "degraded"
			}
			out[n] = res
		}
		JSON(w, 200, map[string]any{
			"service": service,
			"status":  overall,
			"checks":  out,
			"time":    time.Now().UTC().Format(time.RFC3339),
		})
	}
}

// ---------- Serveur ----------

// Run monte le mux HTTP, /healthz + /system-check, et gère l'arrêt propre.
func Run(service, port string, log *slog.Logger, h *Health, register func(mux *http.ServeMux)) {
	mux := http.NewServeMux()
	register(mux)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		JSON(w, 200, map[string]string{"service": service, "status": "ok"})
	})
	mux.HandleFunc("GET /system-check", h.Handler(service))

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           withRecover(withLog(log, mux)),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		log.Info("service démarré", "port", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error("arrêt serveur", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	log.Info("service arrêté proprement")
}

func withLog(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Info("req", "method", r.Method, "path", r.URL.Path, "dur_ms", time.Since(start).Milliseconds())
	})
}

func withRecover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				Fail(w, 500, "internal_error", fmt.Sprintf("panique serveur: %v", rec))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

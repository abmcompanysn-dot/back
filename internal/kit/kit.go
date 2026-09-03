// ============================================================
// Package kit — socle commun des 7 services MIAD Market.
// Erreurs EXPLICITES partout (leçon de l'incident WP du 29/07) :
// toute réponse d'erreur suit l'enveloppe {"error":{"code","message"}}.
// ============================================================
package kit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/IBM/sarama"
	"github.com/disintegration/imaging"
	sentry "github.com/getsentry/sentry-go"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
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

// ---------- Sentry (suivi des erreurs — commun aux 11 services) ----------

// sentryEnabled — vrai si sentry.Init a réussi (DSN présent et valide).
var sentryEnabled bool

// initSentry — appelé par Run au démarrage de chaque service. Lit
// SENTRY_DSN dans l'environnement (Secret k8s miad-secrets / .env du VPS) ;
// sans DSN, tout est no-op. Le nom du service devient un tag Sentry pour
// savoir immédiatement lequel des 11 a planté (même clé que le champ "svc"
// des logs slog).
func initSentry(service string) {
	dsn := os.Getenv("SENTRY_DSN")
	if dsn == "" {
		return
	}
	err := sentry.Init(sentry.ClientOptions{
		Dsn:              dsn,
		Environment:      Env("SENTRY_ENV", Env("ENV", "production")),
		Release:          os.Getenv("GIT_SHA"), // renseigné au build si dispo
		AttachStacktrace: true,
		// Pas de tracing perf (quota) — uniquement les erreurs/panics.
		TracesSampleRate: 0,
	})
	if err != nil {
		slog.Error("sentry.Init a échoué — suivi des erreurs désactivé", "err", err)
		return
	}
	sentry.ConfigureScope(func(scope *sentry.Scope) {
		scope.SetTag("svc", service)
	})
	sentryEnabled = true
	slog.Info("sentry actif", "svc", service)
}

// CaptureError — remonte une erreur applicative dans Sentry avec un
// contexte optionnel. No-op si Sentry n'est pas configuré. À utiliser dans
// les services pour les erreurs qu'on veut voir sans forcément renvoyer un
// 5xx (échec Kafka, appel inter-service dégradé, etc.).
func CaptureError(err error, context map[string]any) {
	if !sentryEnabled || err == nil {
		return
	}
	sentry.WithScope(func(scope *sentry.Scope) {
		for k, v := range context {
			scope.SetExtra(k, v)
		}
		sentry.CaptureException(err)
	})
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
	// Les 5xx sont de vrais incidents serveur — on les remonte dans Sentry
	// (rappel : Fail ne logue rien par lui-même, cf. CLAUDE.md « kit.Fail()
	// ne loge JAMAIS rien »). Les 4xx sont des erreurs client attendues,
	// on ne les envoie pas pour ne pas noyer Sentry.
	if status >= 500 && sentryEnabled {
		sentry.WithScope(func(scope *sentry.Scope) {
			scope.SetTag("error.code", code)
			scope.SetLevel(sentry.LevelError)
			sentry.CaptureException(fmt.Errorf("%s: %s", code, msg))
		})
	}
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

// ---------- Configuration éditable en base (Configuration Système admin) ----------

// SettingsField — un champ de configuration exposé dans la page
// "Configuration Système" du dashboard admin. Secret=true : jamais
// renvoyé en clair par GET (seulement un booléen "configuré"), pour ne
// pas exposer une clé API/mot de passe à qui a accès en lecture au
// dashboard — même pattern que dhl_settings (fulfillment-svc), factorisé
// ici pour éviter de le recopier dans chaque service qui a des variables
// d'env à rendre éditables sans redéploiement (2026-08-25).
type SettingsField struct {
	Key         string
	Ptr         *string // pointeur vers le champ vivant du server struct — écrasé par Load/Save
	Secret      bool
	Description string
}

// SettingsStoreSchema — table clé/valeur à ajouter au schéma SQL du
// service. name est le nom de la table (un service peut en avoir
// plusieurs s'il regroupe des configs de nature différente).
func SettingsStoreSchema(table string) string {
	return fmt.Sprintf(`
CREATE TABLE IF NOT EXISTS %s (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`, table)
}

// SettingsStore — charge/sauvegarde un ensemble de SettingsField dans une
// table clé/valeur, avec les valeurs par défaut (lues depuis les
// variables d'env au démarrage) écrasées par la base dès qu'un admin les
// édite au moins une fois depuis l'UI. Thread-safe : les champs sont lus
// à chaque requête HTTP par le service appelant, jamais copiés une seule
// fois au démarrage.
type SettingsStore struct {
	mu     sync.RWMutex
	db     *pgxpool.Pool
	table  string
	fields map[string]*string
	secret map[string]bool
}

func NewSettingsStore(db *pgxpool.Pool, table string, fields []SettingsField) *SettingsStore {
	s := &SettingsStore{db: db, table: table, fields: map[string]*string{}, secret: map[string]bool{}}
	for _, f := range fields {
		s.fields[f.Key] = f.Ptr
		s.secret[f.Key] = f.Secret
	}
	return s
}

// Load — à appeler au démarrage, après avoir peuplé les champs avec leurs
// valeurs par défaut (Env(...)) : écrase avec ce qui a été édité en base.
func (s *SettingsStore) Load(ctx context.Context) error {
	rows, err := s.db.Query(ctx, "SELECT key, value FROM "+s.table)
	if err != nil {
		return err
	}
	defer rows.Close()
	values := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err == nil {
			values[k] = v
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range values {
		if ptr, ok := s.fields[k]; ok {
			*ptr = v
		}
	}
	return nil
}

// Save — upsert les clés fournies en base ET met à jour les champs en
// mémoire sous verrou, pour que la requête suivante voie immédiatement la
// nouvelle valeur sans redémarrage. Un champ secret laissé vide dans
// `values` doit être filtré par l'appelant AVANT Save (jamais écraser un
// secret déjà configuré par du vide) — Save ne fait pas cette distinction
// lui-même, elle dépend du contexte HTTP (body reçu) que ce package n'a pas.
func (s *SettingsStore) Save(ctx context.Context, values map[string]string) error {
	for k, v := range values {
		if _, err := s.db.Exec(ctx, fmt.Sprintf(`
			INSERT INTO %s (key, value) VALUES ($1, $2)
			ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, s.table), k, v); err != nil {
			return err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range values {
		if ptr, ok := s.fields[k]; ok {
			*ptr = v
		}
	}
	return nil
}

// Snapshot — renvoie l'état actuel pour GET /settings : valeur en clair
// pour les champs normaux, seulement `<key>_configured: bool` pour les
// secrets.
func (s *SettingsStore) Snapshot() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]any{}
	for k, ptr := range s.fields {
		if s.secret[k] {
			out[k+"_configured"] = *ptr != ""
			continue
		}
		out[k] = *ptr
	}
	return out
}

// IsKnown — vrai si k est un champ déclaré (pour filtrer un body PUT
// avant Save, ignorer les clés inconnues plutôt que les rejeter).
func (s *SettingsStore) IsKnown(k string) bool {
	_, ok := s.fields[k]
	return ok
}

// IsSecret — vrai si k est un champ secret (pour ignorer une valeur vide
// envoyée par l'UI, qui signifie "inchangé" et non "vider").
func (s *SettingsStore) IsSecret(k string) bool {
	return s.secret[k]
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

// ---------- Stockage objet (MinIO — images produits/vendeurs) ----------

// Media regroupe le client MinIO et la config nécessaire pour uploader
// une image et obtenir son URL publique HTTPS (img.miadmarket.ca en prod).
type Media struct {
	client  *minio.Client
	bucket  string
	baseURL string // ex: https://img.miadmarket.ca — pas de slash final
}

// NewMedia se connecte à MinIO via son endpoint interne au cluster
// (minio:9000, jamais exposé directement — servi en HTTPS par Caddy sur
// un domaine dédié, voir deploy/Caddyfile). useSSL=false car la liaison
// service→service reste à l'intérieur du cluster, pas exposée au public.
func NewMedia(endpoint, accessKey, secretKey, bucket, baseURL string) (*Media, error) {
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: false,
	})
	if err != nil {
		return nil, fmt.Errorf("client minio: %w", err)
	}
	return &Media{client: client, bucket: bucket, baseURL: strings.TrimRight(baseURL, "/")}, nil
}

// Upload envoie un fichier sous un nom unique (préfixé par la catégorie
// d'usage, ex: "products/", "vendors/") et renvoie son URL HTTPS publique.
func (m *Media) Upload(ctx context.Context, prefix, filename string, r io.Reader, size int64, contentType string) (string, error) {
	key := path.Join(prefix, filename)
	_, err := m.client.PutObject(ctx, m.bucket, key, r, size, minio.PutObjectOptions{ContentType: contentType})
	if err != nil {
		return "", fmt.Errorf("upload minio: %w", err)
	}
	return m.baseURL + "/" + key, nil
}

// thumbnailSizes — mêmes tailles que l'ancienne convention WordPress
// (voir frontend/lib/image-utils.ts getThumbnailUrl), pour que le frontend
// existant les trouve sans modification : "<nom>-300x300.<ext>" etc.
var thumbnailSizes = []int{300, 150}

// UploadWithThumbnails fait comme Upload (l'original en pleine résolution
// reste servi tel quel, jamais dégradé) mais génère EN PLUS des variantes
// redimensionnées 300x300/150x150 uploadées à côté, sous le même nom que
// getThumbnailUrl() sait déjà reconstruire côté frontend. Ajouté le
// 2026-09-03 : avant ça, aucune miniature n'était jamais créée pour les
// images uploadées depuis ce back-office (contrairement à l'ancien WordPress),
// donc chaque carte produit chargeait l'image complète (souvent 100-500 Ko)
// au lieu de quelques Ko — gros ralentissement pour les visiteurs loin du
// VPS. best-effort : si le fichier n'est pas une image décodable (jpeg/png)
// ou que la génération échoue, on log et on continue — l'upload de
// l'original ne doit jamais échouer à cause d'un problème de miniature.
func (m *Media) UploadWithThumbnails(ctx context.Context, prefix, filename string, r io.Reader, size int64, contentType string, log *slog.Logger) (string, error) {
	// On doit lire tout le fichier en mémoire pour pouvoir à la fois
	// l'uploader tel quel ET le décoder pour générer les miniatures —
	// r ne peut être consommé qu'une fois (multipart.File n'est pas
	// forcément ré-avançable selon l'implémentation).
	data, err := io.ReadAll(r)
	if err != nil {
		return "", fmt.Errorf("lecture fichier: %w", err)
	}

	url, err := m.Upload(ctx, prefix, filename, bytes.NewReader(data), size, contentType)
	if err != nil {
		return "", err
	}

	img, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		// Pas une image décodable (svg, webp non supporté par la stdlib, etc.)
		// — pas grave, LazyImage retente automatiquement l'original en cas
		// de 404 sur la miniature (voir frontend/components/miad/LazyImage.tsx).
		if log != nil {
			log.Info("miniature non générée (format non décodable)", "filename", filename, "err", err.Error())
		}
		return url, nil
	}

	lastDot := strings.LastIndex(filename, ".")
	if lastDot <= 0 {
		return url, nil
	}
	base, ext := filename[:lastDot], filename[lastDot:]

	for _, sizePx := range thumbnailSizes {
		thumb := imaging.Fill(img, sizePx, sizePx, imaging.Center, imaging.Lanczos)
		var buf bytes.Buffer
		var thumbContentType string
		switch format {
		case "png":
			err = png.Encode(&buf, thumb)
			thumbContentType = "image/png"
		default: // jpeg et tout le reste réencodés en jpeg (format le plus léger)
			err = jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: 82})
			thumbContentType = "image/jpeg"
		}
		if err != nil {
			if log != nil {
				log.Warn("encodage miniature échoué", "filename", filename, "size", sizePx, "err", err.Error())
			}
			continue
		}
		thumbName := fmt.Sprintf("%s-%dx%d%s", base, sizePx, sizePx, ext)
		if _, thumbErr := m.Upload(ctx, prefix, thumbName, &buf, int64(buf.Len()), thumbContentType); thumbErr != nil && log != nil {
			log.Warn("upload miniature échoué", "filename", thumbName, "err", thumbErr.Error())
		}
	}

	return url, nil
}

// Download récupère le contenu brut d'un objet MinIO à partir de sa clé
// (chemin relatif au bucket, ex: "products/xxx.jpg" — pas l'URL publique
// complète). Utilisé par les outils de rattrapage (cmd/generate-thumbnails)
// pour regénérer des miniatures sur des images déjà en ligne.
func (m *Media) Download(ctx context.Context, key string) ([]byte, error) {
	obj, err := m.client.GetObject(ctx, m.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("get object minio: %w", err)
	}
	defer obj.Close()
	return io.ReadAll(obj)
}

// ListKeys énumère toutes les clés d'objet sous un préfixe donné (ex:
// "products/") — pagination gérée en interne par le SDK MinIO (canal).
func (m *Media) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	var keys []string
	for obj := range m.client.ListObjects(ctx, m.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
		if obj.Err != nil {
			return keys, fmt.Errorf("list objects minio: %w", obj.Err)
		}
		keys = append(keys, obj.Key)
	}
	return keys, nil
}

// GenerateThumbnailsFor régénère les miniatures 300x300/150x150 d'un objet
// déjà en ligne (identifié par sa clé MinIO), sans re-uploader l'original —
// utilisé pour le rattrapage des images uploadées avant l'introduction de
// UploadWithThumbnails (2026-09-03). Ignore silencieusement (retourne nil)
// les clés qui sont déjà des miniatures (suffixe "-300x300"/"-150x150") ou
// dont le format n'est pas décodable.
func (m *Media) GenerateThumbnailsFor(ctx context.Context, key string, log *slog.Logger) error {
	for _, sizePx := range thumbnailSizes {
		if strings.Contains(key, fmt.Sprintf("-%dx%d.", sizePx, sizePx)) {
			return nil // déjà une miniature, rien à faire
		}
	}
	data, err := m.Download(ctx, key)
	if err != nil {
		return err
	}
	img, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil // format non décodable — pas une erreur bloquante, voir UploadWithThumbnails
	}

	dir, filename := path.Split(key)
	lastDot := strings.LastIndex(filename, ".")
	if lastDot <= 0 {
		return nil
	}
	base, ext := filename[:lastDot], filename[lastDot:]
	prefix := strings.TrimSuffix(dir, "/")

	for _, sizePx := range thumbnailSizes {
		thumbName := fmt.Sprintf("%s-%dx%d%s", base, sizePx, sizePx, ext)
		// Déjà générée (ex: relance après une exécution partielle) — on ne
		// re-télécharge/regénère pas pour rien.
		if _, statErr := m.client.StatObject(ctx, m.bucket, path.Join(prefix, thumbName), minio.StatObjectOptions{}); statErr == nil {
			continue
		}
		thumb := imaging.Fill(img, sizePx, sizePx, imaging.Center, imaging.Lanczos)
		var buf bytes.Buffer
		var thumbContentType string
		if format == "png" {
			err = png.Encode(&buf, thumb)
			thumbContentType = "image/png"
		} else {
			err = jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: 82})
			thumbContentType = "image/jpeg"
		}
		if err != nil {
			if log != nil {
				log.Warn("encodage miniature échoué", "key", key, "size", sizePx, "err", err.Error())
			}
			continue
		}
		if _, err := m.Upload(ctx, prefix, thumbName, &buf, int64(buf.Len()), thumbContentType); err != nil {
			return fmt.Errorf("upload miniature %s: %w", thumbName, err)
		}
	}
	return nil
}

// Delete retire un objet MinIO à partir de son URL publique HTTPS (celle
// renvoyée par Upload) — reconstruit la clé S3 en retirant le préfixe
// baseURL, symétrique de la construction faite dans Upload.
func (m *Media) Delete(ctx context.Context, publicURL string) error {
	key := strings.TrimPrefix(publicURL, m.baseURL+"/")
	if key == publicURL {
		return fmt.Errorf("URL %q ne correspond pas au baseURL configuré (%q)", publicURL, m.baseURL)
	}
	return m.client.RemoveObject(ctx, m.bucket, key, minio.RemoveObjectOptions{})
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
	initSentry(service)
	// Vide le buffer Sentry à l'arrêt (les events sont envoyés en asynchrone).
	defer func() {
		if sentryEnabled {
			sentry.Flush(2 * time.Second)
		}
	}()

	mux := http.NewServeMux()
	register(mux)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		JSON(w, 200, map[string]string{"service": service, "status": "ok"})
	})
	mux.HandleFunc("GET /system-check", h.Handler(service))

	// Chaîne : recover (attrape les panics) → guard (détection/blocage
	// des abus, no-op si UseGuard n'a pas été appelé) → log → mux.
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           withRecover(guardMiddleware(withLog(log, mux))),
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
				// Remonte la panique dans Sentry AVANT de répondre — avec
				// la méthode et le chemin pour la reproduire.
				if sentryEnabled {
					sentry.WithScope(func(scope *sentry.Scope) {
						scope.SetTag("http.method", r.Method)
						scope.SetTag("http.path", r.URL.Path)
						scope.SetLevel(sentry.LevelFatal)
						sentry.CurrentHub().Recover(rec)
					})
					sentry.Flush(2 * time.Second)
				}
				Fail(w, 500, "internal_error", fmt.Sprintf("panique serveur: %v", rec))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

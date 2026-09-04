// ============================================================
// admin-svc — console d'administration + API agrégée.
// L'interface (webui/, React + Vite) est EMBARQUÉE dans le binaire Go
// (go:embed du dossier webui/dist, généré par `npm run build` — voir
// webui/README ou le Dockerfile pour l'étape de build). Toute route
// /admin/api/* exige un JWT role=admin (émis par auth-svc).
// admin-svc ne possède aucune donnée : il interroge les autres
// services par HTTP (gRPC après codegen) et agrège la réponse.
// ============================================================
package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"

	"github.com/miadmarket/miad-backend/internal/kit"
)

// admin_action_log est la seule donnée qu'admin-svc possède réellement
// (tout le reste est agrégé depuis les autres services par HTTP) — d'où
// une base dédiée juste pour ça, contrairement au reste du fichier qui ne
// fait que relayer.
const schema = `
CREATE TABLE IF NOT EXISTS admin_action_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT, actor_email TEXT, actor_role TEXT,
  action TEXT NOT NULL, endpoint TEXT NOT NULL,
  status TEXT NOT NULL, wp_status INT,
  ip TEXT DEFAULT '', country TEXT DEFAULT '', user_agent TEXT DEFAULT '',
  metadata TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_log_created ON admin_action_log (created_at DESC);

-- Médiathèque : MinIO n'est qu'un stockage brut sans registre — cette
-- table est la seule source de métadonnées (nom, dossier, taille, type),
-- alimentée par uploadMedia à chaque upload.
CREATE TABLE IF NOT EXISTS media_files (
  id BIGSERIAL PRIMARY KEY,
  filename TEXT NOT NULL,
  url TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT 'products',
  size_bytes BIGINT NOT NULL DEFAULT 0,
  content_type TEXT DEFAULT '',
  uploaded_by TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_folder ON media_files (folder);
CREATE INDEX IF NOT EXISTS idx_media_created ON media_files (created_at DESC);

-- Guard : IP déjà vues pour un compte admin donné. Sert à la règle
-- "admin_new_ip" (alerte quand un JWT admin arrive depuis une IP
-- jamais enregistrée pour ce compte). Une ligne par (compte, IP) ;
-- last_seen mis à jour à chaque requête admin authentifiée.
CREATE TABLE IF NOT EXISTS admin_ip_seen (
  account_id  TEXT        NOT NULL,
  ip          TEXT        NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, ip)
);

-- Suivi d'erreurs frontend maison (2026-09-03) — remplace Sentry côté
-- navigateur, incompatible avec le pipeline @cloudflare/next-on-pages de
-- ce projet (voir frontend/next.config.mjs, tenté puis abandonné deux
-- fois : @sentry/nextjs a cassé 16 déploiements le 2026-08-29, @sentry/
-- cloudflare cassait le site entier faute d'API compatible avec un
-- middleware Next.js). app/global-error.tsx (frontend) poste ici chaque
-- crash React attrapé, plutôt qu'un simple console.error invisible.
CREATE TABLE IF NOT EXISTS client_error_log (
  id BIGSERIAL PRIMARY KEY,
  message TEXT NOT NULL,
  stack TEXT DEFAULT '',
  digest TEXT DEFAULT '',
  url TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  user_id TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_error_created ON client_error_log (created_at DESC);
-- type distingue les crashs JS ('js_error', valeur par défaut — table déjà
-- en place avant cette colonne) des échecs de chargement d'image
-- ('image_error', ajouté depuis LazyImage.tsx quand une image épuise son
-- retry miniature→originale) — demandé le 2026-09-03 après le fix
-- popstate, pour que la page "Erreurs du site" remonte aussi les images
-- cassées/lentes, pas seulement les crashs React.
ALTER TABLE client_error_log ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'js_error';
CREATE INDEX IF NOT EXISTS idx_client_error_type ON client_error_log (type);
`

//go:embed webui/dist
var webuiFS embed.FS

// webuiStatic — sous-arbre webui/dist (sans le préfixe "webui/dist" que
// go:embed conserve autrement dans les chemins), pour servir directement
// depuis la racine attendue par http.FileServer.
var webuiStatic, _ = fs.Sub(webuiFS, "webui/dist")

type server struct {
	db              *pgxpool.Pool
	redis           *goredis.Client
	jwtSec          []byte
	catalogURL      string
	vendorURL       string
	orderURL        string
	paymentURL      string
	shippingURL     string
	authURL         string
	notificationURL string
	emailURL        string
	fulfillmentURL  string
	loyaltyURL      string
	media           *kit.Media
	guard           *kit.Guard

	settings *kit.SettingsStore
	// jwtSecretStr : voir jwtSec ci-dessus — ATTENTION partagé avec
	// auth-svc, même remarque de synchronisation manuelle. Les 5 champs
	// MinIO/média ci-dessous sont éditables mais NÉCESSITENT UN
	// REDÉMARRAGE : kit.NewMedia() construit un client déjà connecté au
	// démarrage (comme le client FCM de notification-svc), pas relu à
	// chaque requête.
	jwtSecretStr    string
	minioEndpoint   string
	minioRootUser   string
	minioRootPass   string
	minioBucket     string
	mediaBaseURLStr string
	// Marketing / tracking publicitaire — lus par le frontend via
	// GET /admin/api/marketing-config (public, non authentifié : le pixel
	// ID n'est pas un secret). Le token CAPI, lui, est secret et n'est
	// JAMAIS renvoyé par cet endpoint (voir marketingConfigPublic).
	metaPixelIDStr   string
	metaCapiTokenStr string
	gaMeasurementID  string
}

func (s *server) settingsFields() []kit.SettingsField {
	return []kit.SettingsField{
		{Key: "jwt_secret", Ptr: &s.jwtSecretStr, Secret: true, Description: "Clé de signature des JWT — ATTENTION : partagée avec auth-svc (même variable), les deux doivent rester identiques manuellement"},
		{Key: "minio_endpoint", Ptr: &s.minioEndpoint, Description: "Endpoint du serveur MinIO/S3 (stockage média) — un redémarrage du service est nécessaire après modification"},
		{Key: "minio_root_user", Ptr: &s.minioRootUser, Secret: true, Description: "Identifiant utilisateur root MinIO — un redémarrage du service est nécessaire après modification"},
		{Key: "minio_root_password", Ptr: &s.minioRootPass, Secret: true, Description: "Mot de passe root MinIO — un redémarrage du service est nécessaire après modification"},
		{Key: "minio_bucket", Ptr: &s.minioBucket, Description: "Nom du bucket S3/MinIO utilisé pour stocker les médias — un redémarrage du service est nécessaire après modification"},
		{Key: "media_base_url", Ptr: &s.mediaBaseURLStr, Description: "URL publique de base servie pour les médias uploadés (CDN devant MinIO) — un redémarrage du service est nécessaire après modification"},
		{Key: "meta_pixel_id", Ptr: &s.metaPixelIDStr, Description: "ID du Pixel Meta (Facebook/Instagram) — chiffres uniquement. Injecté côté frontend au runtime, modifiable à chaud."},
		{Key: "meta_capi_token", Ptr: &s.metaCapiTokenStr, Secret: true, Description: "Token de la Conversions API Meta (Events Manager → Paramètres → Générer un token d'accès). Utilisé serveur-à-serveur, jamais exposé au navigateur."},
		{Key: "ga_measurement_id", Ptr: &s.gaMeasurementID, Description: "ID de mesure Google Analytics 4 (format G-XXXXXXXXXX). Optionnel."},
	}
}

const settingsTable = "admin_settings"

func main() {
	ctx := context.Background()
	log := kit.Logger("admin-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_ADMIN", "postgres://miad:miad@postgres:5432/miad_admin?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema+kit.SettingsStoreSchema(settingsTable)+kit.GuardSchema); err != nil {
		log.Error("migration du schéma impossible", "err", err)
		return
	}

	s := &server{
		db:              db,
		redis:           kit.NewRedis(kit.Env("REDIS_ADDR", "redis:6379"), kit.Env("REDIS_PASSWORD", "")),
		catalogURL:      kit.Env("CATALOG_SVC_URL", "http://catalog-svc:8081"),
		vendorURL:       kit.Env("VENDOR_SVC_URL", "http://vendor-svc:8082"),
		orderURL:        kit.Env("ORDER_SVC_URL", "http://order-svc:8083"),
		paymentURL:      kit.Env("PAYMENT_SVC_URL", "http://payment-svc:8084"),
		shippingURL:     kit.Env("SHIPPING_SVC_URL", "http://shipping-svc:8085"),
		authURL:         kit.Env("AUTH_SVC_URL", "http://auth-svc:8086"),
		notificationURL: kit.Env("NOTIFICATION_SVC_URL", "http://notification-svc:8087"),
		emailURL:        kit.Env("EMAIL_SVC_URL", "http://email-svc:8089"),
		fulfillmentURL:  kit.Env("FULFILLMENT_SVC_URL", "http://fulfillment-svc:8090"),
		loyaltyURL:      kit.Env("LOYALTY_SVC_URL", "http://loyalty-svc:8091"),

		jwtSecretStr:     kit.Env("JWT_SECRET", "change-me"),
		minioEndpoint:    kit.Env("MINIO_ENDPOINT", "minio:9000"),
		minioRootUser:    kit.Env("MINIO_ROOT_USER", ""),
		minioRootPass:    kit.Env("MINIO_ROOT_PASSWORD", ""),
		minioBucket:      kit.Env("MINIO_BUCKET", "miad-media"),
		mediaBaseURLStr:  kit.Env("MEDIA_BASE_URL", "https://img.miadmarket.ca"),
		metaPixelIDStr:   kit.Env("META_PIXEL_ID", ""),
		metaCapiTokenStr: kit.Env("META_CAPI_TOKEN", ""),
		gaMeasurementID:  kit.Env("GA_MEASUREMENT_ID", ""),
	}
	s.settings = kit.NewSettingsStore(db, settingsTable, s.settingsFields())
	if err := s.settings.Load(ctx); err != nil {
		log.Error("chargement admin_settings impossible", "err", err)
	}
	s.jwtSec = []byte(s.jwtSecretStr)

	media, err := kit.NewMedia(s.minioEndpoint, s.minioRootUser, s.minioRootPass, s.minioBucket, s.mediaBaseURLStr)
	if err != nil {
		log.Error("client minio indisponible — upload d'images désactivé", "err", err)
	}
	s.media = media

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	health.Add("redis", func(ctx context.Context) error { return s.redis.Ping(ctx).Err() })
	for name, url := range s.allServiceURLs() {
		u := url
		health.Add(name, func(ctx context.Context) error { return ping(ctx, u+"/healthz") })
	}

	// Guard — détection + blocage automatique des comportements suspects
	// (audit sécurité 2026-09-03). admin-svc héberge le journal partagé
	// (table security_events dans miad_admin) et route les alertes vers
	// email-svc + loyalty-svc/WhatsApp selon la gravité. Les autres
	// services ont leur PROPRE guard sur LEUR base ; la console lit tous
	// les journaux via le fan-out /admin/api/security/events.
	s.guard = kit.NewGuard(kit.GuardConfig{
		Svc:        "admin-svc",
		DB:         db,
		Log:        log,
		Rules:      kit.DefaultRules(),
		TrustProxy: kit.Env("GUARD_TRUST_PROXY", "1") == "1",
		Alert:      s.dispatchSecurityAlert,
	})
	kit.UseGuard(s.guard)

	kit.Run("admin-svc", kit.Env("PORT_ADMIN", "8088"), log, health, func(mux *http.ServeMux) {
		// Configuration Système (page admin) : ses propres réglages, plus
		// un proxy vers /settings de chaque autre service qui en a
		// (payment-svc, order-svc, auth-svc, notification-svc, email-svc).
		// fulfillment-svc a déjà sa propre page dédiée "Configuration DHL"
		// (voir /admin/api/dhl/settings), pas dupliqué ici.
		mux.HandleFunc("GET /admin/api/settings", s.requireAdmin(s.getLocalSettings))
		mux.HandleFunc("PUT /admin/api/settings", s.requireAdmin(s.putLocalSettings))
		// Config marketing PUBLIQUE (pas de requireAdmin) : le frontend
		// l'appelle au runtime pour injecter le Pixel Meta / GA. Ne renvoie
		// QUE les identifiants non sensibles (pixel id, GA id) — jamais le
		// token CAPI. Le frontend la proxifie via /api/marketing-config.
		mux.HandleFunc("GET /admin/api/marketing-config", s.marketingConfigPublic)
		// Conversions API Meta — relais serveur-à-serveur. Le frontend
		// (route /api/meta/capi) POST ici avec le secret interne ; admin-svc
		// ajoute le token CAPI stocké et transmet à graph.facebook.com. Le
		// token ne quitte jamais ce service.
		mux.HandleFunc("POST /admin/api/meta/capi", s.metaCapiForward)
		mux.HandleFunc("GET /admin/api/settings/{service}", s.requireAdmin(s.proxySettingsGet))
		mux.HandleFunc("PUT /admin/api/settings/{service}", s.requireAdmin(s.proxySettingsPut))
		mux.HandleFunc("GET /admin/api/overview", s.requireAdmin(s.overview))
		mux.HandleFunc("GET /admin/api/orders", s.requireAdmin(s.proxy(func() string { return s.orderURL + "/orders" })))
		mux.HandleFunc("GET /admin/api/orders/{id}", s.requireAdminOrRep(s.proxyPath(func(id string) string {
			return s.orderURL + "/orders/" + id
		})))
		// Vue agrégée "commande unique" (voir order-svc/getParentOrder) —
		// l'id ici est un parent_order_id, pas un id de sous-commande.
		mux.HandleFunc("GET /admin/api/orders/parent/{id}", s.requireAdminOrRep(s.proxyPath(func(id string) string {
			return s.orderURL + "/orders/parent/" + id
		})))
		mux.HandleFunc("PUT /admin/api/orders/{id}/status", s.requireAdminOrRep(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPut, s.orderURL+"/orders/"+r.PathValue("id")+"/status")
		}))
		// Renommé order-events (au lieu de orders/{id}/events) : net/http
		// refuse d'enregistrer ce pattern à côté de orders/parent/{id} — ni
		// l'un ni l'autre n'a de préfixe littéral qui les départage sans
		// ambiguïté (panic constaté au démarrage avant ce renommage).
		mux.HandleFunc("GET /admin/api/order-events/{id}", s.requireAdminOrRep(s.proxyPath(func(id string) string {
			return s.orderURL + "/order-events/" + id
		})))
		mux.HandleFunc("POST /admin/api/orders/{id}/cancel", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.orderURL+"/orders/"+r.PathValue("id")+"/cancel")
		}))
		mux.HandleFunc("GET /admin/api/returns", s.requireAdmin(s.proxy(func() string { return s.orderURL + "/returns" })))
		mux.HandleFunc("POST /admin/api/emails/broadcast", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.emailURL+"/emails/broadcast")
		}))
		mux.HandleFunc("PATCH /admin/api/returns/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPatch, s.orderURL+"/returns/"+r.PathValue("id"))
		}))
		// Documents (module Commandes §1.5). Renommés order-invoice/order-packing-slip
		// (au lieu de orders/{id}/invoice) : même conflit net/http déjà rencontré
		// avec orders/{id}/events vs orders/parent/{id} — "GET /orders/{id}/invoice"
		// et "GET /orders/parent/{id}" matchent tous deux "/orders/parent/invoice"
		// sans qu'aucun des deux ne soit plus spécifique (panic constaté au test).
		mux.HandleFunc("GET /admin/api/order-invoice/{id}", s.requireAdmin(s.proxyPath(func(id string) string {
			return s.orderURL + "/order-invoice/" + id
		})))
		mux.HandleFunc("GET /admin/api/order-packing-slip/{id}", s.requireAdmin(s.proxyPath(func(id string) string {
			return s.orderURL + "/order-packing-slip/" + id
		})))
		mux.HandleFunc("GET /admin/api/products", s.requireAdmin(s.proxy(func() string { return s.catalogURL + "/products?admin=true" })))
		mux.HandleFunc("GET /admin/api/products/{id}", s.requireAdmin(s.proxyPath(func(id string) string {
			return s.catalogURL + "/products/" + id
		})))
		mux.HandleFunc("PATCH /admin/api/products/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPatch, s.catalogURL+"/products/"+r.PathValue("id"))
		}))
		mux.HandleFunc("DELETE /admin/api/products/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodDelete, s.catalogURL+"/products/"+r.PathValue("id"))
		}))
		mux.HandleFunc("POST /admin/api/products/bulk", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.catalogURL+"/products/bulk")
		}))
		mux.HandleFunc("POST /admin/api/products", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.catalogURL+"/vendor/products")
		}))
		// Variations produit (module Catalogue) : catalog-svc les gère déjà
		// intégralement (utilisé par le dashboard vendeur Next.js) — ce trou
		// n'existait que côté proxy admin, jamais construit.
		mux.HandleFunc("POST /admin/api/products/{id}/variations", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.catalogURL+"/products/"+r.PathValue("id")+"/variations")
		}))
		// Backfill des pointures sur les produits chaussures existants
		// (catalog-svc POST /admin/backfill-shoe-sizes). ?dry_run=true &
		// ?category_id=N transmis tels quels.
		mux.HandleFunc("POST /admin/api/catalog/backfill-shoe-sizes", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			target := s.catalogURL + "/admin/backfill-shoe-sizes"
			if q := r.URL.RawQuery; q != "" {
				target += "?" + q
			}
			forwardWithBody(w, r, http.MethodPost, target)
		}))
		// Backfill des tailles S→XXXL sur les vêtements homme/femme existants.
		mux.HandleFunc("POST /admin/api/catalog/backfill-clothing-sizes", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			target := s.catalogURL + "/admin/backfill-clothing-sizes"
			if q := r.URL.RawQuery; q != "" {
				target += "?" + q
			}
			forwardWithBody(w, r, http.MethodPost, target)
		}))
		// Répare les produits "faux variables" (1 seule variation) — les
		// repasse en produit simple. catalog-svc POST /admin/collapse-fake-variables.
		mux.HandleFunc("POST /admin/api/catalog/collapse-fake-variables", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			target := s.catalogURL + "/admin/collapse-fake-variables"
			if q := r.URL.RawQuery; q != "" {
				target += "?" + q
			}
			forwardWithBody(w, r, http.MethodPost, target)
		}))
		mux.HandleFunc("PUT /admin/api/products/{id}/variations/{variation_id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPut, s.catalogURL+"/products/"+r.PathValue("id")+"/variations/"+r.PathValue("variation_id"))
		}))
		mux.HandleFunc("DELETE /admin/api/products/{id}/variations/{variation_id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodDelete, s.catalogURL+"/products/"+r.PathValue("id")+"/variations/"+r.PathValue("variation_id"))
		}))
		// Modération produit vendeur (require_moderation) — GET /admin/api/products?status=pending_review
		// existant suffit pour la liste (déjà filtrable), seul PATCH .../moderate manquait.
		mux.HandleFunc("PATCH /admin/api/products/{id}/moderate", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPatch, s.catalogURL+"/products/"+r.PathValue("id")+"/moderate")
		}))
		mux.HandleFunc("GET /admin/api/reviews", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			target := s.catalogURL + "/reviews"
			if q := r.URL.RawQuery; q != "" {
				target += "?" + q
			}
			forwardWithBody(w, r, http.MethodGet, target)
		}))
		mux.HandleFunc("PATCH /admin/api/reviews/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPatch, s.catalogURL+"/reviews/"+r.PathValue("id"))
		}))
		// Seed d'avis "de la communauté" sur un produit (recommandations).
		mux.HandleFunc("POST /admin/api/reviews/seed", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.catalogURL+"/admin/reviews/seed")
		}))
		// Seed d'avis "de la communauté" sur tout le catalogue en un appel
		// (2-5 avis/produit, moyenne ~4,3). Accepte dry_run pour prévisualiser.
		mux.HandleFunc("POST /admin/api/reviews/seed-catalog", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.catalogURL+"/admin/reviews/seed-catalog")
		}))
		// Ajout d'un avis à la main depuis le back-office (nom, pays, note,
		// texte, photo). Publié directement, marqué "Avis de la communauté".
		mux.HandleFunc("POST /admin/api/reviews/manual", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.catalogURL+"/admin/reviews/manual")
		}))
		mux.HandleFunc("GET /admin/api/brands", s.requireAdmin(s.proxy(func() string { return s.catalogURL + "/brands" })))
		mux.HandleFunc("POST /admin/api/brands", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.catalogURL+"/brands")
		}))
		mux.HandleFunc("PATCH /admin/api/brands/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPatch, s.catalogURL+"/brands/"+r.PathValue("id"))
		}))
		mux.HandleFunc("DELETE /admin/api/brands/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodDelete, s.catalogURL+"/brands/"+r.PathValue("id"))
		}))
		mux.HandleFunc("GET /admin/api/categories", s.requireAdmin(s.proxy(func() string { return s.catalogURL + "/categories" })))
		mux.HandleFunc("POST /admin/api/categories", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.catalogURL+"/categories")
		}))
		mux.HandleFunc("PATCH /admin/api/categories/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPatch, s.catalogURL+"/categories/"+r.PathValue("id"))
		}))
		mux.HandleFunc("DELETE /admin/api/categories/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodDelete, s.catalogURL+"/categories/"+r.PathValue("id"))
		}))
		mux.HandleFunc("POST /admin/api/categories/reorder", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.catalogURL+"/categories/reorder")
		}))
		mux.HandleFunc("GET /admin/api/attributes", s.requireAdmin(s.proxy(func() string { return s.catalogURL + "/attributes" })))
		mux.HandleFunc("POST /admin/api/attributes", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.catalogURL+"/attributes")
		}))
		mux.HandleFunc("DELETE /admin/api/attributes/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodDelete, s.catalogURL+"/attributes/"+r.PathValue("id"))
		}))
		mux.HandleFunc("POST /admin/api/attributes/{id}/values", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.catalogURL+"/attributes/"+r.PathValue("id")+"/values")
		}))
		mux.HandleFunc("DELETE /admin/api/attribute-values/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodDelete, s.catalogURL+"/attribute-values/"+r.PathValue("id"))
		}))
		mux.HandleFunc("GET /admin/api/vendors", s.requireAdmin(s.proxy(func() string { return s.vendorURL + "/vendors" })))
		mux.HandleFunc("GET /admin/api/vendors/{id}", s.requireAdmin(s.proxyPath(func(id string) string {
			return s.vendorURL + "/vendors/" + id
		})))
		mux.HandleFunc("POST /admin/api/vendors", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.vendorURL+"/vendors")
		}))
		mux.HandleFunc("PATCH /admin/api/vendors/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPatch, s.vendorURL+"/vendors/"+r.PathValue("id"))
		}))
		mux.HandleFunc("POST /admin/api/vendors/{id}/kyc/approve", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.vendorURL+"/vendors/"+r.PathValue("id")+"/kyc/approve")
		}))
		mux.HandleFunc("POST /admin/api/vendors/{id}/kyc/reject", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.vendorURL+"/vendors/"+r.PathValue("id")+"/kyc/reject")
		}))
		mux.HandleFunc("POST /admin/api/vendors/{id}/impersonate", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.authURL+"/auth/impersonate-vendor/"+r.PathValue("id"))
		}))
		mux.HandleFunc("GET /admin/api/vendors/{id}/wallet", s.requireAdmin(s.proxyPath(func(id string) string {
			return s.paymentURL + "/wallet/" + id
		})))
		mux.HandleFunc("GET /admin/api/vendors/{id}/wallet/transactions", s.requireAdmin(s.proxyPath(func(id string) string {
			return s.paymentURL + "/wallet/" + id + "/transactions"
		})))
		mux.HandleFunc("GET /admin/api/payout-requests", s.requireAdmin(s.proxy(func() string { return s.paymentURL + "/payout-requests" })))
		mux.HandleFunc("POST /admin/api/payout-requests/{id}/approve", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			// guard : pic d'approbations de virement par un même admin
			// (compte de la compromission d'un compte admin). Clé =
			// identifiant de l'admin issu du JWT.
			if claims, err := s.verifyJWT(r); err == nil {
				kit.Note(r, "payout_burst", fmt.Sprint(claims["sub"]))
			}
			forwardWithBody(w, r, http.MethodPost, s.paymentURL+"/payout-requests/"+r.PathValue("id")+"/approve")
		}))
		mux.HandleFunc("POST /admin/api/payout-requests/{id}/reject", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.paymentURL+"/payout-requests/"+r.PathValue("id")+"/reject")
		}))
		mux.HandleFunc("GET /admin/api/customers", s.requireAdmin(s.proxyAuth(func() string { return s.authURL + "/customers" })))
		mux.HandleFunc("GET /admin/api/customer/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, s.authURL+"/customer/"+r.PathValue("id"), nil)
			if err != nil {
				kit.Fail(w, 500, "upstream_request_error", err.Error())
				return
			}
			req.Header.Set("Authorization", r.Header.Get("Authorization"))
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				kit.Fail(w, 502, "upstream_unreachable", err.Error())
				return
			}
			defer resp.Body.Close()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(resp.StatusCode)
			_, _ = io.Copy(w, resp.Body)
		}))
		// Module Utilisateurs : vue unifiée boutiques/clients/admins.
		mux.HandleFunc("GET /admin/api/admins", s.requireAdmin(s.proxyAuth(func() string { return s.authURL + "/admins" })))
		mux.HandleFunc("POST /admin/api/admins", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.authURL+"/admins")
		}))
		mux.HandleFunc("PATCH /admin/api/admins/{id}/active", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPatch, s.authURL+"/admins/"+r.PathValue("id")+"/active")
		}))
		mux.HandleFunc("PATCH /admin/api/admins/{id}/role", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPatch, s.authURL+"/admins/"+r.PathValue("id")+"/role")
		}))
		mux.HandleFunc("POST /admin/api/admins/{id}/revoke-sessions", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.authURL+"/auth/admin/"+r.PathValue("id")+"/revoke-sessions")
		}))
		mux.HandleFunc("GET /admin/api/admin-roles", s.requireAdmin(s.proxyAuth(func() string { return s.authURL + "/admin-roles" })))
		mux.HandleFunc("POST /admin/api/admin-roles", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.authURL+"/admin-roles")
		}))
		mux.HandleFunc("PATCH /admin/api/admin-roles/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPatch, s.authURL+"/admin-roles/"+r.PathValue("id"))
		}))
		mux.HandleFunc("DELETE /admin/api/admin-roles/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodDelete, s.authURL+"/admin-roles/"+r.PathValue("id"))
		}))
		mux.HandleFunc("GET /admin/api/users", s.requireAdmin(s.listUnifiedUsers))
		mux.HandleFunc("GET /admin/api/representatives", s.requireAdmin(s.proxyAuth(func() string { return s.loyaltyURL + "/representatives" })))
		mux.HandleFunc("GET /admin/api/payments", s.requireAdmin(s.proxy(func() string { return s.paymentURL + "/payments" })))
		// Écran Mobile Money — routage manuel PawaPay ⇄ PayDunya par
		// pays/opérateur (2026-08-28, PaymentRouting.tsx).
		mux.HandleFunc("GET /admin/api/payments/routing", s.requireAdmin(s.proxy(func() string { return s.paymentURL + "/payments/routing" })))
		mux.HandleFunc("PUT /admin/api/payments/routing", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPut, s.paymentURL+"/payments/routing")
		}))
		mux.HandleFunc("DELETE /admin/api/payments/routing", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodDelete, s.paymentURL+"/payments/routing")
		}))
		mux.HandleFunc("PUT /admin/api/payments/operator-enabled", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPut, s.paymentURL+"/payments/operator-enabled")
		}))
		mux.HandleFunc("PUT /admin/api/payments/country-enabled", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPut, s.paymentURL+"/payments/country-enabled")
		}))
		mux.HandleFunc("GET /admin/api/finance/overview", s.requireAdmin(s.proxy(func() string { return s.paymentURL + "/finance/overview" })))
		mux.HandleFunc("GET /admin/api/finance/transactions", s.requireAdmin(s.proxy(func() string { return s.paymentURL + "/finance/transactions" })))
		mux.HandleFunc("GET /admin/api/finance/gateways", s.requireAdmin(s.proxy(func() string { return s.paymentURL + "/payment-methods" })))
		mux.HandleFunc("GET /admin/api/shipping-quote", s.requireAdmin(s.proxy(func() string { return s.shippingURL + "/shipping-rates/quote" })))
		// Config livraison unifiée (tarifs par zone standard/express, tarif
		// local, seuil livraison gratuite, repli national) — page Livraison
		// du back-office. Source unique consommée aussi par le frontend via
		// /api/shipping-rates -> shipping-svc /shipping/config.
		mux.HandleFunc("GET /admin/api/shipping-config", s.requireAdmin(s.proxy(func() string { return s.shippingURL + "/shipping/config" })))
		mux.HandleFunc("POST /admin/api/shipping-config", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.shippingURL+"/shipping/config")
		}))
		mux.HandleFunc("DELETE /admin/api/domestic-tiers/{id}", s.requireAdmin(s.proxyPath(func(id string) string {
			return s.shippingURL + "/shipping-domestic/tiers/" + id
		})))
		// Livraison nationale Sénégal — adresses d'expédition vendeur (carte
		// admin des boutiques) + grille tarifaire par distance.
		mux.HandleFunc("GET /admin/api/vendor-shipping-addresses", s.requireAdmin(s.proxy(func() string { return s.shippingURL + "/vendor-shipping-addresses" })))
		mux.HandleFunc("POST /admin/api/vendor-shipping-address", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.shippingURL+"/vendor-shipping-address")
		}))
		mux.HandleFunc("GET /admin/api/domestic-tiers", s.requireAdmin(s.proxy(func() string { return s.shippingURL + "/shipping-domestic/tiers" })))
		mux.HandleFunc("POST /admin/api/domestic-tiers", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.shippingURL+"/shipping-domestic/tiers")
		}))
		// Taux de change — source UNIQUE (voir shipping-svc, table
		// exchange_rates), rafraîchie automatiquement chaque jour ET
		// modifiable manuellement ici. Page Devises du back-office (2026-09-03).
		// Consommée aussi par le frontend public via /api/exchange-rates ->
		// shipping-svc GET /exchange-rates (même endpoint, sans auth admin).
		mux.HandleFunc("GET /admin/api/exchange-rates", s.requireAdmin(s.proxy(func() string { return s.shippingURL + "/exchange-rates" })))
		mux.HandleFunc("POST /admin/api/exchange-rates", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.shippingURL+"/exchange-rates")
		}))
		// Suivi d'erreurs frontend maison — POST protégé par secret interne
		// (jamais le JWT admin : appelé par le serveur Next.js pour le
		// compte de n'importe quel visiteur, pas seulement les admins),
		// GET protégé par requireAdmin (page back-office "Erreurs du site").
		mux.HandleFunc("POST /admin/api/log-client-error", s.clientErrorWrite)
		mux.HandleFunc("GET /admin/api/client-errors", s.requireAdmin(s.listClientErrors))
		mux.HandleFunc("GET /admin/api/shipments", s.requireAdmin(s.proxy(func() string { return s.fulfillmentURL + "/shipments" })))
		mux.HandleFunc("GET /admin/api/coins/leaderboard", s.requireAdmin(s.proxy(func() string { return s.loyaltyURL + "/coins/leaderboard" })))
		// Coupons — page Marketing du back-office (CRUD via loyalty-svc).
		mux.HandleFunc("GET /admin/api/coupons", s.requireAdmin(s.proxy(func() string { return s.loyaltyURL + "/coupons" })))
		mux.HandleFunc("POST /admin/api/coupons", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.loyaltyURL+"/coupons")
		}))
		mux.HandleFunc("DELETE /admin/api/coupons/{code}", s.requireAdmin(s.proxyPath(func(code string) string {
			return s.loyaltyURL + "/coupons/" + code
		})))
		mux.HandleFunc("GET /admin/api/representative/messages", s.requireAdminOrRep(s.proxy(func() string { return s.loyaltyURL + "/representative/messages" })))
		mux.HandleFunc("POST /admin/api/representative/messages/{id}/reply", s.requireAdminOrRep(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.loyaltyURL+"/representative/messages/"+r.PathValue("id")+"/reply")
		}))
		mux.HandleFunc("PATCH /admin/api/representative/messages/{id}", s.requireAdminOrRep(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPatch, s.loyaltyURL+"/representative/messages/"+r.PathValue("id"))
		}))
		mux.HandleFunc("POST /admin/api/representative/orders/{id}/acknowledge", s.requireAdminOrRep(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.loyaltyURL+"/representative/orders/"+r.PathValue("id")+"/acknowledge")
		}))
		mux.HandleFunc("GET /admin/api/whatsapp/logs", s.requireAdmin(s.proxy(func() string { return s.loyaltyURL + "/whatsapp/logs" })))
		mux.HandleFunc("POST /admin/api/whatsapp/resend/{order_id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.loyaltyURL+"/whatsapp/resend/"+r.PathValue("order_id"))
		}))
		mux.HandleFunc("GET /admin/api/system", s.requireAdmin(s.systemCheck))

		// Journal de sécurité (guard) — page /admin/security de la console.
		// events : agrège le journal LOCAL d'admin-svc + un fan-out sur
		// /internal/security-events de chaque autre service qui a un guard.
		// blocks : idem pour les IP bloquées. unblock/block : déblocage /
		// blocage manuel (n'agit que sur admin-svc ici — les autres
		// services rechargent leur cache depuis LEUR base ; une IP bloquée
		// dans plusieurs bases doit être débloquée dans chacune, listé
		// tel quel dans l'UI).
		mux.HandleFunc("GET /admin/api/security/events", s.requireAdmin(s.securityEvents))
		mux.HandleFunc("GET /admin/api/security/blocks", s.requireAdmin(s.securityBlocks))
		mux.HandleFunc("POST /admin/api/security/unblock", s.requireAdmin(s.securityUnblock))
		mux.HandleFunc("POST /admin/api/security/block", s.requireAdmin(s.securityBlockManual))
		// Endpoints internes (secret partagé) : les guards des AUTRES
		// services y poussent leurs événements / blocages et y lisent la
		// liste noire partagée. Jamais exposés via Caddy (/internal/* n'est
		// routé nulle part dans deploy/Caddyfile).
		mux.HandleFunc("POST /internal/security-events", s.internalSecurityEventWrite)
		mux.HandleFunc("POST /internal/security-block", s.internalSecurityBlockWrite)
		mux.HandleFunc("GET /internal/security-blocks", s.internalSecurityBlocksRead)
		mux.HandleFunc("GET /admin/api/push/stats", s.requireAdmin(s.proxy(func() string { return s.notificationURL + "/push/stats" })))
		mux.HandleFunc("POST /admin/api/push/broadcast", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.notificationURL+"/push/broadcast")
		}))
		mux.HandleFunc("POST /admin/api/media/upload", s.requireAdmin(s.uploadMedia))
		// Hors /admin/api/ : accessible à un vendeur authentifié (pas
		// seulement un admin) pour uploader une image produit — même
		// handler, même MinIO, contrôle d'accès différent.
		mux.HandleFunc("POST /media/upload", s.requireAdminOrVendor(s.uploadMedia))
		mux.HandleFunc("GET /admin/api/media", s.requireAdmin(s.listMedia))
		mux.HandleFunc("DELETE /admin/api/media/{id}", s.requireAdmin(s.deleteMedia))
		mux.HandleFunc("GET /admin/api/media/orphans", s.requireAdmin(s.findMediaOrphans))
		mux.HandleFunc("GET /admin/api/email-templates", s.requireAdmin(s.proxy(func() string { return s.emailURL + "/email-templates" })))
		mux.HandleFunc("GET /admin/api/email-templates/{name}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forward(w, r, s.emailURL+"/email-templates/"+r.PathValue("name"))
		}))
		mux.HandleFunc("PUT /admin/api/email-templates/{name}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPut, s.emailURL+"/email-templates/"+r.PathValue("name"))
		}))
		mux.HandleFunc("POST /admin/api/action-log", s.requireAdmin(s.logAction))
		mux.HandleFunc("GET /admin/api/action-log", s.requireAdmin(s.listActionLog))
		mux.HandleFunc("GET /admin/api/dhl/rate", s.requireAdmin(s.proxy(func() string { return s.fulfillmentURL + "/dhl/rate" })))
		mux.HandleFunc("POST /admin/api/dhl/create-shipment", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.fulfillmentURL+"/dhl/create-shipment")
		}))
		mux.HandleFunc("GET /admin/api/dhl/tracking/{tracking_number}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forward(w, r, s.fulfillmentURL+"/dhl/tracking/"+r.PathValue("tracking_number"))
		}))
		mux.HandleFunc("GET /admin/api/dhl/orders", s.requireAdmin(s.proxy(func() string { return s.fulfillmentURL + "/dhl/orders" })))
		mux.HandleFunc("GET /admin/api/dhl/order/{id}", s.requireAdmin(s.proxyPath(func(id string) string {
			return s.fulfillmentURL + "/dhl/order/" + id
		})))
		mux.HandleFunc("POST /admin/api/dhl/orders/{id}/create-shipment", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.fulfillmentURL+"/dhl/orders/"+r.PathValue("id")+"/create-shipment")
		}))

		// Configuration DHL — portage de l'onglet "Réglages" du plugin
		// WordPress (identifiants API, adresse expéditeur, codes HS,
		// boîtes personnalisées, tests & logs), voir fulfillment-svc.
		mux.HandleFunc("GET /admin/api/dhl/settings", s.requireAdmin(s.proxy(func() string { return s.fulfillmentURL + "/dhl/settings" })))
		mux.HandleFunc("PUT /admin/api/dhl/settings", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPut, s.fulfillmentURL+"/dhl/settings")
		}))
		mux.HandleFunc("POST /admin/api/dhl/settings/test-connection", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.fulfillmentURL+"/dhl/settings/test-connection")
		}))

		mux.HandleFunc("GET /admin/api/dhl/hs-codes", s.requireAdmin(s.proxy(func() string { return s.fulfillmentURL + "/dhl/hs-codes" })))
		mux.HandleFunc("POST /admin/api/dhl/hs-codes", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.fulfillmentURL+"/dhl/hs-codes")
		}))
		mux.HandleFunc("DELETE /admin/api/dhl/hs-codes/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodDelete, s.fulfillmentURL+"/dhl/hs-codes/"+r.PathValue("id"))
		}))

		mux.HandleFunc("GET /admin/api/dhl/boxes", s.requireAdmin(s.proxy(func() string { return s.fulfillmentURL + "/dhl/boxes" })))
		mux.HandleFunc("POST /admin/api/dhl/boxes", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.fulfillmentURL+"/dhl/boxes")
		}))
		mux.HandleFunc("DELETE /admin/api/dhl/boxes/{id}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodDelete, s.fulfillmentURL+"/dhl/boxes/"+r.PathValue("id"))
		}))

		mux.HandleFunc("GET /admin/api/dhl/tests", s.requireAdmin(s.proxy(func() string { return s.fulfillmentURL + "/dhl/tests" })))
		mux.HandleFunc("GET /admin/api/dhl/logs", s.requireAdmin(s.proxy(func() string { return s.fulfillmentURL + "/dhl/logs" })))
		mux.HandleFunc("DELETE /admin/api/dhl/logs", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodDelete, s.fulfillmentURL+"/dhl/logs")
		}))

		// Statut national (livraison Sénégal, 8 états — shipping-svc) et
		// international (DHL, 5 états — fulfillment-svc) : reprend les 2
		// anciennes routes WordPress /wp-json/miad/v1/shipping-domestic/order-stage
		// et /wp-json/miad-products/v1/order/set-stage, jamais migrées alors
		// que les identifiants MIAD_PRODUCTS_* avaient déjà été retirés de
		// Cloudflare Pages (routes cassées en production depuis).
		mux.HandleFunc("POST /admin/api/shipping-domestic/order-stage", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.shippingURL+"/shipping-domestic/order-stage")
		}))
		mux.HandleFunc("GET /admin/api/shipping-domestic/order-stage/{id}", s.requireAdmin(s.proxyPath(func(id string) string {
			return s.shippingURL + "/shipping-domestic/order-stage/" + id
		})))
		mux.HandleFunc("POST /admin/api/orders/set-stage", s.requireAdmin(s.dhlSetOrderStage))

		// SPA React : sert les assets embarqués, retombe sur index.html
		// pour toute route côté client (/admin/orders, /admin/security, …)
		// que React Router résout lui-même — dernier handler, jamais
		// derrière /admin/api/* qui est déjà capturé au-dessus.
		mux.Handle("GET /admin/", http.StripPrefix("/admin/", spaHandler{fs: webuiStatic}))
	})
}

// spaHandler — sert un fichier statique s'il existe dans webuiStatic,
// sinon retombe sur index.html (fallback SPA classique : React Router
// gère la route côté client une fois le bundle chargé).
type spaHandler struct{ fs fs.FS }

func (h spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	if f, err := h.fs.Open(path); err == nil {
		f.Close()
		http.FileServerFS(h.fs).ServeHTTP(w, r)
		return
	}
	index, err := fs.ReadFile(h.fs, "index.html")
	if err != nil {
		kit.Fail(w, 500, "webui_missing", "build webui/dist absent — voir Dockerfile")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(index)
}

func (s *server) allServiceURLs() map[string]string {
	return map[string]string{
		"catalog-svc": s.catalogURL, "vendor-svc": s.vendorURL, "order-svc": s.orderURL,
		"payment-svc": s.paymentURL, "shipping-svc": s.shippingURL, "auth-svc": s.authURL,
		"notification-svc": s.notificationURL, "email-svc": s.emailURL,
		"fulfillment-svc": s.fulfillmentURL, "loyalty-svc": s.loyaltyURL,
	}
}

// ---------- overview : compteurs + CA + état des services ----------

func (s *server) overview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	out := map[string]any{}

	if body, err := getJSON(ctx, s.orderURL+"/orders?page_size=1"); err == nil {
		out["orders_total"] = body["total"]
	} else {
		out["orders_error"] = err.Error()
	}
	if body, err := getJSON(ctx, s.catalogURL+"/products?page_size=1"); err == nil {
		out["products_total"] = body["total"]
	} else {
		out["products_error"] = err.Error()
	}
	if body, err := getJSON(ctx, s.vendorURL+"/stores?page_size=1"); err == nil {
		out["vendors_total"] = body["total"]
	} else {
		out["vendors_error"] = err.Error()
	}
	if body, err := getJSON(ctx, s.paymentURL+"/payments?page_size=1"); err == nil {
		out["payments_total"] = body["total"]
	} else {
		out["payments_error"] = err.Error()
	}

	statuses := map[string]string{}
	for name, url := range s.allServiceURLs() {
		if err := ping(ctx, url+"/healthz"); err != nil {
			statuses[name] = "down"
		} else {
			statuses[name] = "ok"
		}
	}
	out["services"] = statuses
	out["generated_at"] = time.Now().UTC().Format(time.RFC3339)
	kit.JSON(w, 200, out)
}

// listUnifiedUsers — module Utilisateurs (back-office) : un même compte
// n'est pas représenté par une seule table (contrairement au wp_users
// WordPress historique) — customers (client, +vendor_id si boutique),
// admins et representatives (loyalty-svc, table séparée par email) sont
// trois sources distinctes. On les fusionne ici par email pour que
// l'admin voie tous les rôles cumulés d'un compte sur UNE ligne (ex. un
// représentant qui est aussi client) plutôt que 3 lignes disjointes.
// customers sans email (compte téléphone seul) ne peuvent pas être
// croisés avec admins/representatives (les deux sont identifiés par
// email) — restent seuls sur leur ligne, rôle "customer" uniquement.
// dialCodeToCountry — indicatif téléphonique -> ISO alpha-2. Miroir de
// COUNTRY_DIAL_CODES (frontend/lib/shipping-utils.ts), inversé et
// restreint aux indicatifs non ambigus (ex. +1 partagé US/CA/etc. exclu
// volontairement — mieux vaut un tiret qu'un mauvais pays affiché). Triés
// du plus long au plus court à l'usage (countryFromPhone) pour que +221
// ne soit jamais confondu avec un préfixe plus court inexistant ici.
var dialCodeToCountry = map[string]string{
	"+221": "SN", "+229": "BJ", "+225": "CI", "+228": "TG", "+237": "CM", "+234": "NG",
	"+241": "GA", "+242": "CG", "+243": "CD", "+223": "ML", "+227": "NE", "+226": "BF",
	"+224": "GN", "+245": "GW", "+222": "MR", "+220": "GM", "+232": "SL", "+231": "LR",
	"+238": "CV", "+239": "ST", "+240": "GQ", "+235": "TD", "+236": "CF", "+213": "DZ",
	"+212": "MA", "+216": "TN", "+218": "LY", "+20": "EG", "+249": "SD", "+254": "KE",
	"+255": "TZ", "+256": "UG", "+250": "RW", "+257": "BI", "+251": "ET", "+27": "ZA",
	"+244": "AO", "+258": "MZ", "+260": "ZM", "+263": "ZW", "+264": "NA", "+265": "MW",
	"+33": "FR", "+32": "BE", "+49": "DE", "+31": "NL", "+39": "IT", "+34": "ES",
	"+44": "GB", "+351": "PT", "+41": "CH", "+352": "LU", "+971": "AE", "+966": "SA",
}

// countryFromPhone — dérive un pays depuis un numéro au format libre
// (+221771234567, 00221771234567, 221771234567…). Comparaison sur le
// préfixe normalisé, indicatifs à 3 chiffres testés avant ceux à 2 pour
// ne jamais faire correspondre +33x sur un +3xx à tort. Chaîne vide si
// aucune correspondance ou numéro absent — jamais un pays inventé.
func countryFromPhone(phone string) string {
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, phone)
	digits = strings.TrimPrefix(digits, "00")
	if digits == "" {
		return ""
	}
	for _, length := range []int{3, 2} {
		if len(digits) < length {
			continue
		}
		if cc, ok := dialCodeToCountry["+"+digits[:length]]; ok {
			return cc
		}
	}
	return ""
}

func (s *server) listUnifiedUsers(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	auth := r.Header.Get("Authorization")

	type row struct {
		Roles      []string
		Email      string
		Phone      string
		Name       string
		CreatedAt  string
		VendorID   any
		IsSuperRep bool
		Country    string
	}
	byEmail := map[string]*row{}
	noEmail := []map[string]any{}

	if body, err := getJSONAuth(ctx, s.authURL+"/customers?page_size=1000", auth); err == nil {
		if items, ok := body["items"].([]any); ok {
			for _, it := range items {
				c, _ := it.(map[string]any)
				email, _ := c["email"].(string)
				if email == "" {
					c["roles"] = []string{"customer"}
					noEmail = append(noEmail, c)
					continue
				}
				r := &row{Roles: []string{"customer"}, Email: email}
				r.Phone, _ = c["phone"].(string)
				r.Name, _ = c["full_name"].(string)
				r.CreatedAt, _ = c["created_at"].(string)
				// Pays déduit de l'indicatif téléphonique — customers n'a pas
				// de champ pays propre (l'adresse de livraison, si connue,
				// vit dans un JSON libre côté order-svc, pas ici). Colonne
				// PAYS systématiquement vide dans l'écran Utilisateurs
				// (revue UX 2026-09-02) : mieux vaut une estimation issue du
				// numéro qu'un tiret permanent.
				r.Country = countryFromPhone(r.Phone)
				if vid, ok := c["vendor_id"]; ok {
					r.VendorID = vid
					r.Roles = append(r.Roles, "vendor")
				}
				byEmail[strings.ToLower(email)] = r
			}
		}
	}
	if body, err := getJSONAuth(ctx, s.authURL+"/admins", auth); err == nil {
		if items, ok := body["items"].([]any); ok {
			for _, it := range items {
				a, _ := it.(map[string]any)
				email, _ := a["email"].(string)
				if email == "" {
					continue
				}
				key := strings.ToLower(email)
				existing, found := byEmail[key]
				if !found {
					existing = &row{Email: email}
					byEmail[key] = existing
					existing.CreatedAt, _ = a["created_at"].(string)
				}
				existing.Roles = append(existing.Roles, "admin")
			}
		}
	}
	if body, err := getJSONAuth(ctx, s.loyaltyURL+"/representatives", auth); err == nil {
		if items, ok := body["items"].([]any); ok {
			for _, it := range items {
				rep, _ := it.(map[string]any)
				email, _ := rep["email"].(string)
				if email == "" {
					continue
				}
				key := strings.ToLower(email)
				existing, found := byEmail[key]
				if !found {
					existing = &row{Email: email}
					byEmail[key] = existing
					existing.Name, _ = rep["name"].(string)
					existing.CreatedAt, _ = rep["created_at"].(string)
				}
				isSuper, _ := rep["is_super_rep"].(bool)
				if isSuper {
					existing.Roles = append(existing.Roles, "super_representative")
					existing.IsSuperRep = true
				} else {
					existing.Roles = append(existing.Roles, "representative")
				}
				existing.Country, _ = rep["country"].(string)
			}
		}
	}

	items := make([]map[string]any, 0, len(byEmail)+len(noEmail))
	for _, r := range byEmail {
		items = append(items, map[string]any{
			"email": r.Email, "phone": r.Phone, "name": r.Name,
			"roles": r.Roles, "vendor_id": r.VendorID, "country": r.Country,
			"created_at": r.CreatedAt,
		})
	}
	items = append(items, noEmail...)

	kit.JSON(w, 200, map[string]any{"items": items, "total": len(items)})
}

// getJSONAuth — comme getJSON, mais transmet le JWT admin de la requête
// entrante (les endpoints GET /customers, /admins, /representatives sont
// tous protégés par rôle admin côté service source).
func getJSONAuth(ctx context.Context, url, authHeader string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", authHeader)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body, nil
}

func (s *server) systemCheck(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	out := map[string]any{}
	overall := "ok"
	for name, url := range s.allServiceURLs() {
		body, err := getJSON(ctx, url+"/system-check")
		if err != nil {
			out[name] = map[string]string{"status": "down", "error": err.Error()}
			overall = "degraded"
			continue
		}
		out[name] = body
		if st, _ := body["status"].(string); st != "ok" {
			overall = "degraded"
		}
	}
	kit.JSON(w, 200, map[string]any{"status": overall, "services": out})
}

// ---------- proxies génériques ----------

// getLocalSettings/putLocalSettings — Configuration Système, réglages
// propres à admin-svc lui-même (JWT_SECRET, MinIO/média).
func (s *server) getLocalSettings(w http.ResponseWriter, r *http.Request) {
	kit.JSON(w, 200, s.settings.Snapshot())
}

// metaCapiForward — POST /admin/api/meta/capi. Relais serveur-à-serveur
// vers la Conversions API Meta. Le frontend (route Next /api/meta/capi)
// appelle ici avec l'en-tête X-Internal-Secret ; on ajoute le token CAPI
// stocké (jamais exposé au navigateur) et on transmet le corps tel quel à
// graph.facebook.com/v19.0/{pixel_id}/events.
func (s *server) metaCapiForward(w http.ResponseWriter, r *http.Request) {
	secret := kit.Env("INTERNAL_API_SECRET", "")
	if secret == "" || r.Header.Get("X-Internal-Secret") != secret {
		kit.Fail(w, 401, "unauthorized", "secret interne requis")
		return
	}
	if s.metaCapiTokenStr == "" || s.metaPixelIDStr == "" {
		kit.Fail(w, 503, "capi_not_configured", "meta_pixel_id ou meta_capi_token absent — configurer dans Marketing")
		return
	}
	body, _ := io.ReadAll(r.Body)
	url := fmt.Sprintf("https://graph.facebook.com/v19.0/%s/events?access_token=%s",
		s.metaPixelIDStr, s.metaCapiTokenStr)
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		kit.Fail(w, 500, "request_error", err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		kit.Fail(w, 502, "meta_unreachable", err.Error())
		return
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(out)
}

// marketingConfigPublic — GET /admin/api/marketing-config (NON authentifié).
// Le frontend l'appelle au runtime (via /api/marketing-config) pour savoir
// s'il doit injecter le Pixel Meta / GA et avec quel id. Ne renvoie que les
// identifiants publics par nature (visibles dans le code client de toute
// façon) ; le token CAPI reste côté serveur, jamais ici.
func (s *server) marketingConfigPublic(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=300")
	kit.JSON(w, 200, map[string]any{
		"meta_pixel_id":     s.metaPixelIDStr,
		"ga_measurement_id": s.gaMeasurementID,
		"capi_enabled":      s.metaCapiTokenStr != "",
	})
}

func (s *server) putLocalSettings(w http.ResponseWriter, r *http.Request) {
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
	s.jwtSec = []byte(s.jwtSecretStr)
	kit.JSON(w, 200, map[string]any{"ok": true, "updated": len(toSave)})
}

// settingsServiceURLs — services distants qui exposent GET/PUT /settings
// (voir leur propre settingsFields()) — la page Configuration Système
// agrège tout, ce service ne connaît pas leurs clés, seulement où les
// relayer.
func (s *server) settingsServiceURLs() map[string]string {
	return map[string]string{
		"payment":      s.paymentURL,
		"order":        s.orderURL,
		"auth":         s.authURL,
		"notification": s.notificationURL,
		"email":        s.emailURL,
		"loyalty":      s.loyaltyURL,
	}
}

func (s *server) proxySettingsGet(w http.ResponseWriter, r *http.Request) {
	url, ok := s.settingsServiceURLs()[r.PathValue("service")]
	if !ok {
		kit.Fail(w, 404, "unknown_service", fmt.Sprintf("service %q inconnu ou sans réglages exposés", r.PathValue("service")))
		return
	}
	forward(w, r, url+"/settings")
}

func (s *server) proxySettingsPut(w http.ResponseWriter, r *http.Request) {
	url, ok := s.settingsServiceURLs()[r.PathValue("service")]
	if !ok {
		kit.Fail(w, 404, "unknown_service", fmt.Sprintf("service %q inconnu ou sans réglages exposés", r.PathValue("service")))
		return
	}
	forwardWithBody(w, r, http.MethodPut, url+"/settings")
}

func (s *server) proxy(target func() string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		upstream := target()
		if r.URL.RawQuery != "" {
			sep := "?"
			if strings.Contains(upstream, "?") {
				sep = "&"
			}
			upstream += sep + r.URL.RawQuery
		}
		forward(w, r, upstream)
	}
}

func (s *server) proxyPath(target func(id string) string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		forward(w, r, target(r.PathValue("id")))
	}
}

// dhlSetOrderStage — POST /admin/api/orders/set-stage {order_id, stage} :
// équivalent de l'ancienne route WordPress /wp-json/miad-products/v1/order/set-stage
// (miad_delivery_stages() dans miad-representative.php).
//
// Corrigé le 2026-08-25 : la version précédente envoyait les 5 valeurs
// MIAD (vendor_confirmed/rep_received/local_pickup/intl_handoff/delivered)
// dans le champ `status` DHL de fulfillment-svc (POST
// /tracking/{shipment_id}/event), qui n'accepte QUE le vocabulaire
// transporteur DHL (pending_label/label_created/in_transit/customs/
// delivered) — 4 des 5 valeurs MIAD étaient donc rejetées en 400. Utilise
// maintenant shipments.delivery_stage, un champ dédié distinct du statut
// DHL (voir POST /shipments/order/{order_id}/delivery-stage).
func (s *server) dhlSetOrderStage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OrderID int64  `json:"order_id"`
		Stage   string `json:"stage"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.OrderID == 0 || body.Stage == "" {
		kit.Fail(w, 400, "invalid_body", "order_id et stage obligatoires")
		return
	}

	payload, _ := json.Marshal(map[string]string{"stage": body.Stage})
	upRes, err := http.Post(
		s.fulfillmentURL+"/shipments/order/"+strconv.FormatInt(body.OrderID, 10)+"/delivery-stage",
		"application/json", strings.NewReader(string(payload)))
	if err != nil {
		kit.Fail(w, 502, "upstream_unreachable", "fulfillment-svc injoignable")
		return
	}
	defer upRes.Body.Close()
	respBody, _ := io.ReadAll(upRes.Body)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(upRes.StatusCode)
	_, _ = w.Write(respBody)
}

// logAction — enregistre une action admin (remplace l'ancien
// wp-json/miad/v1/admin-action-log). Interne : appelé par le frontend
// après une action admin significative (édition produit, changement de
// statut commande, etc.) — pas automatique côté Go pour l'instant.
func (s *server) logAction(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ActorID    int64  `json:"actor_id"`
		ActorEmail string `json:"actor_email"`
		ActorRole  string `json:"actor_role"`
		Action     string `json:"action"`
		Endpoint   string `json:"endpoint"`
		Status     string `json:"status"`
		WPStatus   int    `json:"wp_status"`
		IP         string `json:"ip"`
		Country    string `json:"country"`
		UserAgent  string `json:"user_agent"`
		Metadata   string `json:"metadata"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Action == "" || body.Endpoint == "" || body.Status == "" {
		kit.Fail(w, 400, "missing_fields", "action, endpoint et status sont obligatoires")
		return
	}
	_, err := s.db.Exec(r.Context(), `
		INSERT INTO admin_action_log (actor_id, actor_email, actor_role, action, endpoint, status, wp_status, ip, country, user_agent, metadata)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		body.ActorID, body.ActorEmail, body.ActorRole, body.Action, body.Endpoint,
		body.Status, body.WPStatus, body.IP, body.Country, body.UserAgent, body.Metadata)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 201, map[string]string{"status": "logged"})
}

func (s *server) listActionLog(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(kit.EnvOr(q.Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(q.Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}

	args := []any{}
	where := "WHERE TRUE"
	if v := q.Get("status"); v != "" {
		where += fmt.Sprintf(" AND status = $%d", len(args)+1)
		args = append(args, v)
	}
	if v := q.Get("action"); v != "" {
		where += fmt.Sprintf(" AND action = $%d", len(args)+1)
		args = append(args, v)
	}

	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM admin_action_log "+where, args...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	query := `SELECT id, actor_id, actor_email, actor_role, action, endpoint, status, wp_status, ip, country, user_agent, metadata, created_at
	          FROM admin_action_log ` + where +
		fmt.Sprintf(" ORDER BY created_at DESC LIMIT %d OFFSET %d", pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var actorID *int64
		var actorEmail, actorRole, action, endpoint, status, ip, country, userAgent, metadata string
		var wpStatus *int
		var createdAt time.Time
		if err := rows.Scan(&id, &actorID, &actorEmail, &actorRole, &action, &endpoint, &status, &wpStatus, &ip, &country, &userAgent, &metadata, &createdAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		items = append(items, map[string]any{
			"id": id, "actor_id": actorID, "actor_email": actorEmail, "actor_role": actorRole,
			"action": action, "endpoint": endpoint, "status": status, "wp_status": wpStatus,
			"ip": ip, "country": country, "user_agent": userAgent, "metadata": metadata,
			"created_at": createdAt.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

// uploadMedia reçoit un fichier multipart (champ "file") depuis le
// dashboard React, l'envoie dans MinIO sous products/ ou vendors/ (champ
// "prefix", "products" par défaut) et renvoie l'URL HTTPS publique
// (img.miadmarket.ca) à coller dans --image côté scripts/miad.mjs ou à
// utiliser directement dans le catalogue.
func (s *server) uploadMedia(w http.ResponseWriter, r *http.Request) {
	if s.media == nil {
		kit.Fail(w, 503, "media_unavailable", "stockage d'images indisponible (MinIO non configuré)")
		return
	}
	if err := r.ParseMultipartForm(20 << 20); err != nil {
		kit.Fail(w, 400, "bad_request", "formulaire multipart invalide (max 20 Mo): "+err.Error())
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		kit.Fail(w, 400, "bad_request", "champ 'file' manquant")
		return
	}
	defer file.Close()

	prefix := kit.EnvOr(r.FormValue("prefix"), "products")
	if prefix != "products" && prefix != "vendors" && prefix != "categories" && prefix != "reviews" {
		kit.Fail(w, 400, "bad_request", "prefix doit être products, vendors, categories ou reviews")
		return
	}
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	filename := fmt.Sprintf("%d-%s", time.Now().UnixNano(), sanitizeFilename(header.Filename))

	url, err := s.media.UploadWithThumbnails(r.Context(), prefix, filename, file, header.Size, contentType, kit.Logger("admin-svc"))
	if err != nil {
		kit.Fail(w, 502, "upload_failed", err.Error())
		return
	}

	uploadedBy := ""
	if claims, err := s.verifyJWT(r); err == nil {
		if email, ok := claims["email"].(string); ok {
			uploadedBy = email
		}
	}
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO media_files (filename, url, folder, size_bytes, content_type, uploaded_by)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		header.Filename, url, prefix, header.Size, contentType, uploadedBy,
	); err != nil {
		// La médiathèque perd juste cette entrée du registre — l'upload
		// MinIO a déjà réussi et l'URL est valide, ne jamais faire échouer
		// la réponse pour un problème de métadonnées secondaires.
		kit.Logger("admin-svc").Warn("media_files insert échoué", "err", err.Error())
	}
	kit.JSON(w, 200, map[string]string{"url": url})
}

// listMedia — médiathèque paginée, filtrable par dossier/type/nom.
func (s *server) listMedia(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(kit.EnvOr(q.Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(q.Get("page_size"), "40"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 40
	}
	where := "WHERE 1=1"
	args := []any{}
	if v := q.Get("folder"); v != "" {
		args = append(args, v)
		where += fmt.Sprintf(" AND folder = $%d", len(args))
	}
	if v := q.Get("type"); v != "" {
		args = append(args, v+"%")
		where += fmt.Sprintf(" AND content_type LIKE $%d", len(args))
	}
	if v := q.Get("q"); v != "" {
		args = append(args, "%"+v+"%")
		where += fmt.Sprintf(" AND filename ILIKE $%d", len(args))
	}

	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM media_files "+where, args...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(r.Context(), fmt.Sprintf(`
		SELECT id, filename, url, folder, size_bytes, content_type, uploaded_by, created_at
		FROM media_files %s ORDER BY created_at DESC LIMIT $%d OFFSET $%d`, where, len(args)-1, len(args)), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	items := []map[string]any{}
	for rows.Next() {
		var id, size int64
		var filename, url, folder, contentType, uploadedBy string
		var createdAt time.Time
		if err := rows.Scan(&id, &filename, &url, &folder, &size, &contentType, &uploadedBy, &createdAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		items = append(items, map[string]any{
			"id": id, "filename": filename, "url": url, "folder": folder,
			"size_bytes": size, "content_type": contentType, "uploaded_by": uploadedBy,
			"created_at": createdAt.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

// deleteMedia — supprime l'objet MinIO ET la ligne de métadonnées.
// N'échoue pas la requête si l'objet MinIO est déjà absent (idempotent) :
// seule une vraie erreur réseau/permission bloque, pas un 404 upstream.
func (s *server) deleteMedia(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var url string
	if err := s.db.QueryRow(r.Context(),
		"SELECT url FROM media_files WHERE id = $1", id,
	).Scan(&url); err != nil {
		kit.Fail(w, 404, "media_not_found", fmt.Sprintf("fichier %s introuvable", id))
		return
	}
	if s.media != nil {
		if err := s.media.Delete(r.Context(), url); err != nil {
			kit.Logger("admin-svc").Warn("suppression MinIO échouée", "url", url, "err", err.Error())
		}
	}
	if _, err := s.db.Exec(r.Context(), "DELETE FROM media_files WHERE id = $1", id); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"id": id, "deleted": true})
}

// findMediaOrphans — fichiers dont l'URL n'apparaît dans aucune des
// tables qui référencent des images (produits/vendeurs/catégories/marques),
// croisées par appel HTTP vers catalog-svc/vendor-svc plutôt qu'un accès
// direct à leurs bases (admin-svc n'a pas de connexion à ces DB, cohérent
// avec le reste du fichier : proxy-and-aggregate, jamais un accès direct).
func (s *server) findMediaOrphans(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	used := map[string]bool{}

	collectURLs := func(url string) {
		p, err := fetchAllPages(ctx, url)
		if err != nil {
			return
		}
		markUsedURLs(p, used)
	}
	collectURLs(s.catalogURL + "/products?admin=true&page_size=100")
	collectURLs(s.vendorURL + "/stores?page_size=100")
	if body, err := getJSON(ctx, s.catalogURL+"/categories"); err == nil {
		markUsedURLs([]map[string]any{body}, used)
	}
	if body, err := getJSON(ctx, s.catalogURL+"/brands"); err == nil {
		markUsedURLs([]map[string]any{body}, used)
	}

	rows, err := s.db.Query(ctx, "SELECT id, filename, url, folder, size_bytes, created_at FROM media_files ORDER BY created_at DESC")
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	orphans := []map[string]any{}
	for rows.Next() {
		var id, size int64
		var filename, url, folder string
		var createdAt time.Time
		if err := rows.Scan(&id, &filename, &url, &folder, &size, &createdAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		if !used[url] {
			orphans = append(orphans, map[string]any{
				"id": id, "filename": filename, "url": url, "folder": folder,
				"size_bytes": size, "created_at": createdAt.UTC().Format(time.RFC3339),
			})
		}
	}
	kit.JSON(w, 200, map[string]any{"items": orphans, "total": len(orphans)})
}

// fetchAllPages — pagine un endpoint items/has_more jusqu'à épuisement,
// plafonné à 20 pages (2000 lignes à page_size=100) pour ne jamais boucler
// indéfiniment sur une réponse malformée.
func fetchAllPages(ctx context.Context, baseURL string) ([]map[string]any, error) {
	var all []map[string]any
	for page := 1; page <= 20; page++ {
		sep := "&"
		if !strings.Contains(baseURL, "?") {
			sep = "?"
		}
		body, err := getJSON(ctx, fmt.Sprintf("%s%spage=%d", baseURL, sep, page))
		if err != nil {
			return all, err
		}
		items, _ := body["items"].([]any)
		for _, it := range items {
			if m, ok := it.(map[string]any); ok {
				all = append(all, m)
			}
		}
		hasMore, _ := body["has_more"].(bool)
		if !hasMore || len(items) == 0 {
			break
		}
	}
	return all, nil
}

// markUsedURLs — extrait toutes les URLs d'image référencées par une
// liste d'objets (produits/vendeurs/catégories/marques), quelle que soit
// la forme exacte du champ (image/images/logo_url/banner_url/image_url).
func markUsedURLs(items []map[string]any, used map[string]bool) {
	mark := func(v any) {
		if s, ok := v.(string); ok && s != "" {
			used[s] = true
		}
	}
	for _, it := range items {
		mark(it["image"])
		mark(it["logo_url"])
		mark(it["banner_url"])
		mark(it["image_url"])
		mark(it["gravatar"])
		mark(it["banner"])
		if imgs, ok := it["images"].([]any); ok {
			for _, im := range imgs {
				if m, ok := im.(map[string]any); ok {
					mark(m["src"])
				}
			}
		}
		// listCategories/listBrands renvoient {"categories":[...]}/{"items":[...]}
		// plutôt que la liste directement — creuse un niveau si présent.
		for _, key := range []string{"categories", "roots", "items"} {
			if nested, ok := it[key].([]any); ok {
				sub := make([]map[string]any, 0, len(nested))
				for _, n := range nested {
					if m, ok := n.(map[string]any); ok {
						sub = append(sub, m)
					}
				}
				markUsedURLs(sub, used)
			}
		}
	}
}

// sanitizeFilename retire les caractères qui n'ont rien à faire dans une
// clé d'objet S3/MinIO (espaces, accents non gérés proprement par tous
// les clients HTTP, séparateurs de chemin) — garde juste [a-zA-Z0-9._-].
func sanitizeFilename(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteRune('-')
		}
	}
	out := b.String()
	if out == "" {
		return "image"
	}
	return out
}

// proxyAuth — même principe, mais vers auth-svc qui applique lui-même
// sa propre vérification role=admin ; ici on relaie aussi l'en-tête
// Authorization pour que ce contrôle redondant passe.
func (s *server) proxyAuth(target func() string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		upstream := target()
		if r.URL.RawQuery != "" {
			upstream += "?" + r.URL.RawQuery
		}
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstream, nil)
		if err != nil {
			kit.Fail(w, 500, "upstream_request_error", err.Error())
			return
		}
		req.Header.Set("Authorization", r.Header.Get("Authorization"))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			kit.Fail(w, 502, "upstream_unreachable", err.Error())
			return
		}
		defer resp.Body.Close()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}
}

func forward(w http.ResponseWriter, r *http.Request, upstream string) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstream, nil)
	if err != nil {
		kit.Fail(w, 500, "upstream_request_error", err.Error())
		return
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		kit.Fail(w, 502, "upstream_unreachable", fmt.Sprintf("%s injoignable — erreur EXPLICITE", upstream))
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// forwardWithBody — même principe que forward, mais transmet la méthode
// et le corps de la requête (nécessaire pour PUT /email-templates/{name},
// contrairement aux proxies GET simples ci-dessus).
func forwardWithBody(w http.ResponseWriter, r *http.Request, method, upstream string) {
	req, err := http.NewRequestWithContext(r.Context(), method, upstream, r.Body)
	if err != nil {
		kit.Fail(w, 500, "upstream_request_error", err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	// Propager le JWT admin vers le service en amont : plusieurs endpoints
	// (auth-svc POST /admins, /admin-roles, etc.) refont un requireRole
	// "admin" et échouent en 403 sans ce header — le client interprète
	// alors le 403 comme une session expirée et déconnecte l'admin
	// (constaté le 2026-08-28 : "créer un compte admin déconnecte").
	// s.proxyAuth le fait déjà pour les GET ; forwardWithBody l'oubliait.
	if auth := r.Header.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		kit.Fail(w, 502, "upstream_unreachable", fmt.Sprintf("%s injoignable — erreur EXPLICITE", upstream))
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func getJSON(ctx context.Context, url string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body, nil
}

// ---------- Guard : routage des alertes de sécurité ----------

// dispatchSecurityAlert — AlertFn du guard. Le guard a déjà écrit la
// ligne security_events et (si Action==block) rempli blocked_ips ;
// cette fonction pousse la notification humaine :
//   - email à tous les admins pour severity >= warn (via email-svc)
//   - WhatsApp aux numéros admins pour severity == critical (via
//     loyalty-svc, endpoint /whatsapp/test réutilisé — appel INTERNE
//     k8s, jamais via Caddy)
// Jamais bloquant : le guard l'appelle déjà dans une goroutine, mais
// on borne quand même chaque appel réseau.
func (s *server) dispatchSecurityAlert(ev kit.Event) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	secret := kit.Env("INTERNAL_API_SECRET", "")

	payload := map[string]any{
		"svc": ev.Svc, "rule": ev.Rule, "severity": string(ev.Severity),
		"action": string(ev.Action), "ip": ev.IP, "subject": ev.Subject,
		"method": ev.Method, "path": ev.Path, "count": ev.Count,
		"window_sec": ev.WindowSec, "detail": ev.Detail,
	}

	if ev.Severity == kit.SevWarn || ev.Severity == kit.SevCritical {
		if err := postJSONInternal(ctx, s.emailURL+"/emails/security-alert", secret, payload); err != nil {
			kit.Logger("admin-svc").Error("guard: échec envoi email d'alerte", "err", err, "rule", ev.Rule)
		}
	}

	if ev.Severity == kit.SevCritical {
		nums := splitCSV(kit.Env("SECURITY_ALERT_WHATSAPP", ""))
		msg := fmt.Sprintf("⚠️ MIAD sécurité [CRITIQUE] — %s\n%s\nIP %s · %d occ./%ds · %s %s",
			ev.Rule, ev.Detail, ev.IP, ev.Count, ev.WindowSec, ev.Method, ev.Path)
		for _, n := range nums {
			wa := map[string]any{"to": n, "body": msg}
			if err := postJSONInternal(ctx, s.loyaltyURL+"/whatsapp/test", secret, wa); err != nil {
				kit.Logger("admin-svc").Error("guard: échec envoi WhatsApp d'alerte", "err", err, "to", n)
			}
		}
	}
}

// ---------- Guard : journal de sécurité (console + endpoints internes) ----------

// securityEvents — GET /admin/api/security/events?limit=100. Journal
// centralisé (miad_admin), tous services confondus.
func (s *server) securityEvents(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	rows, err := s.guard.RecentEvents(r.Context(), limit)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"items": rows})
}

// securityBlocks — GET /admin/api/security/blocks. IP bloquées
// (actives + expirées < 24 h).
func (s *server) securityBlocks(w http.ResponseWriter, r *http.Request) {
	rows, err := s.guard.ListBlocked(r.Context())
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"items": rows})
}

// securityUnblock — POST /admin/api/security/unblock {ip, totp_code}.
// Déblocage manuel depuis la console. Exige désormais le code 2FA de
// l'admin (celui déjà utilisé pour se connecter) — ajouté le 2026-09-04,
// demande explicite du fondateur : avant ce correctif, un simple
// window.confirm() navigateur suffisait, donc un JWT admin volé/laissé
// ouvert (session déjà connectée) permettait de rouvrir l'accès à une IP
// bloquée par le guard anti-fraude sans aucune re-vérification
// d'identité. Le code est vérifié via auth-svc (source de vérité du
// secret TOTP, jamais dupliqué ici) — reverify2FA n'émet pas de nouveau
// JWT ni ne modifie totp_enabled, juste un oui/non.
func (s *server) securityUnblock(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IP       string `json:"ip"`
		TOTPCode string `json:"totp_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.IP) == "" {
		kit.Fail(w, 400, "invalid_body", "champ 'ip' obligatoire")
		return
	}
	if strings.TrimSpace(body.TOTPCode) == "" {
		kit.Fail(w, 400, "totp_code_required", "code de vérification (2FA) requis pour débloquer une IP")
		return
	}
	if err := s.verifyAdminTOTP(r, body.TOTPCode); err != nil {
		kit.Fail(w, 401, "invalid_totp_code", err.Error())
		return
	}
	if err := s.guard.Unblock(r.Context(), strings.TrimSpace(body.IP)); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"ok": true})
}

// verifyAdminTOTP — relaie le code 2FA de l'admin connecté (JWT propagé
// via le header Authorization déjà présent sur la requête entrante) vers
// auth-svc POST /auth/admin/2fa/reverify. N'émet aucune session, ne
// modifie aucun état — juste une confirmation d'identité avant une
// action sensible (voir securityUnblock).
func (s *server) verifyAdminTOTP(r *http.Request, code string) error {
	payload, _ := json.Marshal(map[string]string{"code": code})
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, s.authURL+"/auth/admin/2fa/reverify", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if auth := r.Header.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("auth-svc injoignable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var errBody struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		_ = json.Unmarshal(raw, &errBody)
		if errBody.Error.Message != "" {
			return fmt.Errorf("%s", errBody.Error.Message)
		}
		return fmt.Errorf("code incorrect")
	}
	return nil
}

// securityBlockManual — POST /admin/api/security/block {ip, minutes, reason}.
// Blocage manuel depuis la console.
func (s *server) securityBlockManual(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IP      string `json:"ip"`
		Minutes int    `json:"minutes"`
		Reason  string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.IP) == "" {
		kit.Fail(w, 400, "invalid_body", "champ 'ip' obligatoire")
		return
	}
	if body.Minutes <= 0 || body.Minutes > 7*24*60 {
		body.Minutes = 60
	}
	if err := s.guard.BlockManual(r.Context(), strings.TrimSpace(body.IP),
		body.Reason, time.Duration(body.Minutes)*time.Minute); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"ok": true})
}

// requireInternal — garde commune des endpoints /internal/* du guard.
func (s *server) requireInternal(r *http.Request) bool {
	secret := kit.Env("INTERNAL_API_SECRET", "")
	return secret != "" && r.Header.Get("X-Internal-Secret") == secret
}

// internalSecurityEventWrite — POST /internal/security-events. Un guard
// d'un autre service y pousse un Event (SinkFn). Insère dans la table
// centrale, PUIS route l'alerte humaine (email/WhatsApp) exactement
// comme si l'événement venait d'admin-svc lui-même.
func (s *server) internalSecurityEventWrite(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternal(r) {
		kit.Fail(w, 401, "unauthorized", "secret interne requis")
		return
	}
	var ev kit.Event
	if err := json.NewDecoder(r.Body).Decode(&ev); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if ev.Rule == "" {
		kit.Fail(w, 400, "missing_rule", "champ 'rule' obligatoire")
		return
	}
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO security_events
		  (svc, rule, severity, action, ip, subject, method, path, count, window_sec, detail)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		ev.Svc, ev.Rule, string(ev.Severity), string(ev.Action),
		ev.IP, ev.Subject, ev.Method, ev.Path, ev.Count, ev.WindowSec, ev.Detail,
	); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	go s.dispatchSecurityAlert(ev)
	kit.JSON(w, 202, map[string]any{"ok": true})
}

// clientErrorWrite — POST /admin/api/log-client-error. Suivi d'erreurs
// frontend maison (2026-09-03), voir le commentaire sur client_error_log
// dans `schema` plus haut pour le contexte (remplace Sentry, incompatible
// avec ce projet). Protégé par le secret interne — jamais appelé
// directement par le navigateur du visiteur (qui ne connaît pas ce
// secret), toujours relayé par app/api/log-client-error/route.ts côté
// Next.js. Best-effort : ne fait jamais planter le site qui rapporte
// l'erreur — toujours 202, même si l'écriture échoue (loggé côté serveur
// seulement).
func (s *server) clientErrorWrite(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternal(r) {
		kit.Fail(w, 401, "unauthorized", "secret interne requis")
		return
	}
	var body struct {
		Message   string `json:"message"`
		Stack     string `json:"stack"`
		Digest    string `json:"digest"`
		URL       string `json:"url"`
		UserAgent string `json:"user_agent"`
		UserID    string `json:"user_id"`
		Type      string `json:"type"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Message == "" {
		kit.Fail(w, 400, "invalid_body", "champ 'message' obligatoire")
		return
	}
	if body.Type == "" {
		body.Type = "js_error"
	}
	truncate := func(s string, max int) string {
		if len(s) > max {
			return s[:max]
		}
		return s
	}
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO client_error_log (message, stack, digest, url, user_agent, user_id, type)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		truncate(body.Message, 2000), truncate(body.Stack, 8000), body.Digest,
		truncate(body.URL, 500), truncate(body.UserAgent, 500), body.UserID, body.Type,
	); err != nil {
		kit.Logger("admin-svc").Warn("client_error_log insert échoué", "err", err.Error())
	}
	kit.JSON(w, 202, map[string]any{"ok": true})
}

// listClientErrors — GET /admin/api/client-errors. Page back-office
// "Erreurs du site" (JWT admin requis, voir requireAdmin à l'enregistrement
// de la route).
func (s *server) listClientErrors(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(kit.EnvOr(q.Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(q.Get("page_size"), "40"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 40
	}
	// Filtre optionnel ?type=js_error|image_error — page "Erreurs du site"
	// permet de séparer les deux (voir clientErrorWrite pour le contexte).
	typeFilter := q.Get("type")
	where := ""
	args := []any{}
	if typeFilter != "" {
		where = "WHERE type = $1"
		args = append(args, typeFilter)
	}

	var total int64
	countArgs := append([]any{}, args...)
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM client_error_log "+where, countArgs...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(r.Context(), fmt.Sprintf(`
		SELECT id, message, stack, digest, url, user_agent, user_id, type, created_at
		FROM client_error_log %s ORDER BY created_at DESC LIMIT $%d OFFSET $%d`, where, len(args)-1, len(args)),
		args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var message, stack, digest, url, userAgent, userID, errType string
		var createdAt time.Time
		if err := rows.Scan(&id, &message, &stack, &digest, &url, &userAgent, &userID, &errType, &createdAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		items = append(items, map[string]any{
			"id": id, "message": message, "stack": stack, "digest": digest,
			"url": url, "user_agent": userAgent, "user_id": userID, "type": errType,
			"created_at": createdAt.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{"items": items, "total": total, "page": page, "page_size": pageSize})
}

// internalSecurityBlockWrite — POST /internal/security-block
// {ip, rule, reason, until}. Un guard d'un autre service y pousse un
// blocage décidé localement (BlockPushFn).
func (s *server) internalSecurityBlockWrite(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternal(r) {
		kit.Fail(w, 401, "unauthorized", "secret interne requis")
		return
	}
	var body struct {
		IP     string    `json:"ip"`
		Rule   string    `json:"rule"`
		Reason string    `json:"reason"`
		Until  time.Time `json:"until"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.IP == "" {
		kit.Fail(w, 400, "invalid_body", "champ 'ip' obligatoire")
		return
	}
	if body.Until.IsZero() {
		body.Until = time.Now().Add(15 * time.Minute)
	}
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO blocked_ips (ip, expires_at, rule, reason)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (ip) DO UPDATE SET
		  expires_at = GREATEST(blocked_ips.expires_at, EXCLUDED.expires_at),
		  rule = EXCLUDED.rule, reason = EXCLUDED.reason`,
		body.IP, body.Until, body.Rule, body.Reason,
	); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 202, map[string]any{"ok": true})
}

// internalSecurityBlocksRead — GET /internal/security-blocks. Les
// guards des autres services lisent ici la liste noire partagée
// (BlocklistFn), renvoyée comme { "ip": "RFC3339 expiration", ... }.
func (s *server) internalSecurityBlocksRead(w http.ResponseWriter, r *http.Request) {
	if !s.requireInternal(r) {
		kit.Fail(w, 401, "unauthorized", "secret interne requis")
		return
	}
	rows, err := s.db.Query(r.Context(),
		`SELECT ip, expires_at FROM blocked_ips WHERE expires_at > now()`)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var ip string
		var exp time.Time
		if err := rows.Scan(&ip, &exp); err == nil {
			out[ip] = exp.UTC().Format(time.RFC3339)
		}
	}
	kit.JSON(w, 200, out)
}

// postJSONInternal — POST JSON service-à-service sur le réseau k8s
// interne, avec le secret partagé. Ne lit pas la réponse (fire-and-check).
func postJSONInternal(ctx context.Context, url, secret string, body any) error {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if secret != "" {
		req.Header.Set("X-Internal-Secret", secret)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		out, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(out))
	}
	return nil
}

func splitCSV(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func ping(ctx context.Context, url string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

// ---------- JWT role=admin (même schéma HS256 que auth-svc) ----------

func (s *server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, err := s.verifyJWT(r)
		if err != nil || claims["role"] != "admin" {
			msg := "rôle admin requis"
			if err != nil {
				msg = err.Error()
			}
			kit.Fail(w, 403, "admin_required", msg)
			return
		}
		s.trackAdminIP(r, fmt.Sprint(claims["sub"]))
		next(w, r)
	}
}

// trackAdminIP — enregistre l'IP pour ce compte admin ; si c'est une
// IP jamais vue, déclenche la règle guard "admin_new_ip" (alerte, pas
// de blocage). Non bloquant, best-effort.
func (s *server) trackAdminIP(r *http.Request, accountID string) {
	if s.guard == nil || accountID == "" || accountID == "<nil>" {
		return
	}
	ip := clientIPFromRequest(r)
	if ip == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		tag, err := s.db.Exec(ctx, `
			INSERT INTO admin_ip_seen (account_id, ip) VALUES ($1,$2)
			ON CONFLICT (account_id, ip) DO UPDATE SET last_seen = now()`,
			accountID, ip)
		if err != nil {
			kit.Logger("admin-svc").Error("trackAdminIP: échec upsert", "err", err)
			return
		}
		// RowsAffected == 1 sur un vrai INSERT (nouvelle paire) ; sur
		// un UPDATE (paire connue) pgx renvoie aussi 1 — on distingue
		// via xmax : plus simple ici, on refait un SELECT du first_seen.
		var firstSeen, lastSeen time.Time
		if err := s.db.QueryRow(ctx,
			`SELECT first_seen, last_seen FROM admin_ip_seen WHERE account_id=$1 AND ip=$2`,
			accountID, ip).Scan(&firstSeen, &lastSeen); err != nil {
			return
		}
		_ = tag
		// Nouvelle IP = first_seen très récent (< 10 s) ET c'est la
		// première fois qu'on la voit (first_seen ≈ last_seen).
		if time.Since(firstSeen) < 10*time.Second && lastSeen.Sub(firstSeen) < 2*time.Second {
			kit.Note(r, "admin_new_ip", accountID)
		}
	}()
}

// clientIPFromRequest — même logique que le guard (CF-Connecting-IP en
// prod, derrière Cloudflare + Caddy).
func clientIPFromRequest(r *http.Request) string {
	if cf := r.Header.Get("CF-Connecting-IP"); cf != "" {
		return strings.TrimSpace(cf)
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// requireAdminOrVendor — pour les routes qu'un vendeur authentifié peut
// aussi utiliser (ex: upload d'image produit), en plus d'un admin. Un
// vendeur est un customer avec vendor_id non nul dans son JWT (voir A.10
// du plan de migration côté auth-svc) — pas un rôle séparé.
func (s *server) requireAdminOrVendor(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, err := s.verifyJWT(r)
		if err != nil {
			kit.Fail(w, 403, "auth_required", err.Error())
			return
		}
		isAdmin := claims["role"] == "admin"
		_, hasVendorID := claims["vendor_id"].(float64)
		if !isAdmin && !hasVendorID {
			kit.Fail(w, 403, "admin_or_vendor_required", "rôle admin ou compte vendeur requis")
			return
		}
		next(w, r)
	}
}

// requireAdminOrRep — pour les routes qu'un représentant authentifié peut
// aussi utiliser (messagerie client, voir /admin/api/representative/messages),
// en plus d'un admin. Le rôle représentant n'est pas un claim JWT (comme
// vendor_id) : loyalty-svc est la source de vérité, résolue par email — donc
// un appel réseau supplémentaire ici, contrairement à requireAdminOrVendor.
func (s *server) requireAdminOrRep(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, err := s.verifyJWT(r)
		if err != nil {
			kit.Fail(w, 403, "auth_required", err.Error())
			return
		}
		if claims["role"] == "admin" {
			next(w, r)
			return
		}
		email, _ := claims["email"].(string)
		if email == "" {
			kit.Fail(w, 403, "admin_or_rep_required", "rôle admin ou compte représentant requis")
			return
		}
		req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet,
			s.loyaltyURL+"/representative/by-email/"+email, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			if resp != nil {
				resp.Body.Close()
			}
			kit.Fail(w, 403, "admin_or_rep_required", "rôle admin ou compte représentant requis")
			return
		}
		resp.Body.Close()
		next(w, r)
	}
}

// verifyJWT vérifie signature + expiration d'un JWT HS256 émis par
// auth-svc et renvoie ses claims — factorisé pour requireAdmin ET
// requireAdminOrVendor (même vérification de signature, contrôle de
// rôle différent selon l'appelant).
func (s *server) verifyJWT(r *http.Request) (map[string]any, error) {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return nil, fmt.Errorf("Authorization: Bearer <jwt> attendu")
	}
	parts := strings.Split(h[len(prefix):], ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("JWT malformé")
	}
	mac := hmac.New(sha256.New, s.jwtSec)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	wantSig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(mac.Sum(nil), wantSig) {
		return nil, fmt.Errorf("signature invalide")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("payload illisible")
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("payload JSON invalide")
	}
	if exp, ok := claims["exp"].(float64); ok && time.Now().Unix() > int64(exp) {
		return nil, fmt.Errorf("session expirée")
	}
	// Révocation : même mécanisme que auth-svc.claimsFromRequest (clé Redis
	// admin_sv:<id> partagée, cluster-interne) — un JWT émis avant le
	// dernier appel à /revoke-sessions est rejeté ici aussi, pas seulement
	// sur auth-svc, puisque la quasi-totalité des routes admin passe par
	// admin-svc/requireAdmin plutôt que par auth-svc directement.
	if sv, ok := claims["sv"].(float64); ok {
		id, _ := claims["sub"].(float64)
		val, err := s.redis.Get(r.Context(), fmt.Sprintf("admin_sv:%d", int64(id))).Result()
		if err == nil {
			if current, perr := strconv.ParseInt(val, 10, 64); perr == nil && int64(sv) < current {
				return nil, fmt.Errorf("session révoquée")
			}
		}
	}
	return claims, nil
}

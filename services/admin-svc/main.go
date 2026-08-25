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
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

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
`

//go:embed webui/dist
var webuiFS embed.FS

// webuiStatic — sous-arbre webui/dist (sans le préfixe "webui/dist" que
// go:embed conserve autrement dans les chemins), pour servir directement
// depuis la racine attendue par http.FileServer.
var webuiStatic, _ = fs.Sub(webuiFS, "webui/dist")

type server struct {
	db              *pgxpool.Pool
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
}

func main() {
	ctx := context.Background()
	log := kit.Logger("admin-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_ADMIN", "postgres://miad:miad@postgres:5432/miad_admin?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema); err != nil {
		log.Error("migration du schéma impossible", "err", err)
		return
	}

	s := &server{
		db:              db,
		jwtSec:          []byte(kit.Env("JWT_SECRET", "change-me")),
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
	}

	media, err := kit.NewMedia(
		kit.Env("MINIO_ENDPOINT", "minio:9000"),
		kit.Env("MINIO_ROOT_USER", ""),
		kit.Env("MINIO_ROOT_PASSWORD", ""),
		kit.Env("MINIO_BUCKET", "miad-media"),
		kit.Env("MEDIA_BASE_URL", "https://img.miadmarket.ca"),
	)
	if err != nil {
		log.Error("client minio indisponible — upload d'images désactivé", "err", err)
	}
	s.media = media

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	for name, url := range s.allServiceURLs() {
		u := url
		health.Add(name, func(ctx context.Context) error { return ping(ctx, u+"/healthz") })
	}

	kit.Run("admin-svc", kit.Env("PORT_ADMIN", "8088"), log, health, func(mux *http.ServeMux) {
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
		mux.HandleFunc("GET /admin/api/vendors", s.requireAdmin(s.proxy(func() string { return s.vendorURL + "/stores" })))
		mux.HandleFunc("GET /admin/api/customers", s.requireAdmin(s.proxyAuth(func() string { return s.authURL + "/customers" })))
		mux.HandleFunc("GET /admin/api/payments", s.requireAdmin(s.proxy(func() string { return s.paymentURL + "/payments" })))
		mux.HandleFunc("GET /admin/api/shipping-quote", s.requireAdmin(s.proxy(func() string { return s.shippingURL + "/shipping-rates/quote" })))
		mux.HandleFunc("GET /admin/api/shipments", s.requireAdmin(s.proxy(func() string { return s.fulfillmentURL + "/shipments" })))
		mux.HandleFunc("GET /admin/api/coins/leaderboard", s.requireAdmin(s.proxy(func() string { return s.loyaltyURL + "/coins/leaderboard" })))
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
		mux.HandleFunc("GET /admin/api/system", s.requireAdmin(s.systemCheck))
		mux.HandleFunc("GET /admin/api/push/stats", s.requireAdmin(s.proxy(func() string { return s.notificationURL + "/push/stats" })))
		mux.HandleFunc("POST /admin/api/push/broadcast", s.requireAdmin(func(w http.ResponseWriter, r *http.Request) {
			forwardWithBody(w, r, http.MethodPost, s.notificationURL+"/push/broadcast")
		}))
		mux.HandleFunc("POST /admin/api/media/upload", s.requireAdmin(s.uploadMedia))
		// Hors /admin/api/ : accessible à un vendeur authentifié (pas
		// seulement un admin) pour uploader une image produit — même
		// handler, même MinIO, contrôle d'accès différent.
		mux.HandleFunc("POST /media/upload", s.requireAdminOrVendor(s.uploadMedia))
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
	if prefix != "products" && prefix != "vendors" && prefix != "categories" {
		kit.Fail(w, 400, "bad_request", "prefix doit être products, vendors ou categories")
		return
	}
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	filename := fmt.Sprintf("%d-%s", time.Now().UnixNano(), sanitizeFilename(header.Filename))

	url, err := s.media.Upload(r.Context(), prefix, filename, file, header.Size, contentType)
	if err != nil {
		kit.Fail(w, 502, "upload_failed", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]string{"url": url})
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
		next(w, r)
	}
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
	return claims, nil
}

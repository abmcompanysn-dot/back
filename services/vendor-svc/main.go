// ============================================================
// vendor-svc — boutiques (ex-Dokan) : profils, tableau de bord.
// Publie : vendor.registered, vendor.updated
// Les données des AUTRES services se demandent, ne se lisent pas :
// GET /vendor/{id}/products → appel HTTP à catalog-svc (en prod : gRPC).
// ============================================================
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/IBM/sarama"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/miadmarket/miad-backend/internal/kit"
)

const schema = `
CREATE TABLE IF NOT EXISTS vendors (
  id            BIGSERIAL PRIMARY KEY,
  wc_store_id   BIGINT UNIQUE,
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE,
  logo_url      TEXT DEFAULT '',   -- R2, aucune migration d'assets
  banner_url    TEXT DEFAULT '',
  country       TEXT DEFAULT '',
  city          TEXT DEFAULT '',
  phone         TEXT DEFAULT '',
  email         TEXT DEFAULT '',
  verified      BOOLEAN NOT NULL DEFAULT FALSE,
  rating_avg    REAL NOT NULL DEFAULT 0,
  product_count INT NOT NULL DEFAULT 0, -- dénormalisé sur événement catalog
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`

type server struct {
	db         *pgxpool.Pool
	kafka      sarama.SyncProducer
	catalogURL string
	orderURL   string
}

func main() {
	ctx := context.Background()
	log := kit.Logger("vendor-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_VENDOR", "postgres://miad:miad@postgres:5432/miad_vendor?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema); err != nil {
		log.Error("migration impossible", "err", err)
		return
	}

	s := &server{
		db:         db,
		kafka:      kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		catalogURL: kit.Env("CATALOG_SVC_URL", "http://catalog-svc:8081"),
		orderURL:   kit.Env("ORDER_SVC_URL", "http://order-svc:8083"),
	}

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	health.Add("catalog-svc", func(ctx context.Context) error {
		return ping(ctx, s.catalogURL+"/healthz")
	})

	kit.Run("vendor-svc", kit.Env("PORT_VENDOR", "8082"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("GET /stores", s.listStores)
		mux.HandleFunc("GET /vendor/{id}/products", s.vendorProducts)
		mux.HandleFunc("PUT /vendor/profile", s.updateProfile)
		mux.HandleFunc("GET /vendor/{id}/orders", s.vendorOrders)
	})
}

func (s *server) listStores(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(kit.EnvOr(q.Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(q.Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}

	where := "WHERE verified = TRUE"
	args := []any{}
	if c := q.Get("country"); c != "" {
		where += " AND country = $1"
		args = append(args, c)
	}

	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM vendors "+where, args...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT id, name, slug, logo_url, banner_url, country, city, rating_avg, product_count
		FROM vendors `+where+` ORDER BY rating_avg DESC, id
		LIMIT `+strconv.Itoa(pageSize)+` OFFSET `+strconv.Itoa((page-1)*pageSize), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var name, slug, logo, banner, country, city string
		var rating float64
		var count int
		_ = rows.Scan(&id, &name, &slug, &logo, &banner, &country, &city, &rating, &count)
		items = append(items, map[string]any{
			"id": id, "name": name, "slug": slug, "logo_url": logo, "banner_url": banner,
			"country": country, "city": city, "verified": true,
			"rating_avg": rating, "product_count": count,
		})
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

// vendorProducts — délégation à catalog-svc : vendor-svc ne possède pas
// les produits. En local : HTTP ; après codegen : appel gRPC typé.
func (s *server) vendorProducts(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	lang := r.URL.Query().Get("lang")
	page := r.URL.Query().Get("page")
	upstream := fmt.Sprintf("%s/products?vendor_id=%s&lang=%s&page=%s", s.catalogURL, id, lang, page)
	resp, err := http.Get(upstream)
	if err != nil {
		kit.Fail(w, 502, "catalog_unreachable",
			"catalog-svc injoignable — erreur EXPLICITE (sous WordPress, ce cas renvoyait une liste vide silencieuse)")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		kit.Fail(w, 502, "catalog_error", fmt.Sprintf("catalog-svc a répondu %d: %s", resp.StatusCode, body))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_, _ = io.Copy(w, resp.Body)
}

func (s *server) updateProfile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		VendorID  int64  `json:"vendor_id"`
		Name      string `json:"name"`
		LogoURL   string `json:"logo_url"`
		BannerURL string `json:"banner_url"`
		Phone     string `json:"phone"`
		City      string `json:"city"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.VendorID == 0 {
		kit.Fail(w, 400, "missing_fields", "vendor_id obligatoire")
		return
	}
	row := s.db.QueryRow(r.Context(), `
		UPDATE vendors SET
			name = COALESCE(NULLIF($2,''), name),
			logo_url = COALESCE(NULLIF($3,''), logo_url),
			banner_url = COALESCE(NULLIF($4,''), banner_url),
			phone = COALESCE(NULLIF($5,''), phone),
			city = COALESCE(NULLIF($6,''), city)
		WHERE id = $1
		RETURNING id, name, slug, logo_url, banner_url, country, city, phone, email, verified`,
		body.VendorID, body.Name, body.LogoURL, body.BannerURL, body.Phone, body.City)

	var id int64
	var name, slug, logo, banner, country, city, phone, email string
	var verified bool
	if err := row.Scan(&id, &name, &slug, &logo, &banner, &country, &city, &phone, &email, &verified); err != nil {
		kit.Fail(w, 404, "vendor_not_found", fmt.Sprintf("boutique %d introuvable", body.VendorID))
		return
	}
	kit.Publish(s.kafka, "vendor.updated", fmt.Sprint(id), map[string]any{
		"vendor_id": id, "at": time.Now().UTC().Format(time.RFC3339),
	})
	kit.JSON(w, 200, map[string]any{
		"id": id, "name": name, "slug": slug, "logo_url": logo, "banner_url": banner,
		"country": country, "city": city, "phone": phone, "email": email, "verified": verified,
	})
}

// vendorOrders — même principe : les commandes appartiennent à order-svc.
func (s *server) vendorOrders(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	upstream := fmt.Sprintf("%s/orders?vendor_id=%s&page=%s", s.orderURL, id, r.URL.Query().Get("page"))
	resp, err := http.Get(upstream)
	if err != nil {
		kit.Fail(w, 502, "order_unreachable", "order-svc injoignable — réessayez, la donnée n'est pas perdue")
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func ping(ctx context.Context, url string) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
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

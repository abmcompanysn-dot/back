// ============================================================
// catalog-svc — produits, variations, catégories, recherche.
// Service de référence du dépôt : les autres squelettes suivent
// le même modèle. REST direct ici ; après `make proto`, ces
// handlers seront branchés sur les stubs grpc-gateway générés
// (même contrat JSON, zéro changement frontend).
// Événements publiés : product.created, product.updated
// ============================================================
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/IBM/sarama"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/miadmarket/miad-backend/internal/kit"
)

// Schéma idempotent — appliqué au démarrage (CREATE … IF NOT EXISTS).
const schema = `
CREATE TABLE IF NOT EXISTS products (
  id          BIGSERIAL PRIMARY KEY,
  wc_id       BIGINT,
  trid        TEXT NOT NULL,            -- groupe de traduction (modèle WPML conservé)
  lang        TEXT NOT NULL CHECK (lang IN ('fr','en')),
  vendor_id   BIGINT,
  category_id BIGINT,
  name        TEXT NOT NULL,
  slug        TEXT,
  description TEXT DEFAULT '',
  price_usd   DOUBLE PRECISION NOT NULL DEFAULT 0, -- USD réel, comme le catalogue WooCommerce source (voir CLAUDE.md frontend : _price n'est PAS en FCFA)
  currency    TEXT NOT NULL DEFAULT 'USD',
  status      TEXT NOT NULL DEFAULT 'active',
  images      JSONB NOT NULL DEFAULT '[]',
  is_variable BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wc_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_products_trid    ON products (trid);
CREATE INDEX IF NOT EXISTS idx_products_lang    ON products (lang);
CREATE INDEX IF NOT EXISTS idx_products_vendor  ON products (vendor_id);
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products (name); -- + extension pg_trgm en prod

CREATE TABLE IF NOT EXISTS product_variations (
  id         BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku        TEXT,
  attributes JSONB NOT NULL DEFAULT '{}',
  price_usd  DOUBLE PRECISION NOT NULL DEFAULT 0,
  stock      INT NOT NULL DEFAULT 0,
  image_url  TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS categories (
  id        BIGSERIAL PRIMARY KEY,
  wc_id     BIGINT,
  trid      TEXT NOT NULL,
  lang      TEXT NOT NULL CHECK (lang IN ('fr','en')),
  parent_id BIGINT,
  name      TEXT NOT NULL,
  slug      TEXT,
  image_url TEXT DEFAULT '',
  UNIQUE (wc_id, lang)
);

CREATE TABLE IF NOT EXISTS reviews (
  id         BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL,
  order_id   BIGINT,                    -- vérifié via order-svc (anti-faux avis)
  rating     INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    TEXT DEFAULT '',
  verified_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`

type server struct {
	db    *pgxpool.Pool
	kafka sarama.SyncProducer
}

func main() {
	ctx := context.Background()
	log := kit.Logger("catalog-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_CATALOG", "postgres://miad:miad@postgres:5432/miad_catalog?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema); err != nil {
		log.Error("migration du schéma impossible", "err", err)
		return
	}

	s := &server{db: db, kafka: kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092"))}

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	health.Add("kafka", func(ctx context.Context) error {
		if s.kafka == nil {
			return fmt.Errorf("producteur kafka non connecté (mode journalisé)")
		}
		return nil
	})

	kit.Run("catalog-svc", kit.Env("PORT_CATALOG", "8081"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("GET /products", s.listProducts)
		mux.HandleFunc("GET /products/{id}", s.getProduct)
		mux.HandleFunc("GET /products/{id}/similar", s.similar)
		mux.HandleFunc("GET /categories", s.listCategories)
		mux.HandleFunc("GET /search/suggestions", s.suggestions)
		mux.HandleFunc("POST /vendor/products", s.createProduct)
	})
}

// listProducts — pagination EXPLICITE et stable : page/page_size/total/has_more.
// C'est la réponse directe au filtrage silencieux de WPML : le frontend
// n'a plus jamais à deviner si une page vide signifie la fin.
func (s *server) listProducts(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	lang := defLang(q.Get("lang"))
	page, _ := strconv.Atoi(def(q.Get("page"), "1"))
	pageSize, _ := strconv.Atoi(def(q.Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}

	args := []any{lang}
	where := "WHERE lang = $1 AND status = 'active'"
	if v := q.Get("category_id"); v != "" {
		where += fmt.Sprintf(" AND category_id = $%d", len(args)+1)
		args = append(args, atoi(v))
	}
	if v := q.Get("vendor_id"); v != "" {
		where += fmt.Sprintf(" AND vendor_id = $%d", len(args)+1)
		args = append(args, atoi(v))
	}
	if v := q.Get("q"); v != "" {
		where += fmt.Sprintf(" AND name ILIKE $%d", len(args)+1)
		args = append(args, "%"+v+"%")
	}

	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM products "+where, args...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	query := `SELECT id, trid, lang, vendor_id, category_id, name, slug, price_usd, status, is_variable, images
	          FROM products ` + where +
		fmt.Sprintf(" ORDER BY id LIMIT %d OFFSET %d", pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	items := []map[string]any{}
	for rows.Next() {
		var id, vendorID, categoryID int64
		var price float64
		var trid, l, name, slug, status string
		var isVar bool
		var images []byte
		if err := rows.Scan(&id, &trid, &l, &vendorID, &categoryID, &name, &slug, &price, &status, &isVar, &images); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		items = append(items, productToWooShape(id, trid, l, vendorID, categoryID, name, slug, "", price, status, isVar, images, nil))
	}

	kit.JSON(w, 200, map[string]any{
		// items/page/page_size/total/has_more : forme native du service.
		// products/total_pages : alias pour compatibilité avec le frontend
		// actuel qui lit la pagination WooCommerce (x-wp-total en header,
		// pas dans le body — voir aussi kit.Run côté headers HTTP).
		"items": items, "products": items,
		"page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
		"total_pages": (total + int64(pageSize) - 1) / int64(pageSize),
	})
}

// productToWooShape — même forme de champs que la réponse WooCommerce REST
// que le frontend attend aujourd'hui (lib/woocommerce.ts, lib/woo-server.ts) :
// price en STRING décimale, images en objets {src}, categories en tableau
// d'objets. Objectif : que app/api/products/route.ts puisse lire cette
// réponse sans réécriture, une fois pointé sur catalog-svc au lieu de
// wc/v3/products. Le prix est en USD réel (voir schema ci-dessus).
func productToWooShape(id int64, trid, lang string, vendorID, categoryID int64, name, slug, description string, priceUSD float64, status string, isVariable bool, imagesJSON []byte, variations []map[string]any) map[string]any {
	priceStr := strconv.FormatFloat(priceUSD, 'f', 2, 64)

	var rawImages []string
	_ = json.Unmarshal(imagesJSON, &rawImages)
	images := make([]map[string]any, 0, len(rawImages))
	for _, url := range rawImages {
		images = append(images, map[string]any{"src": url})
	}
	var mainImage string
	if len(rawImages) > 0 {
		mainImage = rawImages[0]
	}

	out := map[string]any{
		"id": id, "trid": trid, "lang": lang,
		"vendor_id": vendorID, "category_id": categoryID,
		"name": name, "slug": slug, "description": description,
		"price": priceStr, "regular_price": priceStr, "sale_price": "",
		"price_usd": priceUSD, "currency": "USD",
		"image": mainImage, "images": images,
		"status": status, "type": variableOrSimple(isVariable), "is_variable": isVariable,
	}
	if variations != nil {
		out["variations"] = variations
	}
	return out
}

func variableOrSimple(isVariable bool) string {
	if isVariable {
		return "variable"
	}
	return "simple"
}

func (s *server) getProduct(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	lang := defLang(r.URL.Query().Get("lang"))
	row := s.db.QueryRow(r.Context(), `
		SELECT p.id, p.trid, p.lang, p.vendor_id, p.category_id, p.name, p.slug,
		       p.description, p.price_usd, p.status, p.images, p.is_variable
		FROM products p WHERE p.id = $1 AND p.lang = $2`, id, lang)

	var pID, vendorID, catID int64
	var price float64
	var trid, l, name, slug, desc, status string
	var images []byte
	var isVar bool
	if err := row.Scan(&pID, &trid, &l, &vendorID, &catID, &name, &slug, &desc, &price, &status, &images, &isVar); err != nil {
		if err == pgx.ErrNoRows {
			kit.Fail(w, 404, "product_not_found", fmt.Sprintf("produit %d introuvable en lang=%s — erreur explicite, pas de page vide silencieuse", id, lang))
			return
		}
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	// Variante liée (autre langue du même trid) — le frontend affiche le switch FR/EN.
	var linkedID int64
	var linkedLang string
	_ = s.db.QueryRow(r.Context(),
		`SELECT id, lang FROM products WHERE trid = $1 AND lang <> $2 LIMIT 1`, trid, l,
	).Scan(&linkedID, &linkedLang)

	var variations []map[string]any
	if isVar {
		variations = []map[string]any{}
		rows, _ := s.db.Query(r.Context(),
			`SELECT id, sku, attributes, price_usd, stock, image_url FROM product_variations WHERE product_id = $1 ORDER BY id`, id)
		if rows != nil {
			defer rows.Close()
			for rows.Next() {
				var vid int64
				var vprice float64
				var sku, img string
				var attrs []byte
				var stock int
				_ = rows.Scan(&vid, &sku, &attrs, &vprice, &stock, &img)
				variations = append(variations, map[string]any{
					"id": vid, "sku": sku, "attributes": json.RawMessage(attrs),
					"price": strconv.FormatFloat(vprice, 'f', 2, 64), "price_usd": vprice,
					"stock": stock, "in_stock": stock > 0, "image_url": img,
				})
			}
		}
	}

	out := productToWooShape(pID, trid, l, vendorID, catID, name, slug, desc, price, status, isVar, images, variations)
	out["linked"] = map[string]any{"id": linkedID, "lang": linkedLang}
	// Compat WPML : le frontend lit p.translations pour le switch FR/EN.
	if linkedID != 0 {
		out["translations"] = map[string]any{linkedLang: linkedID}
	}
	kit.JSON(w, 200, out)
}

// similar — l'intégration Vectorize existante reste branchée ici.
// Signalé EXPLICITEMENT tant que non câblé : pas de 404/500 muet.
func (s *server) similar(w http.ResponseWriter, r *http.Request) {
	kit.Fail(w, 501, "not_implemented_yet",
		"similar-products via Cloudflare Vectorize : conserver l'appel existant du frontend jusqu'au branchement de catalog-svc sur l'index Vectorize (phase 3)")
}

func (s *server) listCategories(w http.ResponseWriter, r *http.Request) {
	lang := defLang(r.URL.Query().Get("lang"))
	// LEFT JOIN products actifs pour compter — le frontend trie les
	// catégories par popularité (productCount), le compte doit donc
	// être exact à la lecture, pas dénormalisé/en retard.
	rows, err := s.db.Query(r.Context(), `
		SELECT c.id, c.trid, c.parent_id, c.name, c.slug, c.image_url,
		       (SELECT count(*) FROM products p WHERE p.category_id = c.id AND p.lang = c.lang AND p.status = 'active')
		FROM categories c WHERE c.lang = $1 ORDER BY c.id`, lang)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, parent, count int64
		var trid, name, slug, img string
		_ = rows.Scan(&id, &trid, &parent, &name, &slug, &img, &count)
		items = append(items, map[string]any{
			"id": id, "trid": trid, "parent_id": parent, "parent": parent,
			"name": name, "slug": slug,
			"image": map[string]any{"src": img}, "image_url": img,
			"productCount": count, "count": count,
			"isRoot": parent == 0,
		})
	}
	// roots : forme native du service. categories : alias attendu par
	// app/api/categories/route.ts (frontend actuel).
	kit.JSON(w, 200, map[string]any{"roots": items, "categories": items, "lang": lang})
}

func (s *server) suggestions(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if len(q) < 2 {
		kit.JSON(w, 200, map[string]any{"suggestions": []string{}})
		return
	}
	lang := defLang(r.URL.Query().Get("lang"))
	rows, err := s.db.Query(r.Context(), `
		SELECT DISTINCT name FROM products
		WHERE lang = $1 AND name ILIKE $2 ORDER BY name LIMIT 8`,
		lang, q+"%")
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var n string
		_ = rows.Scan(&n)
		out = append(out, n)
	}
	kit.JSON(w, 200, map[string]any{"suggestions": out})
}

// createProduct — une transaction locale crée la paire trid (fr+en)
// puis publie product.created ; vendor/notification réagissent sans couplage.
func (s *server) createProduct(w http.ResponseWriter, r *http.Request) {
	var body struct {
		VendorID   int64            `json:"vendor_id"`
		NameFR     string           `json:"name_fr"`
		NameEN     string           `json:"name_en"`
		PriceUSD   float64          `json:"price_usd"`
		CategoryID int64            `json:"category_id"`
		Images     []string         `json:"images"`
		IsVariable bool             `json:"is_variable"`
		Variations []map[string]any `json:"variations"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", "JSON attendu : "+err.Error())
		return
	}
	if body.NameFR == "" || body.VendorID == 0 {
		kit.Fail(w, 400, "missing_fields", "vendor_id et name_fr sont obligatoires")
		return
	}

	trid := fmt.Sprintf("tr-%d", time.Now().UnixNano())
	imagesJSON, _ := json.Marshal(body.Images)
	ctx := r.Context()

	tx, err := s.db.Begin(ctx)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	insertLang := func(lang, name string) (int64, error) {
		var id int64
		err := tx.QueryRow(ctx, `
			INSERT INTO products (trid, lang, vendor_id, category_id, name, slug, price_usd, images, is_variable)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
			trid, lang, body.VendorID, body.CategoryID, name, slugify(name), body.PriceUSD, imagesJSON, body.IsVariable,
		).Scan(&id)
		return id, err
	}
	idFR, err := insertLang("fr", body.NameFR)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	nameEN := body.NameEN
	if nameEN == "" {
		nameEN = body.NameFR // fallback explicite : EN = FR tant que non traduit
	}
	idEN, err := insertLang("en", nameEN)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	for _, v := range body.Variations {
		attrs, _ := json.Marshal(v["attributes"])
		if _, err := tx.Exec(ctx, `
			INSERT INTO product_variations (product_id, sku, attributes, price_usd, stock, image_url)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			idFR, v["sku"], attrs, toFloat(v["price_usd"]), toInt(v["stock"]), v["image_url"]); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	kit.Publish(s.kafka, "product.created", trid, map[string]any{
		"trid": trid, "ids": []int64{idFR, idEN}, "vendor_id": body.VendorID,
		"at": time.Now().UTC().Format(time.RFC3339),
	})

	kit.JSON(w, 201, map[string]any{"trid": trid, "ids": []int64{idFR, idEN}})
}

// ---------- helpers ----------

func def(v, d string) string {
	if v == "" {
		return d
	}
	return v
}
func defLang(l string) string {
	if l == "en" {
		return "en"
	}
	return "fr"
}
func atoi(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}
func toInt(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case int64:
		return t
	}
	return 0
}
func toFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int64:
		return float64(t)
	}
	return 0
}
func slugify(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range []rune(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			out = append(out, r)
		case r >= 'A' && r <= 'Z':
			out = append(out, r+32)
		case r == ' ', r == '-', r == '_':
			out = append(out, '-')
		}
	}
	return string(out)
}

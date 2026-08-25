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
	"strings"
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
  sale_price_usd DOUBLE PRECISION, -- NULL = pas en promo ; USD réel comme price_usd
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
CREATE INDEX IF NOT EXISTS idx_products_slug    ON products (slug);
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products (name); -- + extension pg_trgm en prod
ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_price_usd DOUBLE PRECISION;
-- Back-office admin (module Catalogue) : un produit simple n'avait ni
-- SKU/stock propres (seules les variations en avaient) ni marque/poids/SEO.
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INT NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_threshold INT NOT NULL DEFAULT 3;
ALTER TABLE products ADD COLUMN IF NOT EXISTS backorders_allowed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS brand_id BIGINT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_kg DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS length_cm DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS width_cm DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS height_cm DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shipping_class TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS short_description TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS meta_title TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS meta_description TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_products_sku ON products (sku) WHERE sku <> '';
CREATE INDEX IF NOT EXISTS idx_products_brand ON products (brand_id);

CREATE TABLE IF NOT EXISTS brands (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  logo_url    TEXT DEFAULT '',
  description TEXT DEFAULT '',
  website_url TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
ALTER TABLE categories ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS commission_rate DOUBLE PRECISION; -- NULL = taux global de la plateforme (loyalty-svc), sinon override

CREATE TABLE IF NOT EXISTS attributes (
  id   BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS attribute_values (
  id           BIGSERIAL PRIMARY KEY,
  attribute_id BIGINT NOT NULL REFERENCES attributes(id) ON DELETE CASCADE,
  value        TEXT NOT NULL,  -- ex: "Rouge"
  meta         TEXT DEFAULT '' -- ex: code hex #FF0000 pour un attribut Couleur
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
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'; -- pending/approved/rejected — modération admin
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS admin_reply TEXT DEFAULT '';
`

type server struct {
	db       *pgxpool.Pool
	kafka    sarama.SyncProducer
	orderURL string
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

	s := &server{
		db:       db,
		kafka:    kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		orderURL: kit.Env("ORDER_SVC_URL", "http://order-svc:8083"),
	}

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
		mux.HandleFunc("GET /products/variations", s.listVariationsBatch)
		mux.HandleFunc("GET /products/{id}/reviews", s.listReviews)
		mux.HandleFunc("POST /products/{id}/reviews", s.createReview)
		mux.HandleFunc("GET /reviews", s.listReviewsAdmin)
		mux.HandleFunc("PATCH /reviews/{id}", s.moderateReview)
		mux.HandleFunc("GET /categories", s.listCategories)
		mux.HandleFunc("GET /search/suggestions", s.suggestions)
		mux.HandleFunc("POST /vendor/products", s.createProduct)
		mux.HandleFunc("PUT /products/{id}/images", s.updateProductImages)
		mux.HandleFunc("PATCH /products/{id}", s.updateProduct)
		mux.HandleFunc("DELETE /products/{id}", s.deleteProduct)
		mux.HandleFunc("POST /products/bulk", s.bulkUpdateProducts)
		mux.HandleFunc("GET /brands", s.listBrands)
		mux.HandleFunc("POST /brands", s.createBrand)
		mux.HandleFunc("PATCH /brands/{id}", s.updateBrand)
		mux.HandleFunc("DELETE /brands/{id}", s.deleteBrand)
		mux.HandleFunc("POST /categories", s.createCategory)
		mux.HandleFunc("PATCH /categories/{id}", s.updateCategory)
		mux.HandleFunc("DELETE /categories/{id}", s.deleteCategory)
		mux.HandleFunc("POST /categories/reorder", s.reorderCategories)
		mux.HandleFunc("GET /attributes", s.listAttributes)
		mux.HandleFunc("POST /attributes", s.createAttribute)
		mux.HandleFunc("DELETE /attributes/{id}", s.deleteAttribute)
		mux.HandleFunc("POST /attributes/{id}/values", s.addAttributeValue)
		mux.HandleFunc("DELETE /attribute-values/{id}", s.deleteAttributeValue)
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
	where := "WHERE lang = $1"
	// admin=true (back-office uniquement, jamais le storefront public) lève
	// le filtre "actifs seulement" pour laisser ?status= choisir librement —
	// sans ce param, le comportement public existant ne change pas.
	if q.Get("admin") == "true" {
		if v := q.Get("status"); v != "" {
			where += fmt.Sprintf(" AND status = $%d", len(args)+1)
			args = append(args, v)
		}
	} else {
		where += " AND status = 'active'"
	}
	if v := q.Get("category_id"); v != "" {
		where += fmt.Sprintf(" AND category_id = $%d", len(args)+1)
		args = append(args, atoi(v))
	}
	if v := q.Get("vendor_id"); v != "" {
		where += fmt.Sprintf(" AND vendor_id = $%d", len(args)+1)
		args = append(args, atoi(v))
	}
	if v := q.Get("q"); v != "" {
		where += fmt.Sprintf(" AND (name ILIKE $%d OR sku ILIKE $%d)", len(args)+1, len(args)+1)
		args = append(args, "%"+v+"%")
	}
	if v := q.Get("slug"); v != "" {
		where += fmt.Sprintf(" AND slug = $%d", len(args)+1)
		args = append(args, v)
	}
	if v := q.Get("on_sale"); v == "true" {
		where += " AND sale_price_usd IS NOT NULL AND sale_price_usd < price_usd"
	}

	// include=id1,id2,... : résolution batch par IDs (recherche sémantique,
	// panier, produits d'un vendeur) — remplace la pagination LIMIT/OFFSET
	// normale par un simple filtre id = ANY(...), plafonné à 200 IDs pour
	// éviter un abus (une seule requête, pas de round-trips N+1 côté appelant).
	var includeIDs []int64
	if v := q.Get("include"); v != "" {
		for _, part := range strings.Split(v, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			if id := atoi(part); id > 0 {
				includeIDs = append(includeIDs, id)
			}
		}
		if len(includeIDs) > 200 {
			includeIDs = includeIDs[:200]
		}
		where += fmt.Sprintf(" AND id = ANY($%d)", len(args)+1)
		args = append(args, includeIDs)
	}

	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM products "+where, args...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	query := `SELECT id, trid, lang, vendor_id, category_id, name, slug, price_usd, sale_price_usd, status, is_variable, images, sku, stock, low_stock_threshold, brand_id
	          FROM products ` + where + " ORDER BY id"
	if includeIDs == nil {
		query += fmt.Sprintf(" LIMIT %d OFFSET %d", pageSize, (page-1)*pageSize)
	}
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	items := []map[string]any{}
	for rows.Next() {
		var id, vendorID, categoryID, brandID int64
		var price float64
		var salePrice *float64
		var trid, l, name, slug, status, sku string
		var isVar bool
		var images []byte
		var stock, lowStockThreshold int
		if err := rows.Scan(&id, &trid, &l, &vendorID, &categoryID, &name, &slug, &price, &salePrice, &status, &isVar, &images, &sku, &stock, &lowStockThreshold, &brandID); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		item := productToWooShape(id, trid, l, vendorID, categoryID, name, slug, "", price, salePrice, status, isVar, images, nil)
		item["sku"] = sku
		item["stock"] = stock
		item["low_stock_threshold"] = lowStockThreshold
		item["brand_id"] = brandID
		items = append(items, item)
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
func productToWooShape(id int64, trid, lang string, vendorID, categoryID int64, name, slug, description string, priceUSD float64, salePriceUSD *float64, status string, isVariable bool, imagesJSON []byte, variations []map[string]any) map[string]any {
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

	// on_sale : vrai seulement si un sale_price_usd est renseigné ET
	// strictement inférieur au prix normal — cohérent avec le filtre
	// ?on_sale=true de listProducts (même condition des deux côtés).
	salePriceStr := ""
	onSale := false
	if salePriceUSD != nil && *salePriceUSD < priceUSD {
		salePriceStr = strconv.FormatFloat(*salePriceUSD, 'f', 2, 64)
		onSale = true
	}

	out := map[string]any{
		"id": id, "trid": trid, "lang": lang,
		"vendor_id": vendorID, "category_id": categoryID,
		"name": name, "slug": slug, "description": description,
		"price": priceStr, "regular_price": priceStr, "sale_price": salePriceStr,
		"price_usd": priceUSD, "currency": "USD", "on_sale": onSale,
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
		       p.description, p.price_usd, p.sale_price_usd, p.status, p.images, p.is_variable
		FROM products p WHERE p.id = $1 AND p.lang = $2`, id, lang)

	var pID, vendorID, catID int64
	var price float64
	var salePrice *float64
	var trid, l, name, slug, desc, status string
	var images []byte
	var isVar bool
	if err := row.Scan(&pID, &trid, &l, &vendorID, &catID, &name, &slug, &desc, &price, &salePrice, &status, &images, &isVar); err != nil {
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

	out := productToWooShape(pID, trid, l, vendorID, catID, name, slug, desc, price, salePrice, status, isVar, images, variations)
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

// listVariationsBatch — variations de plusieurs produits en une requête,
// pour éviter au frontend de faire N appels GET /products/{id} juste pour
// récupérer les variations d'une page de listing entière.
// GET /products/variations?ids=1,2,3 -> {"variations": {"1": [...], "2": [...]}}
func (s *server) listVariationsBatch(w http.ResponseWriter, r *http.Request) {
	var ids []int64
	for _, part := range strings.Split(r.URL.Query().Get("ids"), ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if id := atoi(part); id > 0 {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		kit.JSON(w, 200, map[string]any{"variations": map[string]any{}})
		return
	}
	if len(ids) > 200 {
		ids = ids[:200]
	}

	rows, err := s.db.Query(r.Context(),
		`SELECT id, product_id, sku, attributes, price_usd, stock, image_url
		 FROM product_variations WHERE product_id = ANY($1) ORDER BY product_id, id`, ids)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	out := map[string][]map[string]any{}
	for rows.Next() {
		var vid, productID int64
		var vprice float64
		var sku, img string
		var attrs []byte
		var stock int
		if err := rows.Scan(&vid, &productID, &sku, &attrs, &vprice, &stock, &img); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		key := strconv.FormatInt(productID, 10)
		out[key] = append(out[key], map[string]any{
			"id": vid, "sku": sku, "attributes": json.RawMessage(attrs),
			"price": strconv.FormatFloat(vprice, 'f', 2, 64), "price_usd": vprice,
			"stock": stock, "in_stock": stock > 0, "image_url": img,
		})
	}
	kit.JSON(w, 200, map[string]any{"variations": out})
}

// listReviews — avis paginés d'un produit + note moyenne/nombre calculés
// dans la même réponse (évite un second aller-retour pour l'en-tête de
// la fiche produit qui affiche déjà average_rating/rating_count).
func (s *server) listReviews(w http.ResponseWriter, r *http.Request) {
	productID := atoi(r.PathValue("id"))
	page, _ := strconv.Atoi(def(r.URL.Query().Get("page"), "1"))
	pageSize, _ := strconv.Atoi(def(r.URL.Query().Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}

	// Le storefront public (aucun avis modéré par défaut, status='pending')
	// ne doit voir que les avis approuvés — l'admin les voit tous via
	// listReviewsAdmin, jamais cette route.
	var total int64
	var avgRating float64
	if err := s.db.QueryRow(r.Context(),
		`SELECT count(*), COALESCE(AVG(rating), 0) FROM reviews WHERE product_id = $1 AND status = 'approved'`, productID,
	).Scan(&total, &avgRating); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	rows, err := s.db.Query(r.Context(), `
		SELECT id, customer_id, order_id, rating, comment, verified_purchase, created_at
		FROM reviews WHERE product_id = $1 AND status = 'approved'
		ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
		productID, pageSize, (page-1)*pageSize)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	items := []map[string]any{}
	for rows.Next() {
		var id, customerID int64
		var orderID *int64
		var rating int
		var comment string
		var verified bool
		var createdAt time.Time
		if err := rows.Scan(&id, &customerID, &orderID, &rating, &comment, &verified, &createdAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		items = append(items, map[string]any{
			"id": id, "customer_id": customerID, "order_id": orderID,
			"rating": rating, "comment": comment, "verified_purchase": verified,
			"created_at": createdAt.UTC().Format(time.RFC3339),
		})
	}

	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
		"average_rating": avgRating, "rating_count": total,
	})
}

// listReviewsAdmin — tous les avis, toutes langues/produits confondus,
// pour la file de modération du back-office (contrairement à listReviews
// qui est filtré à un seul produit et n'expose que les avis approuvés).
func (s *server) listReviewsAdmin(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(def(q.Get("page"), "1"))
	pageSize, _ := strconv.Atoi(def(q.Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	where := "WHERE 1=1"
	args := []any{}
	if v := q.Get("status"); v != "" {
		args = append(args, v)
		where += fmt.Sprintf(" AND rv.status = $%d", len(args))
	}

	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM reviews rv "+where, args...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(r.Context(), fmt.Sprintf(`
		SELECT rv.id, rv.product_id, p.name, rv.customer_id, rv.rating, rv.comment,
		       rv.verified_purchase, rv.status, rv.admin_reply, rv.created_at
		FROM reviews rv
		LEFT JOIN products p ON p.id = rv.product_id AND p.lang = 'fr'
		%s ORDER BY rv.created_at DESC LIMIT $%d OFFSET $%d`, where, len(args)-1, len(args)), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	items := []map[string]any{}
	for rows.Next() {
		var id, productID, customerID int64
		var rating int
		var productName, comment, status, adminReply string
		var verified bool
		var createdAt time.Time
		if err := rows.Scan(&id, &productID, &productName, &customerID, &rating, &comment, &verified, &status, &adminReply, &createdAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		items = append(items, map[string]any{
			"id": id, "product_id": productID, "product_name": productName,
			"customer_id": customerID, "rating": rating, "comment": comment,
			"verified_purchase": verified, "status": status, "admin_reply": adminReply,
			"created_at": createdAt.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

// moderateReview — approuve/rejette un avis, avec réponse admin optionnelle.
func (s *server) moderateReview(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	var body struct {
		Status     *string `json:"status"`
		AdminReply *string `json:"admin_reply"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	set := []string{}
	args := []any{}
	add := func(col string, v any) {
		args = append(args, v)
		set = append(set, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	if body.Status != nil {
		if *body.Status != "approved" && *body.Status != "rejected" && *body.Status != "pending" {
			kit.Fail(w, 400, "invalid_status", "status doit être pending, approved ou rejected")
			return
		}
		add("status", *body.Status)
	}
	if body.AdminReply != nil {
		add("admin_reply", *body.AdminReply)
	}
	if len(set) == 0 {
		kit.Fail(w, 400, "empty_update", "aucun champ à modifier fourni")
		return
	}
	args = append(args, id)
	tag, err := s.db.Exec(r.Context(),
		fmt.Sprintf("UPDATE reviews SET %s WHERE id = $%d", strings.Join(set, ", "), len(args)), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "review_not_found", fmt.Sprintf("avis %d introuvable", id))
		return
	}
	kit.JSON(w, 200, map[string]any{"id": id, "updated": true})
}

// createReview — verified_purchase est déterminé au mieux : si order_id
// est fourni, on vérifie via order-svc que la commande appartient bien à
// ce client et contient bien ce produit ; en cas de doute ou d'échec
// réseau, le commentaire est accepté quand même mais SANS le badge vérifié
// (jamais bloquant pour l'utilisateur — order-svc peut être temporairement
// indisponible sans empêcher les avis).
func (s *server) createReview(w http.ResponseWriter, r *http.Request) {
	productID := atoi(r.PathValue("id"))
	var body struct {
		CustomerID int64  `json:"customer_id"`
		OrderID    *int64 `json:"order_id"`
		Rating     int    `json:"rating"`
		Comment    string `json:"comment"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", "JSON attendu : "+err.Error())
		return
	}
	if body.CustomerID == 0 || body.Rating < 1 || body.Rating > 5 {
		kit.Fail(w, 400, "missing_fields", "customer_id et rating (1-5) sont obligatoires")
		return
	}

	verified := false
	if body.OrderID != nil {
		verified = s.verifyPurchase(r.Context(), *body.OrderID, body.CustomerID, productID)
	}

	var id int64
	err := s.db.QueryRow(r.Context(), `
		INSERT INTO reviews (product_id, customer_id, order_id, rating, comment, verified_purchase)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
		productID, body.CustomerID, body.OrderID, body.Rating, body.Comment, verified,
	).Scan(&id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 201, map[string]any{"id": id, "verified_purchase": verified})
}

func (s *server) verifyPurchase(ctx context.Context, orderID, customerID int64, productID int64) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/orders/%d", s.orderURL, orderID), nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		return false
	}
	defer resp.Body.Close()
	var order struct {
		CustomerID int64 `json:"customer_id"`
		Lines      []struct {
			ProductID int64 `json:"product_id"`
		} `json:"lines"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&order); err != nil {
		return false
	}
	if order.CustomerID != customerID {
		return false
	}
	for _, l := range order.Lines {
		if l.ProductID == productID {
			return true
		}
	}
	return false
}

func (s *server) listCategories(w http.ResponseWriter, r *http.Request) {
	lang := defLang(r.URL.Query().Get("lang"))
	// LEFT JOIN products actifs pour compter — le frontend trie les
	// catégories par popularité (productCount), le compte doit donc
	// être exact à la lecture, pas dénormalisé/en retard.
	rows, err := s.db.Query(r.Context(), `
		SELECT c.id, c.trid, c.parent_id, c.name, c.slug, c.image_url, c.sort_order, c.commission_rate,
		       (SELECT count(*) FROM products p WHERE p.category_id = c.id AND p.lang = c.lang AND p.status = 'active')
		FROM categories c WHERE c.lang = $1 ORDER BY c.sort_order, c.id`, lang)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, parent, count, sortOrder int64
		var trid, name, slug, img string
		var commissionRate *float64
		_ = rows.Scan(&id, &trid, &parent, &name, &slug, &img, &sortOrder, &commissionRate, &count)
		items = append(items, map[string]any{
			"id": id, "trid": trid, "parent_id": parent, "parent": parent,
			"name": name, "slug": slug,
			"image": map[string]any{"src": img}, "image_url": img,
			"productCount": count, "count": count,
			"isRoot": parent == 0,
			"sort_order": sortOrder, "commission_rate": commissionRate,
		})
	}
	// roots : forme native du service. categories : alias attendu par
	// app/api/categories/route.ts (frontend actuel).
	kit.JSON(w, 200, map[string]any{"roots": items, "categories": items, "lang": lang})
}

func (s *server) createCategory(w http.ResponseWriter, r *http.Request) {
	var body struct {
		NameFR         string   `json:"name_fr"`
		NameEN         string   `json:"name_en"`
		ParentID       int64    `json:"parent_id"`
		ImageURL       string   `json:"image_url"`
		CommissionRate *float64 `json:"commission_rate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.NameFR == "" {
		kit.Fail(w, 400, "missing_name", "name_fr requis")
		return
	}
	nameEN := body.NameEN
	if nameEN == "" {
		nameEN = body.NameFR
	}
	trid := fmt.Sprintf("cat-%d", time.Now().UnixNano())
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	var idFR int64
	insertLang := func(lang, name string) (int64, error) {
		var id int64
		err := tx.QueryRow(ctx, `
			INSERT INTO categories (trid, lang, parent_id, name, slug, image_url, commission_rate)
			VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
			trid, lang, nullIfZero(body.ParentID), name, slugify(name), body.ImageURL, body.CommissionRate,
		).Scan(&id)
		return id, err
	}
	idFR, err = insertLang("fr", body.NameFR)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if _, err := insertLang("en", nameEN); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 201, map[string]any{"id": idFR, "trid": trid})
}

func (s *server) updateCategory(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	var body struct {
		Name           *string  `json:"name"`
		ParentID       *int64   `json:"parent_id"`
		ImageURL       *string  `json:"image_url"`
		SortOrder      *int64   `json:"sort_order"`
		CommissionRate *float64 `json:"commission_rate"`
		ClearCommission bool    `json:"clear_commission"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	set := []string{}
	args := []any{}
	add := func(col string, v any) {
		args = append(args, v)
		set = append(set, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	if body.Name != nil {
		add("name", *body.Name)
		add("slug", slugify(*body.Name))
	}
	if body.ParentID != nil {
		add("parent_id", nullIfZero(*body.ParentID))
	}
	if body.ImageURL != nil {
		add("image_url", *body.ImageURL)
	}
	if body.SortOrder != nil {
		add("sort_order", *body.SortOrder)
	}
	if body.ClearCommission {
		add("commission_rate", nil)
	} else if body.CommissionRate != nil {
		add("commission_rate", *body.CommissionRate)
	}
	if len(set) == 0 {
		kit.Fail(w, 400, "empty_update", "aucun champ à modifier fourni")
		return
	}
	args = append(args, id)
	tag, err := s.db.Exec(r.Context(),
		fmt.Sprintf("UPDATE categories SET %s WHERE id = $%d", strings.Join(set, ", "), len(args)), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "category_not_found", fmt.Sprintf("catégorie %d introuvable", id))
		return
	}
	kit.JSON(w, 200, map[string]any{"id": id, "updated": true})
}

func (s *server) deleteCategory(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	var productCount int64
	_ = s.db.QueryRow(r.Context(), "SELECT count(*) FROM products WHERE category_id = $1", id).Scan(&productCount)
	if productCount > 0 {
		kit.Fail(w, 409, "category_in_use", fmt.Sprintf("%d produit(s) utilisent encore cette catégorie — réassignez-les avant suppression", productCount))
		return
	}
	tag, err := s.db.Exec(r.Context(), "DELETE FROM categories WHERE id = $1", id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "category_not_found", fmt.Sprintf("catégorie %d introuvable", id))
		return
	}
	kit.JSON(w, 200, map[string]any{"id": id, "deleted": true})
}

// reorderCategories — drag & drop dans l'arbre : reçoit la liste ordonnée
// des ids (même trid des deux langues suit le même ordre) et réécrit
// sort_order en une seule requête par ligne, dans une transaction.
func (s *server) reorderCategories(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)
	for i, id := range body.IDs {
		if _, err := tx.Exec(ctx, "UPDATE categories SET sort_order = $1 WHERE id = $2", i, id); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"reordered": len(body.IDs)})
}

// ---------- attributs & valeurs (Couleur, Pointure, ...) ----------

func (s *server) listAttributes(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `
		SELECT a.id, a.name, a.slug, v.id, v.value, v.meta
		FROM attributes a
		LEFT JOIN attribute_values v ON v.attribute_id = a.id
		ORDER BY a.name, v.value`)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	type attr struct {
		ID     int64            `json:"id"`
		Name   string           `json:"name"`
		Slug   string           `json:"slug"`
		Values []map[string]any `json:"values"`
	}
	order := []int64{}
	byID := map[int64]*attr{}
	for rows.Next() {
		var aID int64
		var aName, aSlug string
		var vID *int64
		var vValue, vMeta *string
		if err := rows.Scan(&aID, &aName, &aSlug, &vID, &vValue, &vMeta); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		a, ok := byID[aID]
		if !ok {
			a = &attr{ID: aID, Name: aName, Slug: aSlug, Values: []map[string]any{}}
			byID[aID] = a
			order = append(order, aID)
		}
		if vID != nil {
			a.Values = append(a.Values, map[string]any{"id": *vID, "value": *vValue, "meta": *vMeta})
		}
	}
	items := make([]*attr, 0, len(order))
	for _, id := range order {
		items = append(items, byID[id])
	}
	kit.JSON(w, 200, map[string]any{"items": items, "total": len(items)})
}

func (s *server) createAttribute(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name   string   `json:"name"`
		Values []string `json:"values"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Name == "" {
		kit.Fail(w, 400, "missing_name", "name requis")
		return
	}
	var id int64
	err := s.db.QueryRow(r.Context(),
		"INSERT INTO attributes (name, slug) VALUES ($1,$2) RETURNING id", body.Name, slugify(body.Name),
	).Scan(&id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	for _, v := range body.Values {
		if v == "" {
			continue
		}
		if _, err := s.db.Exec(r.Context(),
			"INSERT INTO attribute_values (attribute_id, value) VALUES ($1,$2)", id, v); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
	}
	kit.JSON(w, 201, map[string]any{"id": id})
}

func (s *server) deleteAttribute(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	tag, err := s.db.Exec(r.Context(), "DELETE FROM attributes WHERE id = $1", id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "attribute_not_found", fmt.Sprintf("attribut %d introuvable", id))
		return
	}
	kit.JSON(w, 200, map[string]any{"id": id, "deleted": true})
}

func (s *server) addAttributeValue(w http.ResponseWriter, r *http.Request) {
	attrID := atoi(r.PathValue("id"))
	var body struct {
		Value string `json:"value"`
		Meta  string `json:"meta"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Value == "" {
		kit.Fail(w, 400, "missing_value", "value requis")
		return
	}
	var id int64
	err := s.db.QueryRow(r.Context(),
		"INSERT INTO attribute_values (attribute_id, value, meta) VALUES ($1,$2,$3) RETURNING id",
		attrID, body.Value, body.Meta,
	).Scan(&id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 201, map[string]any{"id": id})
}

func (s *server) deleteAttributeValue(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	tag, err := s.db.Exec(r.Context(), "DELETE FROM attribute_values WHERE id = $1", id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "attribute_value_not_found", fmt.Sprintf("valeur %d introuvable", id))
		return
	}
	kit.JSON(w, 200, map[string]any{"id": id, "deleted": true})
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
		BrandID    int64            `json:"brand_id"`
		SKU        string           `json:"sku"`
		Barcode    string           `json:"barcode"`
		Stock      int              `json:"stock"`
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
			INSERT INTO products (trid, lang, vendor_id, category_id, brand_id, name, slug, price_usd, images, is_variable, sku, barcode, stock)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
			trid, lang, body.VendorID, body.CategoryID, nullIfZero(body.BrandID), name, slugify(name), body.PriceUSD, imagesJSON, body.IsVariable,
			body.SKU, body.Barcode, body.Stock,
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

// updateProductImages remplace la liste d'images d'un produit. Le
// paramètre {id} du chemin peut être soit l'id interne catalog-svc, soit
// (avec ?by=wc_id) l'ancien id WooCommerce — utile pour cmd/migrate-images
// qui ne connaît que le wc_id d'origine, pas l'id interne réattribué à
// l'import. Met à jour TOUTES les lignes du même trid (fr + en) : images
// est dupliqué par langue dans le modèle actuel (voir createProduct),
// jamais une langue seule.
func (s *server) updateProductImages(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Images []string `json:"images"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", "JSON attendu : "+err.Error())
		return
	}

	idParam := r.PathValue("id")
	column := "id"
	if r.URL.Query().Get("by") == "wc_id" {
		column = "wc_id"
	}

	var trid string
	if err := s.db.QueryRow(r.Context(),
		"SELECT trid FROM products WHERE "+column+" = $1", idParam,
	).Scan(&trid); err != nil {
		kit.Fail(w, 404, "product_not_found", fmt.Sprintf("aucun produit avec %s=%s", column, idParam))
		return
	}

	imagesJSON, _ := json.Marshal(body.Images)
	tag, err := s.db.Exec(r.Context(),
		"UPDATE products SET images = $1 WHERE trid = $2", imagesJSON, trid)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"trid": trid, "rows_updated": tag.RowsAffected()})
}

// updateProduct — édition admin d'UNE langue d'un produit (le back-office
// édite fr et en séparément, chacune ayant son propre id). Tous les champs
// sont optionnels dans le body : seuls ceux présents (pointeurs non-nil)
// sont modifiés, pour permettre un PATCH partiel depuis l'UI (ex: juste le
// stock depuis le toggle rapide) sans devoir renvoyer tout le produit.
func (s *server) updateProduct(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	var body struct {
		Name              *string  `json:"name"`
		Description       *string  `json:"description"`
		ShortDescription  *string  `json:"short_description"`
		CategoryID        *int64   `json:"category_id"`
		BrandID           *int64   `json:"brand_id"`
		PriceUSD          *float64 `json:"price_usd"`
		SalePriceUSD      *float64 `json:"sale_price_usd"`
		SKU               *string  `json:"sku"`
		Barcode           *string  `json:"barcode"`
		Stock             *int     `json:"stock"`
		LowStockThreshold *int     `json:"low_stock_threshold"`
		BackordersAllowed *bool    `json:"backorders_allowed"`
		WeightKg          *float64 `json:"weight_kg"`
		LengthCm          *float64 `json:"length_cm"`
		WidthCm           *float64 `json:"width_cm"`
		HeightCm          *float64 `json:"height_cm"`
		ShippingClass     *string  `json:"shipping_class"`
		MetaTitle         *string  `json:"meta_title"`
		MetaDescription   *string  `json:"meta_description"`
		Images            *[]string `json:"images"`
		Status            *string  `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", "JSON attendu : "+err.Error())
		return
	}

	set := []string{}
	args := []any{}
	add := func(col string, v any) {
		args = append(args, v)
		set = append(set, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	if body.Name != nil {
		add("name", *body.Name)
	}
	if body.Description != nil {
		add("description", *body.Description)
	}
	if body.ShortDescription != nil {
		add("short_description", *body.ShortDescription)
	}
	if body.CategoryID != nil {
		add("category_id", *body.CategoryID)
	}
	if body.BrandID != nil {
		add("brand_id", nullIfZero(*body.BrandID))
	}
	if body.PriceUSD != nil {
		add("price_usd", *body.PriceUSD)
	}
	if body.SalePriceUSD != nil {
		add("sale_price_usd", *body.SalePriceUSD)
	}
	if body.SKU != nil {
		add("sku", *body.SKU)
	}
	if body.Barcode != nil {
		add("barcode", *body.Barcode)
	}
	if body.Stock != nil {
		add("stock", *body.Stock)
	}
	if body.LowStockThreshold != nil {
		add("low_stock_threshold", *body.LowStockThreshold)
	}
	if body.BackordersAllowed != nil {
		add("backorders_allowed", *body.BackordersAllowed)
	}
	if body.WeightKg != nil {
		add("weight_kg", *body.WeightKg)
	}
	if body.LengthCm != nil {
		add("length_cm", *body.LengthCm)
	}
	if body.WidthCm != nil {
		add("width_cm", *body.WidthCm)
	}
	if body.HeightCm != nil {
		add("height_cm", *body.HeightCm)
	}
	if body.ShippingClass != nil {
		add("shipping_class", *body.ShippingClass)
	}
	if body.MetaTitle != nil {
		add("meta_title", *body.MetaTitle)
	}
	if body.MetaDescription != nil {
		add("meta_description", *body.MetaDescription)
	}
	if body.Images != nil {
		imagesJSON, _ := json.Marshal(*body.Images)
		add("images", imagesJSON)
	}
	if body.Status != nil {
		add("status", *body.Status)
	}
	if len(set) == 0 {
		kit.Fail(w, 400, "empty_update", "aucun champ à modifier fourni")
		return
	}
	add("updated_at", time.Now())
	args = append(args, id)

	tag, err := s.db.Exec(r.Context(),
		fmt.Sprintf("UPDATE products SET %s WHERE id = $%d", strings.Join(set, ", "), len(args)), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "product_not_found", fmt.Sprintf("produit %d introuvable", id))
		return
	}
	kit.JSON(w, 200, map[string]any{"id": id, "updated": true})
}

// deleteProduct — suppression admin. CASCADE supprime les variations et
// avis liés (voir contraintes FK product_variations/reviews).
func (s *server) deleteProduct(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	tag, err := s.db.Exec(r.Context(), "DELETE FROM products WHERE id = $1", id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "product_not_found", fmt.Sprintf("produit %d introuvable", id))
		return
	}
	kit.JSON(w, 200, map[string]any{"id": id, "deleted": true})
}

// bulkUpdateProducts — actions groupées du back-office (sélection multiple
// dans la DataTable) : changer le statut, la catégorie, ou supprimer
// plusieurs produits en un seul appel plutôt que N requêtes séquentielles.
func (s *server) bulkUpdateProducts(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs        []int64 `json:"ids"`
		Action     string  `json:"action"` // "set_status" | "set_category" | "delete"
		Status     string  `json:"status"`
		CategoryID int64   `json:"category_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", "JSON attendu : "+err.Error())
		return
	}
	if len(body.IDs) == 0 {
		kit.Fail(w, 400, "missing_ids", "ids requis")
		return
	}
	if len(body.IDs) > 500 {
		body.IDs = body.IDs[:500]
	}

	var tag interface{ RowsAffected() int64 }
	var err error
	switch body.Action {
	case "set_status":
		if body.Status == "" {
			kit.Fail(w, 400, "missing_status", "status requis pour set_status")
			return
		}
		t, e := s.db.Exec(r.Context(), "UPDATE products SET status = $1, updated_at = now() WHERE id = ANY($2)", body.Status, body.IDs)
		tag, err = t, e
	case "set_category":
		t, e := s.db.Exec(r.Context(), "UPDATE products SET category_id = $1, updated_at = now() WHERE id = ANY($2)", body.CategoryID, body.IDs)
		tag, err = t, e
	case "delete":
		t, e := s.db.Exec(r.Context(), "DELETE FROM products WHERE id = ANY($1)", body.IDs)
		tag, err = t, e
	default:
		kit.Fail(w, 400, "unknown_action", "action doit être set_status, set_category ou delete")
		return
	}
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"action": body.Action, "rows_affected": tag.RowsAffected()})
}

// ---------- marques (brands) ----------

func (s *server) listBrands(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `
		SELECT b.id, b.name, b.slug, b.logo_url, b.description, b.website_url, b.status,
		       (SELECT count(*) FROM products p WHERE p.brand_id = b.id) AS product_count
		FROM brands b ORDER BY b.name`)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, count int64
		var name, slug, logo, desc, website, status string
		if err := rows.Scan(&id, &name, &slug, &logo, &desc, &website, &status, &count); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		items = append(items, map[string]any{
			"id": id, "name": name, "slug": slug, "logo_url": logo,
			"description": desc, "website_url": website, "status": status,
			"product_count": count,
		})
	}
	kit.JSON(w, 200, map[string]any{"items": items, "total": len(items)})
}

func (s *server) createBrand(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name       string `json:"name"`
		LogoURL    string `json:"logo_url"`
		Description string `json:"description"`
		WebsiteURL string `json:"website_url"`
		Status     string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Name == "" {
		kit.Fail(w, 400, "missing_name", "name requis")
		return
	}
	if body.Status == "" {
		body.Status = "active"
	}
	var id int64
	err := s.db.QueryRow(r.Context(), `
		INSERT INTO brands (name, slug, logo_url, description, website_url, status)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
		body.Name, slugify(body.Name), body.LogoURL, body.Description, body.WebsiteURL, body.Status,
	).Scan(&id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 201, map[string]any{"id": id})
}

func (s *server) updateBrand(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	var body struct {
		Name        *string `json:"name"`
		LogoURL     *string `json:"logo_url"`
		Description *string `json:"description"`
		WebsiteURL  *string `json:"website_url"`
		Status      *string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	set := []string{}
	args := []any{}
	add := func(col string, v any) {
		args = append(args, v)
		set = append(set, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	if body.Name != nil {
		add("name", *body.Name)
	}
	if body.LogoURL != nil {
		add("logo_url", *body.LogoURL)
	}
	if body.Description != nil {
		add("description", *body.Description)
	}
	if body.WebsiteURL != nil {
		add("website_url", *body.WebsiteURL)
	}
	if body.Status != nil {
		add("status", *body.Status)
	}
	if len(set) == 0 {
		kit.Fail(w, 400, "empty_update", "aucun champ à modifier fourni")
		return
	}
	args = append(args, id)
	tag, err := s.db.Exec(r.Context(),
		fmt.Sprintf("UPDATE brands SET %s WHERE id = $%d", strings.Join(set, ", "), len(args)), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "brand_not_found", fmt.Sprintf("marque %d introuvable", id))
		return
	}
	kit.JSON(w, 200, map[string]any{"id": id, "updated": true})
}

func (s *server) deleteBrand(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	tag, err := s.db.Exec(r.Context(), "DELETE FROM brands WHERE id = $1", id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "brand_not_found", fmt.Sprintf("marque %d introuvable", id))
		return
	}
	kit.JSON(w, 200, map[string]any{"id": id, "deleted": true})
}

// ---------- helpers ----------

func nullIfZero(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}

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

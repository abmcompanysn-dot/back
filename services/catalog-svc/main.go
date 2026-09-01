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
	"math/rand"
	"net/http"
	"regexp"
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
-- Douane DHL (module Logistique) : code HS et pays de fabrication déclarés
-- à l'export — 85444290 / défaut historique du plugin WordPress si absent.
ALTER TABLE products ADD COLUMN IF NOT EXISTS hs_code TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS origin_country TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_products_sku ON products (sku) WHERE sku <> '';
CREATE INDEX IF NOT EXISTS idx_products_brand ON products (brand_id);
-- Tags de recherche/filtrage client (ex. "bio", "artisanal", "fait main") —
-- tableau JSONB de strings, même pattern que "images". Index GIN pour que
-- le filtre ?tags=x,y et la recherche ?q= restent rapides sur 1700+ produits.
ALTER TABLE products ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_products_tags ON products USING GIN (tags);
-- Tableau de caracteristiques affiche sur la fiche produit (matiere,
-- entretien, contenu, dimensions redigees, garantie...). Format : tableau
-- ordonne d'objets {"k": "Matiere", "v": "Coton wax", "source": "ai" ou "vendor"}
-- ; l'ordre du tableau = l'ordre d'affichage. Le champ source sert au
-- back-office a distinguer une valeur pre-remplie par l'IA (badge a verifier)
-- d'une valeur validee/saisie par le vendeur. Ajoute le 2026-08-31.
ALTER TABLE products ADD COLUMN IF NOT EXISTS specifications JSONB NOT NULL DEFAULT '[]';
-- Sous-titre court (une ligne) affiché sous le nom du produit sur la fiche.
ALTER TABLE products ADD COLUMN IF NOT EXISTS subtitle TEXT DEFAULT '';

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
  customer_id BIGINT,                   -- NULL = avis invité (guest_name/guest_email)
  order_id   BIGINT,                    -- vérifié via order-svc (anti-faux avis)
  rating     INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    TEXT DEFAULT '',
  verified_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'; -- pending/approved/rejected — modération admin
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS admin_reply TEXT DEFAULT '';
-- Avis "invité" (sans compte) : le frontend collecte nom+email sans exiger
-- de connexion — customer_id devient nullable (0 = anonyme, migré depuis
-- l'ancien NOT NULL) plutôt que de forcer une création de compte fantôme.
ALTER TABLE reviews ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS guest_name TEXT DEFAULT '';
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS guest_email TEXT DEFAULT '';
-- Section avis complète (2026-09-01) : photos jointes, titre, votes
-- "utile", type d'avis (produit vs confirmation de livraison), avis "de
-- la communauté" (seed / recommandation, PAS un achat vérifié), pays +
-- avatar affichés (drapeau + photo du client, ou du vendeur / du
-- représentant du pays pour les avis de la communauté).
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS title TEXT DEFAULT '';
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS photos JSONB NOT NULL DEFAULT '[]';
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS helpful_count INT NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS review_type TEXT NOT NULL DEFAULT 'product'; -- product | delivery
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS is_community BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reviewer_country TEXT DEFAULT '';   -- code ISO2 (SN, CI…)
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reviewer_avatar TEXT DEFAULT '';    -- URL photo (client / vendeur / représentant)
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS moderation_reason TEXT DEFAULT '';  -- pourquoi mis en attente par le filtre auto
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS delivery_rating INT;                -- note livraison 1-5 (review_type='delivery')
CREATE INDEX IF NOT EXISTS idx_reviews_product_status ON reviews (product_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_order ON reviews (order_id);

-- Un client ne peut voter "utile" qu'une fois par avis (customer_id ou,
-- à défaut, empreinte anonyme fournie par le frontend).
CREATE TABLE IF NOT EXISTS review_helpful_votes (
  review_id   BIGINT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  voter_key   TEXT NOT NULL,   -- "cust:<id>" ou "anon:<fingerprint>"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, voter_key)
);

-- Wishlist / favoris — n'existait nulle part (ni frontend, ni backend)
-- avant le 2026-08-26 : le bouton cœur sur les produits et la section
-- "Liste de souhaits" du dashboard client n'étaient que des maquettes
-- vides. product_id référence un produit dans UNE langue précise (comme
-- product_variations) — un favori posé sur la fiche FR n'apparaît pas
-- automatiquement sur la fiche EN du même produit, cohérent avec le
-- reste du catalogue qui traite chaque traduction comme une ligne
-- distincte (trid les relie, jamais fusionnées côté données).
CREATE TABLE IF NOT EXISTS wishlists (
  customer_id BIGINT NOT NULL,
  product_id  BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_wishlists_customer ON wishlists (customer_id, created_at DESC);

-- Panier — n'existait que côté client (localStorage, clé miad_cart), donc
-- perdu à chaque changement d'appareil (demandé le 2026-08-26 : "l'appareil
-- recupere ce qui a été fait avant" — même exigence que la wishlist déjà
-- server-backed). variation_id NULLABLE (produit simple vs variable) —
-- COALESCE(variation_id, 0) dans la clé unique car Postgres ne déduplique
-- jamais deux NULL comme identiques dans un UNIQUE classique (sinon deux
-- lignes NULL pour le même produit simple ajouté deux fois).
CREATE TABLE IF NOT EXISTS cart_items (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL,
  product_id   BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variation_id BIGINT REFERENCES product_variations(id) ON DELETE CASCADE,
  quantity     INT NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_items_unique
  ON cart_items (customer_id, product_id, COALESCE(variation_id, 0));
CREATE INDEX IF NOT EXISTS idx_cart_items_customer ON cart_items (customer_id, created_at);
`

type server struct {
	db        *pgxpool.Pool
	kafka     sarama.SyncProducer
	orderURL  string
	vendorURL string
	// media : upload des photos jointes aux avis (préfixe "reviews/" du
	// même bucket MinIO que les images produits). nil si MinIO non
	// configuré — l'avis reste possible, juste sans photo.
	media *kit.Media
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
		db:        db,
		kafka:     kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		orderURL:  kit.Env("ORDER_SVC_URL", "http://order-svc:8083"),
		vendorURL: kit.Env("VENDOR_SVC_URL", "http://vendor-svc:8082"),
	}
	// MinIO pour les photos d'avis — mêmes variables que admin-svc.
	if media, err := kit.NewMedia(
		kit.Env("MINIO_ENDPOINT", "minio:9000"),
		kit.Env("MINIO_ROOT_USER", ""),
		kit.Env("MINIO_ROOT_PASSWORD", ""),
		kit.Env("MINIO_BUCKET", "miad-media"),
		kit.Env("MEDIA_BASE_URL", "https://img.miadmarket.ca"),
	); err != nil {
		log.Error("client minio indisponible — upload de photos d'avis désactivé", "err", err)
	} else {
		s.media = media
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
		mux.HandleFunc("POST /admin/backfill-shoe-sizes", s.backfillShoeSizes)
		mux.HandleFunc("POST /admin/backfill-clothing-sizes", s.backfillClothingSizes)
		mux.HandleFunc("POST /admin/collapse-fake-variables", s.collapseFakeVariables)
		mux.HandleFunc("POST /products/{id}/variations", s.createVariation)
		mux.HandleFunc("PUT /products/{id}/variations/{variation_id}", s.updateVariation)
		mux.HandleFunc("DELETE /products/{id}/variations/{variation_id}", s.deleteVariation)
		mux.HandleFunc("GET /products/{id}/reviews", s.listReviews)
		mux.HandleFunc("POST /products/{id}/reviews", s.createReview)
		mux.HandleFunc("GET /reviews", s.listReviewsAdmin)
		mux.HandleFunc("PATCH /reviews/{id}", s.moderateReview)
		// Section avis complète
		mux.HandleFunc("POST /reviews/upload", s.uploadReviewPhoto)                       // multipart, 1 photo -> URL MinIO
		mux.HandleFunc("POST /reviews/{id}/helpful", s.markReviewHelpful)                 // vote "utile"
		mux.HandleFunc("GET /orders/{orderId}/can-review", s.canReviewOrder)              // produits notables d'une commande livrée
		mux.HandleFunc("POST /orders/{orderId}/delivery-confirmation", s.confirmDelivery) // réception + note livraison + photo
		mux.HandleFunc("POST /admin/reviews/seed", s.seedCommunityReviews)                // avis "de la communauté" sur un produit
		mux.HandleFunc("GET /wishlist/{customer_id}", s.listWishlist)
		mux.HandleFunc("POST /wishlist/{customer_id}/{product_id}", s.addToWishlist)
		mux.HandleFunc("DELETE /wishlist/{customer_id}/{product_id}", s.removeFromWishlist)
		mux.HandleFunc("GET /cart/{customer_id}", s.listCart)
		mux.HandleFunc("PUT /cart/{customer_id}/{product_id}", s.upsertCartItem)
		mux.HandleFunc("DELETE /cart/{customer_id}/{product_id}", s.removeCartItem)
		mux.HandleFunc("DELETE /cart/{customer_id}", s.clearCart)
		mux.HandleFunc("GET /categories", s.listCategories)
		mux.HandleFunc("GET /search/suggestions", s.suggestions)
		mux.HandleFunc("POST /vendor/products", s.createProduct)
		mux.HandleFunc("PUT /products/{id}/images", s.updateProductImages)
		mux.HandleFunc("PATCH /products/{id}", s.updateProduct)
		mux.HandleFunc("DELETE /products/{id}", s.deleteProduct)
		mux.HandleFunc("POST /products/bulk", s.bulkUpdateProducts)
		mux.HandleFunc("PATCH /products/{id}/moderate", s.moderateProduct)
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
		where += fmt.Sprintf(" AND (name ILIKE $%d OR sku ILIKE $%d OR tags::text ILIKE $%d)", len(args)+1, len(args)+1, len(args)+1)
		args = append(args, "%"+v+"%")
	}
	if v := q.Get("slug"); v != "" {
		where += fmt.Sprintf(" AND slug = $%d", len(args)+1)
		args = append(args, v)
	}
	// ?tags=bio,artisanal : produits ayant AU MOINS un des tags listés
	// (opérateur JSONB ?| — "existe une des clés du tableau à droite").
	if v := q.Get("tags"); v != "" {
		var wanted []string
		for _, t := range strings.Split(v, ",") {
			if t = strings.TrimSpace(t); t != "" {
				wanted = append(wanted, t)
			}
		}
		if len(wanted) > 0 {
			where += fmt.Sprintf(" AND tags ?| $%d", len(args)+1)
			args = append(args, wanted)
		}
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

	query := `SELECT id, trid, lang, vendor_id, category_id, name, slug, price_usd, sale_price_usd, status, is_variable, images, sku, stock, low_stock_threshold, brand_id, tags
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
	categoryIDs := map[int64]bool{}
	for rows.Next() {
		var id int64
		// vendor_id / category_id peuvent être NULL en base (produit sans
		// vendeur assigné, produit hors catégorie) — scan nul-safe puis
		// repli sur 0, sinon pgx renvoie "cannot scan NULL into *int64" et
		// tout GET /products plante en 500 (vu via Sentry le 28/08).
		var vendorIDPtr, categoryIDPtr, brandID *int64
		var price float64
		var salePrice *float64
		var trid, l, name, slug, status, sku string
		var isVar bool
		var images, tagsJSON []byte
		var stock, lowStockThreshold int
		if err := rows.Scan(&id, &trid, &l, &vendorIDPtr, &categoryIDPtr, &name, &slug, &price, &salePrice, &status, &isVar, &images, &sku, &stock, &lowStockThreshold, &brandID, &tagsJSON); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		var vendorID, categoryID int64
		if vendorIDPtr != nil {
			vendorID = *vendorIDPtr
		}
		if categoryIDPtr != nil {
			categoryID = *categoryIDPtr
		}
		item := productToWooShape(id, trid, l, vendorID, categoryID, name, slug, "", price, salePrice, status, isVar, images, nil)
		item["sku"] = sku
		item["stock"] = stock
		item["low_stock_threshold"] = lowStockThreshold
		item["brand_id"] = brandID
		var tags []string
		_ = json.Unmarshal(tagsJSON, &tags)
		item["tags"] = tags
		if categoryID != 0 {
			categoryIDs[categoryID] = true
		}
		items = append(items, item)
	}

	// Résolution batch category_id -> {name, slug} : évite un aller-retour
	// GET /categories séparé côté frontend, qui affichait "Général" en dur
	// faute de ce champ (bug trouvé le 27/08, même pattern que vendorsById
	// côté app/api/products/route.ts).
	if len(categoryIDs) > 0 {
		ids := make([]int64, 0, len(categoryIDs))
		for id := range categoryIDs {
			ids = append(ids, id)
		}
		catRows, err := s.db.Query(r.Context(), "SELECT id, name, slug FROM categories WHERE id = ANY($1)", ids)
		if err == nil {
			defer catRows.Close()
			names := map[int64]map[string]string{}
			for catRows.Next() {
				var cid int64
				var cname, cslug string
				if catRows.Scan(&cid, &cname, &cslug) == nil {
					names[cid] = map[string]string{"name": cname, "slug": cslug}
				}
			}
			for _, item := range items {
				if cid, ok := item["category_id"].(int64); ok {
					if c, found := names[cid]; found {
						item["category_name"] = c["name"]
						item["category_slug"] = c["slug"]
					}
				}
			}
		}
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
		SELECT p.id, p.trid, p.lang, p.vendor_id, p.category_id, p.brand_id, p.name, p.slug,
		       p.description, p.short_description, p.price_usd, p.sale_price_usd, p.status, p.images, p.is_variable,
		       p.sku, p.barcode, p.stock, p.low_stock_threshold, p.backorders_allowed,
		       p.weight_kg, p.length_cm, p.width_cm, p.height_cm, p.shipping_class,
		       p.meta_title, p.meta_description, p.hs_code, p.origin_country, p.tags,
		       p.specifications, p.subtitle
		FROM products p WHERE p.id = $1 AND p.lang = $2`, id, lang)

	var pID int64
	// vendor_id / category_id nullable en base — scan nul-safe puis repli
	// sur 0 (même correctif que listProducts, Sentry 28/08).
	var vendorIDPtr, catIDPtr, brandID *int64
	var price float64
	var salePrice, weightKg, lengthCm, widthCm, heightCm *float64
	var trid, l, name, slug, desc, shortDesc, status, sku, barcode, shippingClass, metaTitle, metaDesc, hsCode, originCountry, subtitle string
	var stock, lowStockThreshold int
	var backordersAllowed bool
	var images, tagsJSON, specsJSON []byte
	var isVar bool
	if err := row.Scan(&pID, &trid, &l, &vendorIDPtr, &catIDPtr, &brandID, &name, &slug, &desc, &shortDesc, &price, &salePrice, &status, &images, &isVar,
		&sku, &barcode, &stock, &lowStockThreshold, &backordersAllowed,
		&weightKg, &lengthCm, &widthCm, &heightCm, &shippingClass,
		&metaTitle, &metaDesc, &hsCode, &originCountry, &tagsJSON,
		&specsJSON, &subtitle); err != nil {
		if err == pgx.ErrNoRows {
			kit.Fail(w, 404, "product_not_found", fmt.Sprintf("produit %d introuvable en lang=%s — erreur explicite, pas de page vide silencieuse", id, lang))
			return
		}
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	var vendorID, catID int64
	if vendorIDPtr != nil {
		vendorID = *vendorIDPtr
	}
	if catIDPtr != nil {
		catID = *catIDPtr
	}

	// Variante liée (autre langue du même trid) — le frontend affiche le switch FR/EN.
	var linkedID int64
	var linkedLang string
	_ = s.db.QueryRow(r.Context(),
		`SELECT id, lang FROM products WHERE trid = $1 AND lang <> $2 LIMIT 1`, trid, l,
	).Scan(&linkedID, &linkedLang)

	var variations []map[string]any
	// derivedAttrs — clés d'attribut (ex. "Pointure", "Couleur") découvertes
	// dans les variations, avec l'ensemble ordonné de leurs valeurs. On les
	// renvoie ensuite dans out["attributes"] : sans ça le frontend
	// (ProductVariations.tsx lit product.attributes) n'a AUCUNE donnée pour
	// construire le sélecteur de taille/couleur, même quand les variations
	// existent en base — le sélecteur restait donc toujours invisible.
	derivedOrder := []string{}
	derivedAttrs := map[string][]string{}
	seenVal := map[string]bool{} // clé "attr\x00valeur" pour dédupliquer en gardant l'ordre
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

				var attrMap map[string]any
				_ = json.Unmarshal(attrs, &attrMap)
				for k, v := range attrMap {
					val := fmt.Sprintf("%v", v)
					if val == "" {
						continue
					}
					if _, ok := derivedAttrs[k]; !ok {
						derivedOrder = append(derivedOrder, k)
					}
					dedupeKey := k + "\x00" + val
					if !seenVal[dedupeKey] {
						seenVal[dedupeKey] = true
						derivedAttrs[k] = append(derivedAttrs[k], val)
					}
				}

				variations = append(variations, map[string]any{
					"id": vid, "sku": sku, "attributes": json.RawMessage(attrs),
					"price": strconv.FormatFloat(vprice, 'f', 2, 64), "price_usd": vprice,
					// backordersAllowed hérité du produit parent (pas de colonne
					// propre sur product_variations) — sans ça, une variation
					// en réapprovisionnement (stock=0, backorders_allowed=true
					// côté produit) s'affichait à tort comme épuisée. Bug
					// signalé le 2026-08-27.
					"stock": stock, "in_stock": stock > 0 || backordersAllowed, "image_url": img,
				})
			}
		}
	}

	out := productToWooShape(pID, trid, l, vendorID, catID, name, slug, desc, price, salePrice, status, isVar, images, variations)

	// attributes / default_attributes — forme attendue par le frontend
	// (lib/woo-server.ts mapProduct → ProductVariations.tsx). variation:true
	// sur chaque attribut car ils SERVENT tous aux déclinaisons ici.
	if len(derivedOrder) > 0 {
		attrList := make([]map[string]any, 0, len(derivedOrder))
		defList := make([]map[string]any, 0, len(derivedOrder))
		for _, k := range derivedOrder {
			attrList = append(attrList, map[string]any{
				"name": k, "slug": slugify(k), "options": derivedAttrs[k], "variation": true,
			})
			if len(derivedAttrs[k]) > 0 {
				defList = append(defList, map[string]any{"name": k, "option": derivedAttrs[k][0]})
			}
		}
		out["attributes"] = attrList
		out["default_attributes"] = defList
	}
	out["brand_id"] = brandID
	out["short_description"] = shortDesc
	out["sku"] = sku
	out["barcode"] = barcode
	out["stock"] = stock
	out["low_stock_threshold"] = lowStockThreshold
	out["backorders_allowed"] = backordersAllowed
	out["weight_kg"] = weightKg
	out["length_cm"] = lengthCm
	out["width_cm"] = widthCm
	out["height_cm"] = heightCm
	out["shipping_class"] = shippingClass
	out["meta_title"] = metaTitle
	out["meta_description"] = metaDesc
	out["hs_code"] = hsCode
	out["origin_country"] = originCountry
	var tags []string
	_ = json.Unmarshal(tagsJSON, &tags)
	out["tags"] = tags
	// Caractéristiques (tableau ordonné {k,v,source}) + sous-titre — affichés
	// sur la fiche produit, éditables au back-office. Ajouté le 2026-08-31.
	var specs []map[string]any
	_ = json.Unmarshal(specsJSON, &specs)
	if specs == nil {
		specs = []map[string]any{}
	}
	out["specifications"] = specs
	out["subtitle"] = subtitle
	if catID != 0 {
		var catName, catSlug string
		if s.db.QueryRow(r.Context(), "SELECT name, slug FROM categories WHERE id = $1", catID).Scan(&catName, &catSlug) == nil {
			out["category_name"] = catName
			out["category_slug"] = catSlug
		}
	}
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

	// JOIN products pour backorders_allowed — sans ça, une variation en
	// réapprovisionnement (stock=0 mais backorders_allowed=true côté
	// produit parent) s'affichait à tort comme épuisée sur cet endpoint
	// batch aussi (même bug que listProducts/getProduct, signalé le
	// 2026-08-27).
	rows, err := s.db.Query(r.Context(),
		`SELECT v.id, v.product_id, v.sku, v.attributes, v.price_usd, v.stock, v.image_url, p.backorders_allowed
		 FROM product_variations v JOIN products p ON p.id = v.product_id
		 WHERE v.product_id = ANY($1) ORDER BY v.product_id, v.id`, ids)
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
		var backordersAllowed bool
		if err := rows.Scan(&vid, &productID, &sku, &attrs, &vprice, &stock, &img, &backordersAllowed); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		key := strconv.FormatInt(productID, 10)
		out[key] = append(out[key], map[string]any{
			"id": vid, "sku": sku, "attributes": json.RawMessage(attrs),
			"price": strconv.FormatFloat(vprice, 'f', 2, 64), "price_usd": vprice,
			"stock": stock, "in_stock": stock > 0 || backordersAllowed, "image_url": img,
		})
	}
	kit.JSON(w, 200, map[string]any{"variations": out})
}

// listReviews — avis paginés d'un produit + note moyenne/nombre calculés
// dans la même réponse (évite un second aller-retour pour l'en-tête de
// la fiche produit qui affiche déjà average_rating/rating_count).
func (s *server) listReviews(w http.ResponseWriter, r *http.Request) {
	productID := atoi(r.PathValue("id"))
	q := r.URL.Query()
	page, _ := strconv.Atoi(def(q.Get("page"), "1"))
	pageSize, _ := strconv.Atoi(def(q.Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}

	// Filtres storefront : ?rating=5, ?with_photos=true, ?sort=recent|top|photos
	where := "WHERE product_id = $1 AND status = 'approved' AND review_type = 'product'"
	args := []any{productID}
	if v := q.Get("rating"); v != "" {
		args = append(args, atoi(v))
		where += fmt.Sprintf(" AND rating = $%d", len(args))
	}
	if q.Get("with_photos") == "true" {
		where += " AND jsonb_array_length(COALESCE(NULLIF(photos, 'null'::jsonb), '[]'::jsonb)) > 0"
	}
	orderBy := "created_at DESC"
	switch q.Get("sort") {
	case "top":
		orderBy = "rating DESC, helpful_count DESC, created_at DESC"
	case "photos":
		orderBy = "jsonb_array_length(COALESCE(NULLIF(photos, 'null'::jsonb), '[]'::jsonb)) DESC, created_at DESC"
	}

	// En-tête : note moyenne + répartition par étoile (toutes les colonnes
	// de la barre AliExpress), sur les avis produit approuvés.
	var total int64
	var avgRating float64
	star := [6]int64{} // star[1..5]
	var withPhotos int64
	brk, err := s.db.Query(r.Context(),
		`SELECT rating, count(*), count(*) FILTER (WHERE jsonb_array_length(COALESCE(NULLIF(photos, 'null'::jsonb), '[]'::jsonb)) > 0)
		 FROM reviews WHERE product_id=$1 AND status='approved' AND review_type='product'
		 GROUP BY rating`, productID)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	for brk.Next() {
		var rt int
		var c, wp int64
		if brk.Scan(&rt, &c, &wp) == nil && rt >= 1 && rt <= 5 {
			star[rt] = c
			total += c
			withPhotos += wp
			avgRating += float64(rt) * float64(c)
		}
	}
	brk.Close()
	if total > 0 {
		avgRating = avgRating / float64(total)
	}

	// Aperçu photos (12 premières, tous avis confondus) pour le bandeau
	// "photos clients" en haut de la section.
	photoStrip := []string{}
	prow, _ := s.db.Query(r.Context(),
		`SELECT photos FROM reviews
		 WHERE product_id=$1 AND status='approved' AND review_type='product' AND jsonb_array_length(COALESCE(NULLIF(photos, 'null'::jsonb), '[]'::jsonb)) > 0
		 ORDER BY created_at DESC LIMIT 12`, productID)
	if prow != nil {
		for prow.Next() {
			var pj []byte
			if prow.Scan(&pj) == nil {
				var ps []string
				_ = json.Unmarshal(pj, &ps)
				photoStrip = append(photoStrip, ps...)
			}
		}
		prow.Close()
	}
	if len(photoStrip) > 12 {
		photoStrip = photoStrip[:12]
	}

	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(r.Context(), fmt.Sprintf(`
		SELECT id, customer_id, guest_name, order_id, rating, title, comment, photos,
		       verified_purchase, is_community, reviewer_country, reviewer_avatar,
		       helpful_count, created_at
		FROM reviews %s
		ORDER BY %s LIMIT $%d OFFSET $%d`, where, orderBy, len(args)-1, len(args)), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var customerID, orderID *int64
		var rating, helpful int
		var guestName, title, comment, country, avatar string
		var photosJSON []byte
		var verified, community bool
		var createdAt time.Time
		if err := rows.Scan(&id, &customerID, &guestName, &orderID, &rating, &title, &comment, &photosJSON,
			&verified, &community, &country, &avatar, &helpful, &createdAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		var photos []string
		_ = json.Unmarshal(photosJSON, &photos)
		reviewerName := guestName
		if reviewerName == "" && customerID != nil {
			reviewerName = fmt.Sprintf("Client #%d", *customerID)
		}
		items = append(items, map[string]any{
			"id": id, "reviewer": reviewerName, "country": country, "avatar": avatar,
			"rating": rating, "title": title, "comment": comment, "photos": photos,
			// badge affiché côté front : "Achat vérifié" si verified,
			// "Avis de la communauté" si is_community.
			"verified_purchase": verified, "is_community": community,
			"helpful_count": helpful,
			"created_at":    createdAt.UTC().Format(time.RFC3339),
		})
	}

	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
		"average_rating": avgRating, "rating_count": total,
		"stars": map[string]int64{
			"1": star[1], "2": star[2], "3": star[3], "4": star[4], "5": star[5],
		},
		"with_photos_count": withPhotos,
		"photo_strip":       photoStrip,
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
		SELECT rv.id, rv.product_id, p.name, rv.customer_id, rv.guest_name, rv.guest_email, rv.rating, rv.comment,
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
		var id, productID int64
		var customerID *int64
		var rating int
		var productName, guestName, guestEmail, comment, status, adminReply string
		var verified bool
		var createdAt time.Time
		if err := rows.Scan(&id, &productID, &productName, &customerID, &guestName, &guestEmail, &rating, &comment, &verified, &status, &adminReply, &createdAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		items = append(items, map[string]any{
			"id": id, "product_id": productID, "product_name": productName,
			"customer_id": customerID, "guest_name": guestName, "guest_email": guestEmail,
			"rating": rating, "comment": comment,
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

/* ---------- Wishlist / favoris ---------- */

// listWishlist — renvoie juste les IDs produit dans l'ordre d'ajout
// (le plus récent en premier) ; l'enrichissement (image/prix/nom) se
// fait côté frontend via GET /products?include=... (déjà utilisé pour
// la recherche sémantique, voir fetchWooProductsByIds), pas ici — évite
// de dupliquer productToWooShape pour un besoin qui n'a pas besoin d'être
// servi par catalog-svc lui-même.
func (s *server) listWishlist(w http.ResponseWriter, r *http.Request) {
	customerID := atoi(r.PathValue("customer_id"))
	if customerID == 0 {
		kit.Fail(w, 400, "invalid_customer_id", "customer_id invalide")
		return
	}
	rows, err := s.db.Query(r.Context(),
		`SELECT product_id FROM wishlists WHERE customer_id = $1 ORDER BY created_at DESC`, customerID)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	kit.JSON(w, 200, map[string]any{"product_ids": ids})
}

func (s *server) addToWishlist(w http.ResponseWriter, r *http.Request) {
	customerID := atoi(r.PathValue("customer_id"))
	productID := atoi(r.PathValue("product_id"))
	if customerID == 0 || productID == 0 {
		kit.Fail(w, 400, "invalid_id", "customer_id et product_id invalides")
		return
	}
	if _, err := s.db.Exec(r.Context(),
		`INSERT INTO wishlists (customer_id, product_id) VALUES ($1, $2)
		 ON CONFLICT (customer_id, product_id) DO NOTHING`, customerID, productID); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"ok": true})
}

func (s *server) removeFromWishlist(w http.ResponseWriter, r *http.Request) {
	customerID := atoi(r.PathValue("customer_id"))
	productID := atoi(r.PathValue("product_id"))
	if customerID == 0 || productID == 0 {
		kit.Fail(w, 400, "invalid_id", "customer_id et product_id invalides")
		return
	}
	if _, err := s.db.Exec(r.Context(),
		`DELETE FROM wishlists WHERE customer_id = $1 AND product_id = $2`, customerID, productID); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"ok": true})
}

/* ---------- Panier ---------- */

// listCart — renvoie les lignes brutes (product_id/variation_id/quantity),
// même parti pris que listWishlist : l'enrichissement (image/prix/nom) se
// fait côté frontend via GET /products?include=..., pas ici.
func (s *server) listCart(w http.ResponseWriter, r *http.Request) {
	customerID := atoi(r.PathValue("customer_id"))
	if customerID == 0 {
		kit.Fail(w, 400, "invalid_customer_id", "customer_id invalide")
		return
	}
	rows, err := s.db.Query(r.Context(),
		`SELECT product_id, variation_id, quantity FROM cart_items WHERE customer_id = $1 ORDER BY created_at`, customerID)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var productID int64
		var variationID *int64
		var quantity int
		if rows.Scan(&productID, &variationID, &quantity) == nil {
			items = append(items, map[string]any{
				"product_id": productID, "variation_id": variationID, "quantity": quantity,
			})
		}
	}
	kit.JSON(w, 200, map[string]any{"items": items})
}

// upsertCartItem — PUT /cart/{customer_id}/{product_id} { variation_id?, quantity }
// La quantité est TOUJOURS remplacée (pas incrémentée) : le frontend
// envoie la quantité finale voulue à chaque fois (cohérent avec un input
// numérique sur la page panier), pas un delta — évite toute ambiguïté
// entre "ajouter 1" et "définir à 1" côté serveur.
func (s *server) upsertCartItem(w http.ResponseWriter, r *http.Request) {
	customerID := atoi(r.PathValue("customer_id"))
	productID := atoi(r.PathValue("product_id"))
	if customerID == 0 || productID == 0 {
		kit.Fail(w, 400, "invalid_id", "customer_id et product_id invalides")
		return
	}
	var body struct {
		VariationID *int64 `json:"variation_id"`
		Quantity    int    `json:"quantity"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Quantity <= 0 {
		kit.Fail(w, 400, "invalid_quantity", "quantity doit être > 0 (utilisez DELETE pour retirer)")
		return
	}
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO cart_items (customer_id, product_id, variation_id, quantity)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (customer_id, product_id, COALESCE(variation_id, 0))
		DO UPDATE SET quantity = $4, updated_at = now()`,
		customerID, productID, body.VariationID, body.Quantity); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"ok": true})
}

// removeCartItem — DELETE /cart/{customer_id}/{product_id}?variation_id=X
// variation_id en query (pas dans le path) : cohérent avec le fait qu'il
// est optionnel — un produit simple n'en a pas.
func (s *server) removeCartItem(w http.ResponseWriter, r *http.Request) {
	customerID := atoi(r.PathValue("customer_id"))
	productID := atoi(r.PathValue("product_id"))
	if customerID == 0 || productID == 0 {
		kit.Fail(w, 400, "invalid_id", "customer_id et product_id invalides")
		return
	}
	variationParam := r.URL.Query().Get("variation_id")
	var err error
	if variationParam != "" {
		_, err = s.db.Exec(r.Context(),
			`DELETE FROM cart_items WHERE customer_id = $1 AND product_id = $2 AND variation_id = $3`,
			customerID, productID, atoi(variationParam))
	} else {
		_, err = s.db.Exec(r.Context(),
			`DELETE FROM cart_items WHERE customer_id = $1 AND product_id = $2 AND variation_id IS NULL`,
			customerID, productID)
	}
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"ok": true})
}

// clearCart — DELETE /cart/{customer_id}, appelé après un checkout réussi
// (le panier ne doit pas réapparaître sur le prochain appareil une fois la
// commande passée).
func (s *server) clearCart(w http.ResponseWriter, r *http.Request) {
	customerID := atoi(r.PathValue("customer_id"))
	if customerID == 0 {
		kit.Fail(w, 400, "invalid_customer_id", "customer_id invalide")
		return
	}
	if _, err := s.db.Exec(r.Context(), `DELETE FROM cart_items WHERE customer_id = $1`, customerID); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"ok": true})
}

// createReview — verified_purchase est déterminé au mieux : si order_id
// est fourni, on vérifie via order-svc que la commande appartient bien à
// ce client et contient bien ce produit ; en cas de doute ou d'échec
// réseau, le commentaire est accepté quand même mais SANS le badge vérifié
// (jamais bloquant pour l'utilisateur — order-svc peut être temporairement
// indisponible sans empêcher les avis).
// bannedWordsRe — filtre de modération auto : gros mots, insultes, spam,
// tentatives de contact hors plateforme. Un avis qui matche part en
// status='pending' avec moderation_reason renseignée ; le reste est
// publié directement (décision fondateur du 2026-09-01 : "auto —
// publication directe sauf mots interdits / spam").
var bannedWordsRe = regexp.MustCompile(`(?i)\b(fuck|shit|salaud|connard|enculé|pute|merde|nique|batard|bâtard|arnaque|scam|escroc|fake|contrefa[cç]on|whatsapp\s*:?\s*\+?\d|https?://|www\.|t\.me/|@gmail|@yahoo|@hotmail|\+\d{6,})\b`)

// autoModerate renvoie (status, reason). status='approved' si rien à
// signaler, sinon 'pending' + la raison.
func autoModerate(title, comment string) (string, string) {
	txt := title + " " + comment
	if m := bannedWordsRe.FindString(txt); m != "" {
		return "pending", "terme signalé par le filtre automatique : " + m
	}
	// avis très court + note extrême = suspect (spam de notes)
	if len([]rune(strings.TrimSpace(comment))) < 3 {
		return "pending", "commentaire vide ou trop court"
	}
	// répétition d'un même caractère (aaaaaa, !!!!!!)
	if regexp.MustCompile(`(.)\1{6,}`).MatchString(comment) {
		return "pending", "caractères répétés (spam probable)"
	}
	return "approved", ""
}

func (s *server) createReview(w http.ResponseWriter, r *http.Request) {
	productID := atoi(r.PathValue("id"))
	var body struct {
		CustomerID int64    `json:"customer_id"`
		GuestName  string   `json:"guest_name"`  // conservé pour l'affichage si pas de compte
		GuestEmail string   `json:"guest_email"` // jamais affiché publiquement
		OrderID    *int64   `json:"order_id"`
		Rating     int      `json:"rating"`
		Title      string   `json:"title"`
		Comment    string   `json:"comment"`
		Photos     []string `json:"photos"`  // URLs MinIO déjà uploadées (POST /reviews/upload)
		Country    string   `json:"country"` // code ISO2 du client (drapeau à côté du nom)
		Avatar     string   `json:"avatar"`  // photo de profil client (optionnel)
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", "JSON attendu : "+err.Error())
		return
	}
	if body.Rating < 1 || body.Rating > 5 {
		kit.Fail(w, 400, "missing_fields", "rating (1-5) obligatoire")
		return
	}
	// Seuls les acheteurs vérifiés peuvent laisser un avis (décision
	// fondateur du 2026-09-01). Il faut donc un compte + une commande
	// livrée contenant ce produit. Les avis "invité" et non vérifiés ne
	// sont plus acceptés côté public — seul le seed communauté (endpoint
	// admin séparé) insère des avis is_community=true.
	if body.CustomerID == 0 || body.OrderID == nil {
		kit.Fail(w, 403, "purchase_required", "seuls les acheteurs vérifiés peuvent laisser un avis (compte + commande livrée requis)")
		return
	}
	if !s.verifyPurchase(r.Context(), *body.OrderID, body.CustomerID, productID) {
		kit.Fail(w, 403, "purchase_not_found", "aucun achat livré de ce produit trouvé pour cette commande")
		return
	}
	// un seul avis par (client, produit)
	var existing int64
	_ = s.db.QueryRow(r.Context(),
		`SELECT id FROM reviews WHERE product_id=$1 AND customer_id=$2 AND review_type='product' LIMIT 1`,
		productID, body.CustomerID).Scan(&existing)
	if existing != 0 {
		kit.Fail(w, 409, "already_reviewed", "vous avez déjà laissé un avis sur ce produit")
		return
	}

	if len(body.Photos) > 6 {
		body.Photos = body.Photos[:6]
	}
	photosJSON, _ := json.Marshal(body.Photos)
	status, reason := autoModerate(body.Title, body.Comment)
	customerID := body.CustomerID

	var id int64
	err := s.db.QueryRow(r.Context(), `
		INSERT INTO reviews
		  (product_id, customer_id, guest_name, guest_email, order_id, rating, title, comment,
		   photos, verified_purchase, status, moderation_reason, review_type, is_community,
		   reviewer_country, reviewer_avatar)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10,$11,'product',FALSE,$12,$13) RETURNING id`,
		productID, &customerID, body.GuestName, body.GuestEmail, body.OrderID, body.Rating,
		strings.TrimSpace(body.Title), strings.TrimSpace(body.Comment), photosJSON,
		status, reason, strings.ToUpper(body.Country), body.Avatar,
	).Scan(&id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	var vendorID int64
	var productName string
	_ = s.db.QueryRow(r.Context(), "SELECT vendor_id, name FROM products WHERE id = $1", productID).Scan(&vendorID, &productName)
	kit.Publish(s.kafka, "review.created", fmt.Sprint(id), map[string]any{
		"review_id": id, "product_id": productID, "product_name": productName, "vendor_id": vendorID,
		"rating": body.Rating, "comment": body.Comment, "status": status,
		"at": time.Now().UTC().Format(time.RFC3339),
	})

	kit.JSON(w, 201, map[string]any{
		"id": id, "verified_purchase": true, "status": status,
		"pending": status == "pending", "moderation_reason": reason,
	})
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

// orderProductsForReview interroge order-svc pour la commande et renvoie
// (customerIDok, produits) — les product_id livrés de la commande.
func (s *server) orderProductsForReview(ctx context.Context, orderID, customerID int64) (bool, []int64) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/orders/%d", s.orderURL, orderID), nil)
	if err != nil {
		return false, nil
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		return false, nil
	}
	defer resp.Body.Close()
	var order struct {
		CustomerID int64  `json:"customer_id"`
		Status     string `json:"status"`
		Lines      []struct {
			ProductID int64 `json:"product_id"`
		} `json:"lines"`
	}
	if json.NewDecoder(resp.Body).Decode(&order) != nil || order.CustomerID != customerID {
		return false, nil
	}
	ids := make([]int64, 0, len(order.Lines))
	for _, l := range order.Lines {
		ids = append(ids, l.ProductID)
	}
	return true, ids
}

// uploadReviewPhoto — 1 photo jointe à un avis, vers MinIO préfixe
// "reviews/". Rendu par img.miadmarket.ca comme le reste des médias.
func (s *server) uploadReviewPhoto(w http.ResponseWriter, r *http.Request) {
	if s.media == nil {
		kit.Fail(w, 503, "media_unavailable", "stockage d'images indisponible (MinIO non configuré)")
		return
	}
	if err := r.ParseMultipartForm(15 << 20); err != nil {
		kit.Fail(w, 400, "bad_request", "formulaire multipart invalide (max 15 Mo): "+err.Error())
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		kit.Fail(w, 400, "bad_request", "champ 'file' manquant")
		return
	}
	defer file.Close()
	ct := header.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "image/") {
		kit.Fail(w, 400, "bad_request", "seules les images sont acceptées")
		return
	}
	name := fmt.Sprintf("%d-%d", time.Now().UnixNano(), rand.Intn(100000))
	url, err := s.media.Upload(r.Context(), "reviews", name+extForType(ct), file, header.Size, ct)
	if err != nil {
		kit.Fail(w, 502, "upload_failed", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]string{"url": url})
}

func extForType(ct string) string {
	switch ct {
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	default:
		return ".jpg"
	}
}

// markReviewHelpful — vote "utile", 1 par (avis, votant). voter_key vient
// du frontend : "cust:<id>" si connecté, sinon "anon:<empreinte>".
func (s *server) markReviewHelpful(w http.ResponseWriter, r *http.Request) {
	reviewID := atoi(r.PathValue("id"))
	var body struct {
		VoterKey string `json:"voter_key"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if strings.TrimSpace(body.VoterKey) == "" {
		kit.Fail(w, 400, "missing_voter", "voter_key requis")
		return
	}
	tag, err := s.db.Exec(r.Context(),
		`INSERT INTO review_helpful_votes (review_id, voter_key) VALUES ($1,$2)
		 ON CONFLICT DO NOTHING`, reviewID, body.VoterKey)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 1 {
		_, _ = s.db.Exec(r.Context(), `UPDATE reviews SET helpful_count = helpful_count + 1 WHERE id = $1`, reviewID)
	}
	var count int
	_ = s.db.QueryRow(r.Context(), `SELECT helpful_count FROM reviews WHERE id = $1`, reviewID).Scan(&count)
	kit.JSON(w, 200, map[string]any{"helpful_count": count, "counted": tag.RowsAffected() == 1})
}

// canReviewOrder — pour le dashboard client et l'email post-livraison :
// quels produits d'une commande (livrée) sont encore à noter.
func (s *server) canReviewOrder(w http.ResponseWriter, r *http.Request) {
	orderID := atoi(r.PathValue("orderId"))
	customerID := atoi(r.URL.Query().Get("customer_id"))
	if customerID == 0 {
		kit.Fail(w, 400, "missing_customer", "customer_id requis")
		return
	}
	ok, ids := s.orderProductsForReview(r.Context(), orderID, customerID)
	if !ok {
		kit.Fail(w, 403, "order_not_found", "commande introuvable pour ce client")
		return
	}
	// produits déjà notés par ce client
	done := map[int64]bool{}
	drow, _ := s.db.Query(r.Context(),
		`SELECT product_id FROM reviews WHERE customer_id=$1 AND review_type='product'`, customerID)
	if drow != nil {
		for drow.Next() {
			var pid int64
			if drow.Scan(&pid) == nil {
				done[pid] = true
			}
		}
		drow.Close()
	}
	out := []map[string]any{}
	seen := map[int64]bool{}
	for _, pid := range ids {
		if seen[pid] || done[pid] {
			continue
		}
		seen[pid] = true
		var name, slug, img string
		_ = s.db.QueryRow(r.Context(),
			`SELECT name, slug, COALESCE(images->>0,'') FROM products WHERE id=$1 AND lang='fr'`, pid).
			Scan(&name, &slug, &img)
		out = append(out, map[string]any{"product_id": pid, "name": name, "slug": slug, "image": img})
	}
	kit.JSON(w, 200, map[string]any{"order_id": orderID, "to_review": out})
}

// confirmDelivery — l'acheteur confirme la réception de sa commande, note
// la livraison (1-5) et joint éventuellement une photo du colis reçu.
// Enregistré comme un avis review_type='delivery' (1 par commande).
func (s *server) confirmDelivery(w http.ResponseWriter, r *http.Request) {
	orderID := atoi(r.PathValue("orderId"))
	var body struct {
		CustomerID     int64    `json:"customer_id"`
		DeliveryRating int      `json:"delivery_rating"`
		Comment        string   `json:"comment"`
		Photos         []string `json:"photos"`
		Country        string   `json:"country"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.CustomerID == 0 || body.DeliveryRating < 1 || body.DeliveryRating > 5 {
		kit.Fail(w, 400, "missing_fields", "customer_id et delivery_rating (1-5) obligatoires")
		return
	}
	ok, ids := s.orderProductsForReview(r.Context(), orderID, body.CustomerID)
	if !ok || len(ids) == 0 {
		kit.Fail(w, 403, "order_not_found", "commande introuvable pour ce client")
		return
	}
	var existing int64
	_ = s.db.QueryRow(r.Context(),
		`SELECT id FROM reviews WHERE order_id=$1 AND review_type='delivery' LIMIT 1`, orderID).Scan(&existing)
	if existing != 0 {
		kit.Fail(w, 409, "already_confirmed", "livraison déjà confirmée pour cette commande")
		return
	}
	if len(body.Photos) > 4 {
		body.Photos = body.Photos[:4]
	}
	photosJSON, _ := json.Marshal(body.Photos)
	status, reason := autoModerate("", body.Comment)
	// on rattache l'avis livraison au 1er produit de la commande (pour
	// qu'il soit visible sur une fiche produit) tout en le marquant
	// review_type='delivery'.
	cid := body.CustomerID
	var id int64
	err := s.db.QueryRow(r.Context(), `
		INSERT INTO reviews
		  (product_id, customer_id, order_id, rating, delivery_rating, comment, photos,
		   verified_purchase, status, moderation_reason, review_type, reviewer_country)
		VALUES ($1,$2,$3,$4,$4,$5,$6,TRUE,$7,$8,'delivery',$9) RETURNING id`,
		ids[0], &cid, orderID, body.DeliveryRating, strings.TrimSpace(body.Comment), photosJSON,
		status, reason, strings.ToUpper(body.Country),
	).Scan(&id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.Publish(s.kafka, "delivery.confirmed", fmt.Sprint(orderID), map[string]any{
		"order_id": orderID, "customer_id": body.CustomerID, "delivery_rating": body.DeliveryRating,
		"at": time.Now().UTC().Format(time.RFC3339),
	})
	kit.JSON(w, 201, map[string]any{"id": id, "status": status, "pending": status == "pending"})
}

// ---- Avis "de la communauté" (seed) --------------------------------------
// Prénoms + noms courants d'Afrique de l'Ouest/Centrale, par pays, pour
// des avis crédibles sans données personnelles réelles.
var communityNames = map[string][]string{
	"SN": {"Awa Ndiaye", "Cheikh Diop", "Fatou Sarr", "Moussa Fall", "Aïssatou Ba", "Ibrahima Sy", "Mariama Gueye", "Ousmane Sow"},
	"CI": {"Aya Kouassi", "Konan N'Guessan", "Adjoua Brou", "Yao Koffi", "Affoué Tanoh", "Kouadio Kouamé"},
	"CM": {"Njoya Ngassa", "Aïcha Bello", "Emmanuel Fotso", "Chantal Mballa", "Roland Kamga", "Bih Ncho"},
	"BJ": {"Rachidatou Adjovi", "Coovi Dossou", "Grâce Hounkpatin", "Sègla Ahouandjinou"},
	"GN": {"Mamadou Diallo", "Kadiatou Bah", "Alpha Condé", "Fatoumata Camara", "Sékou Touré"},
	"ML": {"Oumar Traoré", "Assitan Keïta", "Modibo Coulibaly", "Rokia Sangaré"},
	"GH": {"Kwame Mensah", "Ama Owusu", "Kojo Boateng", "Akosua Sarpong"},
	"NG": {"Chidi Okafor", "Ngozi Eze", "Bola Adeyemi", "Emeka Nwosu", "Halima Sani"},
	"":   {"Client MIAD", "Cliente MIAD"},
}
var communityComments = []struct {
	min, max int
	text     []string
}{
	{4, 5, []string{
		"Produit conforme à la description, très bonne qualité. Livraison un peu longue mais l'article en vaut la peine.",
		"Superbe finition, exactement comme sur les photos. Je recommande cette boutique.",
		"Très satisfaite de mon achat, la matière est agréable et le travail soigné. Merci au vendeur.",
		"Reçu en bon état, bien emballé. Le rendu est encore plus beau en vrai.",
		"Excellent rapport qualité-prix. C'est ma deuxième commande et toujours au top.",
		"Article authentique, fait main comme indiqué. Petit délai de livraison mais ça valait l'attente.",
	}},
	{3, 4, []string{
		"Bon produit dans l'ensemble, la taille est un peu différente de ce que j'attendais mais la qualité est là.",
		"Correct pour le prix. Les couleurs sont légèrement moins vives qu'en photo.",
		"Satisfait, livraison dans les temps. Un petit défaut de finition sans gravité.",
	}},
}

// seedCommunityReviews — POST /admin/reviews/seed
// body: { "product_id": N, "count": 5, "vendor_avatar": "url", "rep_avatar": "url" }
// Crée `count` avis is_community=true : nom + pays tirés au sort, avatar =
// photo du vendeur ou du représentant du pays (fournie par l'appelant),
// commentaire tiré d'une banque, photos réutilisées depuis la galerie du
// produit (les "anciennes photos"), note 4-5 majoritaire.
func (s *server) seedCommunityReviews(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ProductID    int64    `json:"product_id"`
		Count        int      `json:"count"`
		VendorAvatar string   `json:"vendor_avatar"`
		RepAvatar    string   `json:"rep_avatar"`
		Countries    []string `json:"countries"` // pays à faire tourner (défaut: SN, CI, CM, BJ, GN)
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ProductID == 0 {
		kit.Fail(w, 400, "invalid_body", "product_id requis")
		return
	}
	if body.Count <= 0 || body.Count > 30 {
		body.Count = 6
	}
	if len(body.Countries) == 0 {
		body.Countries = []string{"SN", "CI", "CM", "BJ", "GN", "ML"}
	}

	// galerie du produit : on réutilise ces images comme "photos clients"
	var imagesJSON []byte
	_ = s.db.QueryRow(r.Context(),
		`SELECT images FROM products WHERE id=$1 AND lang='fr'`, body.ProductID).Scan(&imagesJSON)
	var gallery []string
	_ = json.Unmarshal(imagesJSON, &gallery)

	created := 0
	for i := 0; i < body.Count; i++ {
		country := body.Countries[rand.Intn(len(body.Countries))]
		names := communityNames[country]
		if len(names) == 0 {
			names = communityNames[""]
		}
		name := names[rand.Intn(len(names))]
		// 75% d'avis 4-5, 25% d'avis 3-4
		bank := communityComments[0]
		if rand.Intn(4) == 0 {
			bank = communityComments[1]
		}
		rating := bank.min + rand.Intn(bank.max-bank.min+1)
		comment := bank.text[rand.Intn(len(bank.text))]
		// 1 photo sur 2, tirée de la galerie
		photos := []string{}
		if len(gallery) > 0 && rand.Intn(2) == 0 {
			photos = []string{gallery[rand.Intn(len(gallery))]}
		}
		photosJSON, _ := json.Marshal(photos) // toujours un tableau JSON, jamais "null"
		// avatar : représentant du pays si fourni, sinon vendeur, sinon rien
		avatar := body.RepAvatar
		if avatar == "" {
			avatar = body.VendorAvatar
		}
		// email masqué déterministe (jamais affiché mais stocké pour trace)
		masked := maskedEmail(name)
		// date étalée sur ~120 jours en arrière
		createdAt := time.Now().AddDate(0, 0, -rand.Intn(120)-1)

		_, err := s.db.Exec(r.Context(), `
			INSERT INTO reviews
			  (product_id, customer_id, guest_name, guest_email, rating, comment, photos,
			   verified_purchase, status, review_type, is_community, reviewer_country, reviewer_avatar, created_at)
			VALUES ($1,NULL,$2,$3,$4,$5,$6,FALSE,'approved','product',TRUE,$7,$8,$9)`,
			body.ProductID, name, masked, rating, comment, photosJSON,
			country, avatar, createdAt,
		)
		if err == nil {
			created++
		}
	}
	kit.JSON(w, 201, map[string]any{"product_id": body.ProductID, "created": created})
}

func maskedEmail(name string) string {
	base := strings.ToLower(strings.ReplaceAll(strings.Fields(name + " x")[0], "'", ""))
	if len(base) > 2 {
		base = base[:2] + "***"
	}
	return base + "@***.com"
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
			"isRoot":     parent == 0,
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
		Name            *string  `json:"name"`
		ParentID        *int64   `json:"parent_id"`
		ImageURL        *string  `json:"image_url"`
		SortOrder       *int64   `json:"sort_order"`
		CommissionRate  *float64 `json:"commission_rate"`
		ClearCommission bool     `json:"clear_commission"`
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
		Tags       []string         `json:"tags"`
		IsVariable bool             `json:"is_variable"`
		Variations []map[string]any `json:"variations"`
		// Caractéristiques + sous-titre — mêmes pour les deux langues à la
		// création (traduisibles ensuite via PATCH par langue). Optionnels :
		// le flux normal est création simple puis édition. Ajouté 2026-08-31.
		SubtitleFR     string           `json:"subtitle_fr"`
		SubtitleEN     string           `json:"subtitle_en"`
		Specifications []map[string]any `json:"specifications"`
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
	tagsJSON, _ := json.Marshal(body.Tags)
	if body.Specifications == nil {
		body.Specifications = []map[string]any{}
	}
	specsJSON, _ := json.Marshal(body.Specifications)
	ctx := r.Context()

	// Modération : un produit créé par un vendeur avec require_moderation=true
	// (vendor-svc, défaut TRUE) part en pending_review au lieu d'active —
	// invisible côté storefront public (listProducts filtre déjà sur
	// status='active' par défaut) jusqu'à approbation admin. En cas d'échec
	// de résolution (vendor-svc indisponible), on retombe sur active plutôt
	// que de bloquer la création — la modération n'est pas plus critique que
	// la disponibilité du service.
	initialStatus := "active"
	if s.requiresModeration(ctx, body.VendorID) {
		initialStatus = "pending_review"
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	insertLang := func(lang, name, subtitle string) (int64, error) {
		var id int64
		err := tx.QueryRow(ctx, `
			INSERT INTO products (trid, lang, vendor_id, category_id, brand_id, name, slug, price_usd, images, tags, is_variable, sku, barcode, stock, status, specifications, subtitle)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
			trid, lang, body.VendorID, body.CategoryID, nullIfZero(body.BrandID), name, slugify(name), body.PriceUSD, imagesJSON, tagsJSON, body.IsVariable,
			body.SKU, body.Barcode, body.Stock, initialStatus, specsJSON, subtitle,
		).Scan(&id)
		return id, err
	}
	idFR, err := insertLang("fr", body.NameFR, body.SubtitleFR)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	nameEN := body.NameEN
	if nameEN == "" {
		nameEN = body.NameFR // fallback explicite : EN = FR tant que non traduit
	}
	subtitleEN := body.SubtitleEN
	if subtitleEN == "" {
		subtitleEN = body.SubtitleFR
	}
	idEN, err := insertLang("en", nameEN, subtitleEN)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	// Variations dupliquées pour idFR ET idEN : chaque langue est un produit
	// à part entière côté schéma (trid les relie) — ne les insérer que pour
	// idFR laissait la version EN sans variations du tout (bug trouvé le
	// 2026-08-25, jamais remarqué faute d'UI admin pour créer un produit
	// variable avant ce jour).
	for _, v := range body.Variations {
		attrs, _ := json.Marshal(v["attributes"])
		for _, pid := range []int64{idFR, idEN} {
			if _, err := tx.Exec(ctx, `
				INSERT INTO product_variations (product_id, sku, attributes, price_usd, stock, image_url)
				VALUES ($1,$2,$3,$4,$5,$6)`,
				pid, v["sku"], attrs, toFloat(v["price_usd"]), toInt(v["stock"]), v["image_url"]); err != nil {
				kit.Fail(w, 500, "db_error", err.Error())
				return
			}
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

// requiresModeration — interroge vendor-svc pour savoir si CE vendeur
// publie ses produits directement ou doit passer par une approbation admin
// (vendors.require_moderation, TRUE par défaut). Indisponibilité de
// vendor-svc = pas de blocage de la création, juste pas de modération pour
// cette tentative (log côté appelant si besoin, pas ici — createProduct
// reste la seule source d'appel pour l'instant).
func (s *server) requiresModeration(ctx context.Context, vendorID int64) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/vendors/%d", s.vendorURL, vendorID), nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var v struct {
		RequireModeration bool `json:"require_moderation"`
	}
	if json.NewDecoder(resp.Body).Decode(&v) != nil {
		return false
	}
	return v.RequireModeration
}

// moderateProduct — admin approuve/rejette un produit en pending_review.
// Applique le même statut aux DEUX langues du trid (comme createProduct
// duplique déjà toute écriture par langue). Un rejet repasse le produit
// à 'rejected' (jamais supprimé — le vendeur garde son brouillon, peut le
// corriger et le soumettre à nouveau via un futur endpoint de resoumission,
// hors périmètre ici).
func (s *server) moderateProduct(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	var body struct {
		Status string `json:"status"` // "approved" ou "rejected"
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Status != "approved" && body.Status != "rejected" {
		kit.Fail(w, 400, "invalid_status", "status doit être approved ou rejected")
		return
	}

	var trid string
	var vendorID int64
	var name string
	if err := s.db.QueryRow(r.Context(),
		"SELECT trid, vendor_id, name FROM products WHERE id = $1 AND status = 'pending_review'", id,
	).Scan(&trid, &vendorID, &name); err != nil {
		kit.Fail(w, 404, "product_not_found", fmt.Sprintf("produit %d introuvable ou pas en attente de modération", id))
		return
	}

	newStatus := "active"
	if body.Status == "rejected" {
		newStatus = "rejected"
	}
	if _, err := s.db.Exec(r.Context(),
		"UPDATE products SET status = $1 WHERE trid = $2", newStatus, trid,
	); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	kit.Publish(s.kafka, "product.status_changed", trid, map[string]any{
		"trid": trid, "product_id": id, "product_name": name, "vendor_id": vendorID,
		"status": newStatus, "reason": body.Reason,
		"at": time.Now().UTC().Format(time.RFC3339),
	})

	kit.JSON(w, 200, map[string]any{"id": id, "status": newStatus})
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
		Name              *string   `json:"name"`
		Description       *string   `json:"description"`
		ShortDescription  *string   `json:"short_description"`
		CategoryID        *int64    `json:"category_id"`
		BrandID           *int64    `json:"brand_id"`
		PriceUSD          *float64  `json:"price_usd"`
		SalePriceUSD      *float64  `json:"sale_price_usd"`
		SKU               *string   `json:"sku"`
		Barcode           *string   `json:"barcode"`
		Stock             *int      `json:"stock"`
		LowStockThreshold *int      `json:"low_stock_threshold"`
		BackordersAllowed *bool     `json:"backorders_allowed"`
		WeightKg          *float64  `json:"weight_kg"`
		LengthCm          *float64  `json:"length_cm"`
		WidthCm           *float64  `json:"width_cm"`
		HeightCm          *float64  `json:"height_cm"`
		ShippingClass     *string   `json:"shipping_class"`
		MetaTitle         *string   `json:"meta_title"`
		MetaDescription   *string   `json:"meta_description"`
		Images            *[]string `json:"images"`
		Tags              *[]string `json:"tags"`
		Status            *string   `json:"status"`
		HSCode            *string   `json:"hs_code"`
		OriginCountry     *string   `json:"origin_country"`
		// Caractéristiques : tableau ordonné [{k,v,source}]. Sous-titre :
		// une ligne sous le nom. Édités au back-office (2026-08-31).
		Specifications *[]map[string]any `json:"specifications"`
		Subtitle       *string           `json:"subtitle"`
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
	if body.HSCode != nil {
		add("hs_code", *body.HSCode)
	}
	if body.OriginCountry != nil {
		add("origin_country", *body.OriginCountry)
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
	if body.Tags != nil {
		tagsJSON, _ := json.Marshal(*body.Tags)
		add("tags", tagsJSON)
	}
	if body.Specifications != nil {
		specsJSON, _ := json.Marshal(*body.Specifications)
		add("specifications", specsJSON)
	}
	if body.Subtitle != nil {
		add("subtitle", *body.Subtitle)
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
	// vendor_id lu AVANT le DELETE — sinon plus moyen de savoir quel
	// vendeur resynchroniser une fois la ligne disparue (voir
	// vendor-svc.consumeProductEvents, qui écoute product.status_changed
	// pour recalculer product_count).
	var vendorID int64
	_ = s.db.QueryRow(r.Context(), "SELECT vendor_id FROM products WHERE id = $1", id).Scan(&vendorID)

	tag, err := s.db.Exec(r.Context(), "DELETE FROM products WHERE id = $1", id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "product_not_found", fmt.Sprintf("produit %d introuvable", id))
		return
	}
	if vendorID > 0 {
		kit.Publish(s.kafka, "product.status_changed", fmt.Sprintf("deleted-%d", id), map[string]any{
			"product_id": id, "vendor_id": vendorID, "status": "deleted",
			"at": time.Now().UTC().Format(time.RFC3339),
		})
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

	// vendor_id distincts AVANT l'action — nécessaire pour set_status/delete
	// (resynchronisation product_count côté vendor-svc, voir deleteProduct
	// ci-dessus pour la même remarque sur delete). set_category n'affecte
	// jamais product_count, pas besoin ici.
	var affectedVendorIDs []int64
	if body.Action == "set_status" || body.Action == "delete" {
		rows, _ := s.db.Query(r.Context(), "SELECT DISTINCT vendor_id FROM products WHERE id = ANY($1)", body.IDs)
		if rows != nil {
			defer rows.Close()
			for rows.Next() {
				var vid int64
				if rows.Scan(&vid) == nil {
					affectedVendorIDs = append(affectedVendorIDs, vid)
				}
			}
		}
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
	for _, vid := range affectedVendorIDs {
		kit.Publish(s.kafka, "product.status_changed", fmt.Sprintf("bulk-%s-%d", body.Action, vid), map[string]any{
			"vendor_id": vid, "bulk_action": body.Action,
			"at": time.Now().UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{"action": body.Action, "rows_affected": tag.RowsAffected()})
}

// collapseFakeVariables — POST /admin/collapse-fake-variables
// Répare les produits marqués is_variable=true qui n'ont en réalité qu'UNE
// seule variation : le frontend affiche alors soit un sélecteur à un seul
// bouton (inutile — cf. "CONTENANCE 200ml"), soit un bouton "Choisir" en
// cul-de-sac quand il n'arrive pas à construire le bouton (pagne "Motifs
// Tribaux" — achat impossible). Vidéos du 2026-08-28.
//
// Action pour chaque produit concerné : copier price_usd/stock de la
// variation vers le produit, supprimer la variation, is_variable=false.
// Critère retenu le 2026-08-28 : TOUTE variation unique, quel que soit son
// attribut (Variante/Modèle/Contenance/…). Les vrais produits variables
// (≥2 variations) ne sont jamais touchés.
//
// Query param : ?dry_run=true -> liste seulement, ne modifie rien.
func (s *server) collapseFakeVariables(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	dryRun := r.URL.Query().Get("dry_run") == "true"

	// Produits variables ayant exactement 1 variation.
	rows, err := s.db.Query(ctx, `
		SELECT p.id, p.name, v.id, v.price_usd, v.stock, v.attributes
		FROM products p
		JOIN product_variations v ON v.product_id = p.id
		WHERE p.is_variable = TRUE
		  AND (SELECT COUNT(*) FROM product_variations v2 WHERE v2.product_id = p.id) = 1
		ORDER BY p.id`)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	type cand struct {
		productID   int64
		name        string
		variationID int64
		price       float64
		stock       int
		attrs       string
	}
	var cands []cand
	for rows.Next() {
		var c cand
		var attrsRaw []byte
		if rows.Scan(&c.productID, &c.name, &c.variationID, &c.price, &c.stock, &attrsRaw) == nil {
			c.attrs = string(attrsRaw)
			cands = append(cands, c)
		}
	}
	rows.Close()

	details := make([]map[string]any, 0, len(cands))
	collapsed := 0
	for _, c := range cands {
		details = append(details, map[string]any{
			"product_id": c.productID, "name": c.name,
			"new_price_usd": c.price, "new_stock": c.stock,
			"removed_variation_id": c.variationID, "removed_attributes": json.RawMessage(c.attrs),
		})
		if dryRun {
			continue
		}
		tx, err := s.db.Begin(ctx)
		if err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		ok := true
		if _, err := tx.Exec(ctx,
			`UPDATE products SET price_usd = $1, stock = $2, is_variable = FALSE WHERE id = $3`,
			c.price, c.stock, c.productID); err != nil {
			ok = false
		}
		if ok {
			if _, err := tx.Exec(ctx,
				`DELETE FROM product_variations WHERE id = $1`, c.variationID); err != nil {
				ok = false
			}
		}
		if !ok {
			_ = tx.Rollback(ctx)
			kit.Fail(w, 500, "db_error", fmt.Sprintf("échec collapse produit %d — rollback", c.productID))
			return
		}
		if err := tx.Commit(ctx); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		collapsed++
	}

	kit.JSON(w, 200, map[string]any{
		"dry_run":            dryRun,
		"candidates":         len(cands),
		"products_collapsed": collapsed,
		"details":            details,
	})
}

// backfillShoeSizes  — POST /admin/backfill-shoe-sizes    (grille pointures 36→46)
// backfillClothingSizes — POST /admin/backfill-clothing-sizes (grille S→XXXL)
//
// Même logique : parcourt les produits d'une famille de catégories (détectée
// par le nom), et pour chacun SANS variation de taille, crée la grille sous
// l'attribut donné, en reprenant prix + stock du produit. Idempotent (skip
// si une variation de taille existe déjà). Query params :
//   ?dry_run=true  -> ne modifie rien, renvoie ce qui SERAIT fait
//   ?category_id=N -> restreint à une catégorie précise
func (s *server) backfillShoeSizes(w http.ResponseWriter, r *http.Request) {
	s.backfillSizes(w, r, backfillSpec{
		matchCategory: isShoeCategoryName,
		attrName:      shoeSizeAttrName,
		grid:          shoeSizeGrid,
		familyLabel:   "chaussures",
		noMatchNote:   "aucune catégorie 'chaussures' détectée par son nom (chaussure, sandale, babouche, basket, ...)",
	})
}

func (s *server) backfillClothingSizes(w http.ResponseWriter, r *http.Request) {
	s.backfillSizes(w, r, backfillSpec{
		matchCategory:    isClothingCategoryName,
		matchProductName: isClothingProductName, // filtre supplémentaire : nom du produit
		attrName:         clothingSizeAttrName,
		grid:             clothingSizeGrid,
		familyLabel:      "vêtements",
		noMatchNote:      "aucune catégorie 'vêtements' détectée par son nom",
	})
}

type backfillSpec struct {
	matchCategory func(name string) bool
	// matchProductName — filtre optionnel sur le nom du produit (nil = tous
	// les produits des catégories qui matchent). Utilisé pour les vêtements
	// où la catégorie "Mode - Vêtements" contient aussi des non-vêtements.
	matchProductName func(name string) bool
	attrName         string
	grid             []string
	familyLabel      string // "chaussures" / "vêtements" — pour les messages
	noMatchNote      string
}

func (s *server) backfillSizes(w http.ResponseWriter, r *http.Request, spec backfillSpec) {
	ctx := r.Context()
	dryRun := r.URL.Query().Get("dry_run") == "true"
	onlyCat := atoi(r.URL.Query().Get("category_id"))

	// 1. Catégories de la famille (par nom). Tous les IDs (FR + EN).
	catRows, err := s.db.Query(ctx, `SELECT id, name FROM categories`)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	catIDs := map[int64]string{}
	for catRows.Next() {
		var cid int64
		var cname string
		if catRows.Scan(&cid, &cname) == nil && spec.matchCategory(cname) {
			if onlyCat == 0 || cid == onlyCat {
				catIDs[cid] = cname
			}
		}
	}
	catRows.Close()
	if len(catIDs) == 0 {
		kit.JSON(w, 200, map[string]any{
			"dry_run": dryRun, "matched_categories": 0, "products_scanned": 0,
			"products_updated": 0, "variations_created": 0, "note": spec.noMatchNote,
		})
		return
	}
	catIDList := make([]int64, 0, len(catIDs))
	catNames := make([]string, 0, len(catIDs))
	for cid, cname := range catIDs {
		catIDList = append(catIDList, cid)
		catNames = append(catNames, cname)
	}

	// 2. Produits de ces catégories.
	prodRows, err := s.db.Query(ctx,
		`SELECT id, name, price_usd, stock, sku, is_variable
		 FROM products WHERE category_id = ANY($1) ORDER BY id`, catIDList)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	type prod struct {
		id    int64
		name  string
		price float64
		stock int
		sku   string
	}
	var products []prod
	for prodRows.Next() {
		var p prod
		var isVar bool
		if prodRows.Scan(&p.id, &p.name, &p.price, &p.stock, &p.sku, &isVar) == nil {
			products = append(products, p)
		}
	}
	prodRows.Close()

	scanned := len(products)
	updated, varsCreated, skipped, filteredByName := 0, 0, 0, 0
	details := []map[string]any{}

	for _, p := range products {
		// Filtre optionnel sur le nom du produit (vêtements : la catégorie
		// "Mode - Vêtements" contient aussi des chapeaux, de la vaisselle…).
		if spec.matchProductName != nil && !spec.matchProductName(p.name) {
			filteredByName++
			continue
		}

		existRows, err := s.db.Query(ctx,
			`SELECT attributes FROM product_variations WHERE product_id = $1`, p.id)
		if err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		var existing []map[string]any
		for existRows.Next() {
			var raw []byte
			if existRows.Scan(&raw) == nil {
				var m map[string]any
				_ = json.Unmarshal(raw, &m)
				existing = append(existing, map[string]any{"attributes": m})
			}
		}
		existRows.Close()

		if variationsHaveSizeAttr(existing) {
			skipped++
			continue
		}

		details = append(details, map[string]any{
			"product_id": p.id, "name": p.name, "price_usd": p.price,
			"stock_per_size": p.stock, "sizes": spec.grid,
		})
		if dryRun {
			updated++
			varsCreated += len(spec.grid)
			continue
		}

		// Transaction par produit : toute la grille, ou rien.
		tx, err := s.db.Begin(ctx)
		if err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		ok := true
		for _, size := range spec.grid {
			attrsJSON, _ := json.Marshal(map[string]string{spec.attrName: size})
			vsku := p.sku
			if vsku != "" {
				vsku = vsku + "-" + size
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO product_variations (product_id, sku, attributes, price_usd, stock, image_url)
				VALUES ($1,$2,$3,$4,$5,'')`,
				p.id, vsku, attrsJSON, p.price, p.stock); err != nil {
				ok = false
				break
			}
		}
		if ok {
			if _, err := tx.Exec(ctx, "UPDATE products SET is_variable = TRUE WHERE id = $1", p.id); err != nil {
				ok = false
			}
		}
		if !ok {
			_ = tx.Rollback(ctx)
			kit.Fail(w, 500, "db_error", fmt.Sprintf("échec insertion tailles pour produit %d (%s) — rollback", p.id, spec.familyLabel))
			return
		}
		if err := tx.Commit(ctx); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		updated++
		varsCreated += len(spec.grid)
	}

	kit.JSON(w, 200, map[string]any{
		"dry_run":            dryRun,
		"family":             spec.familyLabel,
		"matched_categories": len(catIDs),
		"shoe_categories":    len(catIDs), // compat : ancienne clé lue par VariationsMaintenance.tsx
		"category_names":     catNames,
		"products_scanned":   scanned,
		"products_filtered":  filteredByName, // écartés par le nom (non-vêtements)
		"products_updated":   updated,
		"products_skipped":   skipped, // déjà une variation de taille
		"variations_created": varsCreated,
		"size_grid":          spec.grid,
		"attribute":          spec.attrName,
		"details":            details,
	})
}

// createVariation — nouvelle déclinaison (taille/couleur/...) pour un
// produit variable. Marque aussi le produit is_variable=true si ce n'était
// pas déjà le cas (un vendeur peut convertir un produit simple en variable
// en ajoutant sa première variation).
func (s *server) createVariation(w http.ResponseWriter, r *http.Request) {
	productID := atoi(r.PathValue("id"))
	var body struct {
		SKU        string         `json:"sku"`
		Attributes map[string]any `json:"attributes"`
		PriceUSD   float64        `json:"price_usd"`
		Stock      int            `json:"stock"`
		ImageURL   string         `json:"image_url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	attrsJSON, _ := json.Marshal(body.Attributes)

	var id int64
	err := s.db.QueryRow(r.Context(), `
		INSERT INTO product_variations (product_id, sku, attributes, price_usd, stock, image_url)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
		productID, body.SKU, attrsJSON, body.PriceUSD, body.Stock, body.ImageURL,
	).Scan(&id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if _, err := s.db.Exec(r.Context(), "UPDATE products SET is_variable = TRUE WHERE id = $1", productID); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 201, map[string]any{"id": id})
}

func (s *server) updateVariation(w http.ResponseWriter, r *http.Request) {
	variationID := atoi(r.PathValue("variation_id"))
	var body struct {
		SKU        *string        `json:"sku"`
		Attributes map[string]any `json:"attributes"`
		PriceUSD   *float64       `json:"price_usd"`
		Stock      *int           `json:"stock"`
		ImageURL   *string        `json:"image_url"`
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
	if body.SKU != nil {
		add("sku", *body.SKU)
	}
	if body.Attributes != nil {
		attrsJSON, _ := json.Marshal(body.Attributes)
		add("attributes", attrsJSON)
	}
	if body.PriceUSD != nil {
		add("price_usd", *body.PriceUSD)
	}
	if body.Stock != nil {
		add("stock", *body.Stock)
	}
	if body.ImageURL != nil {
		add("image_url", *body.ImageURL)
	}
	if len(set) == 0 {
		kit.Fail(w, 400, "empty_update", "aucun champ à modifier fourni")
		return
	}
	args = append(args, variationID)
	tag, err := s.db.Exec(r.Context(),
		fmt.Sprintf("UPDATE product_variations SET %s WHERE id = $%d", strings.Join(set, ", "), len(args)), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "variation_not_found", fmt.Sprintf("variation %d introuvable", variationID))
		return
	}
	kit.JSON(w, 200, map[string]any{"id": variationID, "updated": true})
}

func (s *server) deleteVariation(w http.ResponseWriter, r *http.Request) {
	variationID := atoi(r.PathValue("variation_id"))
	tag, err := s.db.Exec(r.Context(), "DELETE FROM product_variations WHERE id = $1", variationID)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "variation_not_found", fmt.Sprintf("variation %d introuvable", variationID))
		return
	}
	kit.JSON(w, 200, map[string]any{"id": variationID, "deleted": true})
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
		Name        string `json:"name"`
		LogoURL     string `json:"logo_url"`
		Description string `json:"description"`
		WebsiteURL  string `json:"website_url"`
		Status      string `json:"status"`
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

// ---------- variations de pointure (chaussures) ----------

// shoeSizeAttrName — libellé de l'attribut taille pour les chaussures. Doit
// rester cohérent entre : la dérivation `attributes` renvoyée par getProduct
// (que ProductVariations.tsx lit pour afficher le sélecteur), le bouton
// "générer les pointures" de l'admin (ProductForm.tsx) et le backfill.
const shoeSizeAttrName = "Pointure"

// shoeSizeGrid — grille EU 36→46 (11 pointures), décidée le 2026-08-28.
// Valeurs en string : product_variations.attributes est un JSONB clé→string
// et le frontend compare des strings ("36" == option du bouton).
var shoeSizeGrid = []string{"36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46"}

// shoeCategoryKeywords — un produit est considéré "chaussure" si le nom de
// sa catégorie (insensible casse/accents) contient l'un de ces fragments.
// Détection par nom de catégorie (choix du 2026-08-28) plutôt que par ID
// figé : robuste au renommage, et couvre les sous-catégories futures.
var shoeCategoryKeywords = []string{
	"chaussure", "chaussures", "sandale", "sandales", "babouche", "babouches",
	"basket", "baskets", "sneaker", "sneakers", "mocassin", "mocassins",
	"botte", "bottes", "bottine", "bottines", "escarpin", "escarpins",
	"tong", "tongs", "derby", "derbies", "ballerine", "ballerines",
	"espadrille", "espadrilles", "claquette", "claquettes", "mule", "mules",
	"footwear", "shoe", "shoes", "slipper", "slippers", "boot", "boots",
}

// stripAccentsLower — minuscule + retrait des accents FR courants, pour que
// "Chaussures — Sandales" matche "sandale" quelle que soit la casse/accent.
func stripAccentsLower(s string) string {
	s = strings.ToLower(s)
	repl := strings.NewReplacer(
		"à", "a", "â", "a", "ä", "a", "á", "a",
		"é", "e", "è", "e", "ê", "e", "ë", "e",
		"î", "i", "ï", "i", "í", "i",
		"ô", "o", "ö", "o", "ó", "o",
		"û", "u", "ü", "u", "ù", "u", "ú", "u",
		"ç", "c",
	)
	return repl.Replace(s)
}

// isShoeCategoryName — vrai si le nom de catégorie désigne des chaussures.
func isShoeCategoryName(name string) bool {
	n := stripAccentsLower(name)
	for _, kw := range shoeCategoryKeywords {
		if strings.Contains(n, kw) {
			return true
		}
	}
	return false
}

// ---------- variations de taille (vêtements homme + femme) ----------

// clothingSizeAttrName — attribut "Taille" (distinct de "Pointure" pour les
// chaussures). Même valeur côté admin (ProductForm.tsx) et frontend.
const clothingSizeAttrName = "Taille"

// clothingSizeGrid — S → XXXL (6 tailles), décidé le 2026-08-28.
var clothingSizeGrid = []string{"S", "M", "L", "XL", "XXL", "XXXL"}

// clothingCategoryKeywords — vêtements homme + femme (PAS enfant : grille de
// tailles différente). Détection par nom de catégorie.
var clothingCategoryKeywords = []string{
	"vetement", "vetements", "habit", "habits", "pret-a-porter", "pret a porter",
	"homme", "femme", "boubou", "boubous", "tenue", "tenues", "ensemble", "ensembles",
	"robe", "robes", "chemise", "chemises", "chemisier", "chemisiers",
	"pantalon", "pantalons", "jupe", "jupes", "t-shirt", "tshirt", "t shirt",
	"pull", "pulls", "veste", "vestes", "blouse", "blouses", "tunique", "tuniques",
	"kaftan", "caftan", "kimono", "dashiki", "agbada", "grand boubou",
	"apparel", "clothing", "menswear", "womenswear", "dress", "shirt", "trousers",
}

// clothingCategoryExclude — fragments qui DÉSACTIVENT la détection vêtement
// même si un mot-clé ci-dessus matche : enfant (grille distincte), et les
// familles qui ne se déclinent pas en S/M/L (sacs, pagnes au mètre,
// chaussures déjà gérées en pointures, accessoires/bijoux).
var clothingCategoryExclude = []string{
	"enfant", "enfants", "bebe", "bebes", "kids", "child", "baby",
	"sac", "sacs", "maroquinerie", "pochette", "pochettes",
	"pagne", "pagnes", "tissu", "tissus", "wax", "kente", "bogolan",
	"chaussure", "chaussures", "sandale", "babouche", "basket",
	"bijou", "bijoux", "accessoire", "accessoires", "montre", "montres",
	"ceinture", "ceintures", "echarpe", "foulard", "lunette", "chapeau",
}

// isClothingCategoryName — vrai si le nom de catégorie désigne des vêtements
// homme/femme (hors exclusions).
func isClothingCategoryName(name string) bool {
	n := stripAccentsLower(name)
	for _, ex := range clothingCategoryExclude {
		if strings.Contains(n, ex) {
			return false
		}
	}
	for _, kw := range clothingCategoryKeywords {
		if strings.Contains(n, kw) {
			return true
		}
	}
	return false
}

// clothingProductNameKeywords — la base n'a qu'UNE catégorie vêtement
// ("Mode - Vêtements", vérifié 2026-08-28 : pas de sous-catégories
// Homme/Femme), et elle contient aussi des chapeaux et des produits mal
// classés (couvre-verre…). On filtre donc au niveau du NOM DU PRODUIT :
// on ne pose des tailles S→XXXL que si le nom évoque un vêtement porté.
var clothingProductNameKeywords = []string{
	"robe", "ensemble", "boubou", "kaftan", "caftan", "dashiki", "agbada",
	"chemise", "chemisier", "pantalon", "jean", "jeans", "jupe", "short",
	"t-shirt", "tshirt", "tee", "polo", "pull", "sweat", "veste", "blazer",
	"blouse", "tunique", "kimono", "combinaison", "salopette", "gilet",
	"cardigan", "manteau", "trench", "peignoir", "pyjama", "tenue", "top",
	"jogging", "survetement", "bermuda", "bomber", "hoodie", "sweatshirt",
	"deux pieces", "2 pieces", "3 pieces", "trois pieces", "abaya", "jellaba",
	"djellaba", "gandoura", "grand boubou", "complet", "costume",
}

// clothingProductNameExclude — mots qui, dans le nom, disqualifient (objets
// qui ne se portent pas / ne se déclinent pas en S/M/L).
var clothingProductNameExclude = []string{
	"chapeau", "casquette", "bonnet", "beret", "foulard", "echarpe",
	"ceinture", "cravate", "noeud papillon", "gant", "gants", "chaussette",
	"chaussettes", "collant", "collants", "sac", "pochette", "portefeuille",
	"couvre-verre", "couvre verre", "set de", "lot de", "nappe", "coussin",
	"rideau", "torchon", "serviette", "drap", "housse", "plaid",
	"bijou", "collier", "bracelet", "bague", "boucle", "montre", "lunette",
	"parfum", "huile", "creme", "savon", "beurre", "the ", "cafe",
	"tableau", "statue", "sculpture", "panier", "vase", "bougie",
	"metre", "au metre", "coupon", "tissu", "pagne", "wax", // vendus au mètre
}

// isClothingProductName — vrai si le nom du produit désigne un vêtement
// porté (à l'intérieur de la catégorie "Mode - Vêtements").
func isClothingProductName(name string) bool {
	n := stripAccentsLower(name)
	for _, ex := range clothingProductNameExclude {
		if strings.Contains(n, ex) {
			return false
		}
	}
	for _, kw := range clothingProductNameKeywords {
		if strings.Contains(n, kw) {
			return true
		}
	}
	return false
}

// variationsHaveSizeAttr — vrai si au moins une variation porte déjà un
// attribut de taille (Pointure / Taille / Size). Sert à rendre le backfill
// idempotent et à ne pas re-générer par-dessus une saisie manuelle.
func variationsHaveSizeAttr(variations []map[string]any) bool {
	for _, v := range variations {
		attrs, _ := v["attributes"].(map[string]any)
		for k := range attrs {
			switch stripAccentsLower(k) {
			case "pointure", "taille", "size", "shoe size", "pointures":
				return true
			}
		}
	}
	return false
}

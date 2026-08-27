// ============================================================
// Import ponctuel WooCommerce + Dokan → bases Postgres (phase 2).
// Ordre : vendeurs (dokan/v1/stores) → catégories (wc/v3/products/
// categories) → produits (wc/v3/products, fr puis en). Les produits sont
// importés en dernier car ils référencent vendor_id/category_id — il faut
// d'abord connaître les nouveaux id internes issus des deux imports
// précédents (résolution par wc_id, jamais par supposition d'ordre).
//
// Usage : go run ./cmd/wc-import --wc-url=... --wc-key=... --wc-secret=...
// Variables d'env attendues : DATABASE_URL_VENDOR, DATABASE_URL_CATALOG
// (mêmes DSN que les services eux-mêmes, voir .env du VPS).
//
// Après cet import, lancer cmd/migrate-images séparément pour les images
// produits (voir son propre en-tête) — ce script ne migre PAS les images,
// il se contente d'importer les métadonnées produit/vendeur en base.
//
// Protections anti-blocage SiteGround (incident du 2026-08-20 documenté
// dans le dépôt frontend — le WAF/Anti-Bot AI peut bloquer un client qui
// enchaîne trop d'appels) : un seul appel HTTP en vol à la fois (jamais de
// parallélisme sur les pages), pause entre chaque page, retry avec backoff
// exponentiel sur erreur réseau/5xx, mais JAMAIS sur 401/403 (un blocage
// d'auth ne doit jamais être retenté en boucle — ça ressemble à une
// attaque et aggraverait un éventuel verrou déjà actif).
// ============================================================
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/miadmarket/miad-backend/internal/kit"
)

const (
	pageDelay  = 1500 * time.Millisecond // pause entre chaque page — jamais de rafale
	maxRetries = 4
)

var httpClient = &http.Client{Timeout: 30 * time.Second}

// fetchJSONPaginated récupère une page (déjà décodée dans out, qui doit
// être un pointeur vers slice) avec retry/backoff — jamais sur 401/403.
// Impose une pause après l'appel, réussi ou non, pour ne jamais enchaîner
// deux requêtes sans délai même en cas de retry.
func fetchJSONPaginated(url string, out any) error {
	defer time.Sleep(pageDelay)

	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(attempt*attempt) * time.Second
			time.Sleep(backoff)
		}

		req, err := http.NewRequest(http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", "MIAD-Go-Migration-Import")
		req.Header.Set("Accept", "application/json")

		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}

		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			resp.Body.Close()
			return fmt.Errorf("authentification refusée (%d) — vérifier les clés ou un verrou anti-bot actif, ne pas relancer immédiatement", resp.StatusCode)
		}
		if resp.StatusCode >= 500 {
			resp.Body.Close()
			lastErr = fmt.Errorf("erreur serveur %d", resp.StatusCode)
			continue
		}
		if resp.StatusCode != 200 {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			return fmt.Errorf("statut inattendu %d: %s", resp.StatusCode, string(body))
		}

		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}

		// Vérifie que c'est bien du JSON exploitable — une réponse HTML
		// (page d'erreur WAF) casserait silencieusement l'import sans ce
		// contrôle explicite.
		if err := json.Unmarshal(body, out); err != nil {
			lastErr = fmt.Errorf("réponse non-JSON (probable blocage WAF/HTML) : %w", err)
			continue
		}
		return nil
	}
	return fmt.Errorf("échec après %d tentatives: %w", maxRetries, lastErr)
}

var (
	wcURL    = flag.String("wc-url", "", "https://api.miadmarket.com")
	wcKey    = flag.String("wc-key", "", "ck_…")
	wcSecret = flag.String("wc-secret", "", "cs_…")
)

type dokanStore struct {
	ID       int64  `json:"id"`
	Name     string `json:"store_name"`
	ShopURL  string `json:"shop_url"`
	Gravatar string `json:"gravatar"`
	Banner   string `json:"banner"`
	Address  dokanAddress `json:"address"`
	Phone    string       `json:"phone"`
	Email    string       `json:"email"`
}

type dokanAddress struct {
	Country string
	City    string
}

// UnmarshalJSON — Dokan/PHP sérialise un tableau associatif vide en JSON
// comme "[]" (tableau) au lieu de "{}" (objet), ce que fait PHP dès qu'un
// vendeur n'a renseigné aucun champ d'adresse. Sans ce cas géré
// explicitement, tout l'import échouait dès le premier vendeur sans
// adresse — confirmé en migration réelle le 2026-08-24.
func (a *dokanAddress) UnmarshalJSON(data []byte) error {
	if string(data) == "[]" || string(data) == "null" {
		*a = dokanAddress{}
		return nil
	}
	type alias dokanAddress
	var v alias
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	*a = dokanAddress(v)
	return nil
}

type wcCategory struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Slug   string `json:"slug"`
	Parent int64  `json:"parent"`
	Image  struct {
		Src string `json:"src"`
	} `json:"image"`
}

type wcProduct struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
	// "type" distingue simple/variable — jamais lu avant le 2026-08-27
	// (absent de l'ancien _fields), ce qui faisait atterrir TOUT produit
	// WooCommerce variable comme un produit simple côté catalog-svc
	// (is_variable toujours FALSE par défaut, aucune ligne
	// product_variations créée).
	Type        string `json:"type"`
	Description string `json:"description"`
	Price       string `json:"price"`
	Status      string `json:"status"`
	// Stock — jamais lu avant le 2026-08-27 : l'INSERT produit n'avait
	// aucune colonne stock du tout, laissant products.stock à son défaut
	// SQL (0) pour CHAQUE import — confirmé en base après migration réelle
	// (min/max/avg tous à ~50, 7 valeurs distinctes sur 1728 produits :
	// ce ne sont pas les vraies quantités WooCommerce, mais des données de
	// seed/placeholder posées avant que catalog-svc n'existe). StockQty est
	// nil quand manage_stock=false côté WooCommerce (stock non géré par
	// quantité) — dans ce cas c'est stock_status seul qui fait foi, jamais
	// une quantité à défaut de 0 (voir resolveStock).
	StockQty     *int   `json:"stock_quantity"`
	StockStatus  string `json:"stock_status"` // "instock" | "outofstock" | "onbackorder"
	ManageStock  bool   `json:"manage_stock"`
	Backorders   string `json:"backorders"` // "no" | "notify" | "yes"
	// DateCreated (ISO 8601, ex "2025-03-12T10:04:00") — jamais lu avant
	// le 2026-08-27, products.created_at retombait donc systématiquement
	// sur son défaut SQL (now(), au moment de l'import), perdant la vraie
	// date de création du produit côté WooCommerce.
	DateCreated string `json:"date_created"`
	// "author" (post_author WordPress) n'existe pas du tout dans le
	// schéma REST wc/v3/products, avec ou sans plugin Dokan — confirmé en
	// migration réelle le 2026-08-24 (absent même en le demandant
	// explicitement via _fields). Le vendeur est en réalité exposé par
	// Dokan sous product.store.id (même id que dokan/v1/stores[].id) —
	// c'est ce champ qu'il faut lire, pas "author".
	Store struct {
		ID int64 `json:"id"`
	} `json:"store"`
	Categories []struct {
		ID int64 `json:"id"`
	} `json:"categories"`
	Images []struct {
		Src string `json:"src"`
	} `json:"images"`
	MetaData []struct {
		Key   string `json:"key"`
		Value any    `json:"value"`
	} `json:"meta_data"`
	// IDs des variations enfants (WooCommerce ne les développe jamais
	// inline sur /products — un appel séparé par produit est nécessaire,
	// voir fetchVariations) — vide pour un produit simple.
	Variations []int64 `json:"variations"`
}

// wcVariation — une ligne wc/v3/products/{id}/variations. Les attributs
// (couleur, taille…) arrivent en liste plate WooCommerce ; reconstruits en
// map {nom: valeur} pour coller au schéma product_variations.attributes
// (JSONB) de catalog-svc.
type wcVariation struct {
	ID          int64  `json:"id"`
	SKU         string `json:"sku"`
	Price       string `json:"price"`
	StockQty    *int   `json:"stock_quantity"`
	StockStatus string `json:"stock_status"`
	Attributes []struct {
		Name   string `json:"name"`
		Option string `json:"option"`
	} `json:"attributes"`
	Image struct {
		Src string `json:"src"`
	} `json:"image"`
}

func main() {
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	if *wcURL == "" || *wcKey == "" || *wcSecret == "" {
		log.Error("flags --wc-url, --wc-key et --wc-secret obligatoires")
		os.Exit(1)
	}
	ctx := context.Background()

	vendorDB, err := kit.NewPG(ctx, log, os.Getenv("DATABASE_URL_VENDOR"))
	if err != nil {
		log.Error("vendor db", "err", err)
		os.Exit(1)
	}
	defer vendorDB.Close()

	catalog, err := kit.NewPG(ctx, log, os.Getenv("DATABASE_URL_CATALOG"))
	if err != nil {
		log.Error("catalog db", "err", err)
		os.Exit(1)
	}
	defer catalog.Close()

	// ---------- 1. Vendeurs (dokan/v1/stores) ----------
	log.Info("import des vendeurs…")
	wcIDToVendorID := map[int64]int64{}
	stores, err := fetchStores()
	if err != nil {
		log.Error("lecture dokan/v1/stores", "err", err)
		os.Exit(1)
	}
	for _, s := range stores {
		if s.Name == "" {
			continue // compte vendeur jamais finalisé — cohérent avec le filtre déjà en place côté vendor-svc/listStores
		}
		var vendorID int64
		err := vendorDB.QueryRow(ctx, `
			INSERT INTO vendors (wc_store_id, name, slug, logo_url, banner_url, country, city, phone, email, verified)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
			ON CONFLICT (wc_store_id) DO UPDATE SET
				name=excluded.name, slug=excluded.slug, logo_url=excluded.logo_url,
				banner_url=excluded.banner_url, country=excluded.country, city=excluded.city,
				phone=excluded.phone, email=excluded.email, verified=excluded.verified
			RETURNING id`,
			// s.Enabled toujours false : dokan/v1/stores ne renvoie pas de
			// champ "enabled" (confirmé par un dump réel de l'API — seuls
			// trusted/featured/toc_enabled existent). Ces boutiques sont de
			// vrais vendeurs déjà actifs sur l'ancien site, donc considérées
			// vérifiées par défaut plutôt que de reproduire ce faux "false".
			s.ID, s.Name, slugFromShopURL(s.ShopURL, s.ID), s.Gravatar, s.Banner,
			s.Address.Country, s.Address.City, s.Phone, s.Email, true,
		).Scan(&vendorID)
		if err != nil {
			log.Error("insert vendeur", "wc_store_id", s.ID, "err", err)
			continue
		}
		wcIDToVendorID[s.ID] = vendorID
	}
	log.Info("vendeurs importés", "n", len(wcIDToVendorID))

	// ---------- 2. Catégories (wc/v3/products/categories, fr + en) ----------
	log.Info("import des catégories…")
	wcCatIDToCatalogID := map[string]int64{} // clé "lang:wc_id" -> id interne
	for _, lang := range []string{"fr", "en"} {
		cats, err := fetchCategories(lang)
		if err != nil {
			log.Error("lecture categories", "lang", lang, "err", err)
			continue
		}
		trids := map[int64]string{} // wc_id (langue neutre WPML) -> trid partagé
		for _, c := range cats {
			trid := fmt.Sprintf("wc-cat-%d", c.ID)
			var catID int64
			err := catalog.QueryRow(ctx, `
				INSERT INTO categories (wc_id, trid, lang, parent_id, name, slug, image_url)
				VALUES ($1,$2,$3,$4,$5,$6,$7)
				ON CONFLICT (wc_id, lang) DO UPDATE SET
					name=excluded.name, slug=excluded.slug, image_url=excluded.image_url
				RETURNING id`,
				c.ID, trid, lang, c.Parent, c.Name, c.Slug, c.Image.Src,
			).Scan(&catID)
			if err != nil {
				log.Error("insert catégorie", "wc_id", c.ID, "lang", lang, "err", err)
				continue
			}
			wcCatIDToCatalogID[fmt.Sprintf("%s:%d", lang, c.ID)] = catID
			trids[c.ID] = trid
		}
		log.Info("catégories importées", "lang", lang, "n", len(cats))
	}

	// ---------- 3. Produits (fr + en), avec vendor_id/category_id résolus ----------
	unresolvedVendor := 0
	for _, lang := range []string{"fr", "en"} {
		page := 1
		for {
			prods, err := fetchProducts(page, lang)
			if err != nil {
				log.Error("lecture WooCommerce", "lang", lang, "page", page, "err", err)
				os.Exit(1)
			}
			for _, p := range prods {
				trid := extractTrid(p)
				imagesJSON, _ := json.Marshal(imageURLs(p.Images))
				// catalog-svc filtre sur status='active' (voir listProducts) —
				// les statuts WooCommerce (publish/draft/pending/private) ne
				// matchent jamais ça telsquels, ce qui rendait TOUT le
				// catalogue importé invisible malgré un import "réussi".
				status := "inactive"
				if p.Status == "publish" {
					status = "active"
				}

				var vendorID int64
				if p.Store.ID != 0 {
					vendorID = wcIDToVendorID[p.Store.ID]
				}
				if vendorID == 0 {
					unresolvedVendor++
				}

				var categoryID int64
				if len(p.Categories) > 0 {
					categoryID = wcCatIDToCatalogID[fmt.Sprintf("%s:%d", lang, p.Categories[0].ID)]
				}

				isVariable := p.Type == "variable"
				stock, backordersAllowed := resolveStock(p.ManageStock, p.StockQty, p.StockStatus, p.Backorders)

				var productID int64
				err := catalog.QueryRow(ctx, `
					INSERT INTO products (wc_id, trid, lang, vendor_id, category_id, name, slug, description, price_usd, images, status, is_variable, stock, backorders_allowed, created_at)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
					ON CONFLICT (wc_id, lang) DO UPDATE SET
						vendor_id=excluded.vendor_id, category_id=excluded.category_id,
						name=excluded.name, slug=excluded.slug, description=excluded.description,
						price_usd=excluded.price_usd, images=excluded.images, status=excluded.status,
						is_variable=excluded.is_variable, stock=excluded.stock,
						backorders_allowed=excluded.backorders_allowed, created_at=excluded.created_at
					RETURNING id`,
					p.ID, trid, lang, vendorID, categoryID, p.Name, p.Slug, p.Description,
					parsePrice(p.Price), imagesJSON, status, isVariable, stock, backordersAllowed,
					parseWCDate(p.DateCreated)).Scan(&productID)
				if err != nil {
					log.Error("insert produit", "id", p.ID, "err", err)
					continue
				}

				// Toujours interroger l'endpoint dédié pour un produit variable,
				// sans se fier à p.Variations (liste d'IDs renvoyée par
				// /products) : ce champ s'est révélé vide/absent pour environ
				// un tiers des vrais produits variables lors de la migration
				// réelle du 2026-08-27 (202 produits marqués is_variable=true
				// mais 0 ligne product_variations), alors que l'endpoint
				// wc/v3/products/{id}/variations renvoyait bien des données.
				if isVariable {
					variations, vErr := fetchVariations(p.ID, lang)
					if vErr != nil {
						log.Error("lecture variations", "product_id", p.ID, "err", vErr)
					} else {
						// Le script est relançable (ON CONFLICT sur products
						// ci-dessus) — sans ce DELETE, relancer l'import sur
						// un produit déjà importé dupliquerait ses variations
						// à chaque passage (product_variations n'a pas de
						// contrainte d'unicité par wc_id, WooCommerce n'en
						// fournit pas de stable côté schéma catalog-svc).
						if _, dErr := catalog.Exec(ctx, `DELETE FROM product_variations WHERE product_id=$1`, productID); dErr != nil {
							log.Error("purge anciennes variations", "product_id", p.ID, "err", dErr)
						}
						for _, v := range variations {
							attrs := map[string]string{}
							for _, a := range v.Attributes {
								attrs[a.Name] = a.Option
							}
							attrsJSON, _ := json.Marshal(attrs)
							// Une variation n'expose pas manage_stock/backorders
							// dans l'API (hérités du produit parent) — StockQty
							// non-nil est le seul signal fiable qu'elle gère sa
							// propre quantité, voir resolveStock.
							stock, _ := resolveStock(v.StockQty != nil, v.StockQty, v.StockStatus, "")
							_, vErr := catalog.Exec(ctx, `
								INSERT INTO product_variations (product_id, sku, attributes, price_usd, stock, image_url)
								VALUES ($1,$2,$3,$4,$5,$6)`,
								productID, v.SKU, attrsJSON, parsePrice(v.Price), stock, v.Image.Src)
							if vErr != nil {
								log.Error("insert variation", "product_id", p.ID, "variation_id", v.ID, "err", vErr)
							}
						}
					}
				}
			}
			log.Info("page importée", "lang", lang, "page", page, "n", len(prods))
			if len(prods) < 100 { // WooCommerce per_page=100 → page courte = fin
				break
			}
			page++
		}
	}
	if unresolvedVendor > 0 {
		log.Error(fmt.Sprintf("ATTENTION : %d produits sans vendor_id résolu (champ 'store' absent de la réponse WooCommerce, ou vendeur non trouvé dans dokan/v1/stores) — vérifier manuellement ces produits en base (vendor_id=0)", unresolvedVendor))
	}

	// TODO(phase 2, suite) : wc/v3/orders → miad_order, avec les mêmes
	// garanties d'erreurs explicites. Pas encore fait : le modèle de
	// commande a changé (éclatement par vendeur côté order-svc, format
	// totalement différent de wc/v3/orders) — nécessite un vrai mapping,
	// pas une copie directe comme products/categories/vendors ci-dessus.
	log.Info("import terminé", "produits_vendor_non_resolu", unresolvedVendor)
}

func fetchStores() ([]dokanStore, error) {
	var all []dokanStore
	page := 1
	for {
		url := fmt.Sprintf("%s/wp-json/dokan/v1/stores?per_page=100&page=%d&consumer_key=%s&consumer_secret=%s",
			*wcURL, page, *wcKey, *wcSecret)
		var batch []dokanStore
		if err := fetchJSONPaginated(url, &batch); err != nil {
			return nil, fmt.Errorf("page %d: %w", page, err)
		}
		all = append(all, batch...)
		if len(batch) < 100 {
			break
		}
		page++
	}
	return all, nil
}

func fetchCategories(lang string) ([]wcCategory, error) {
	url := fmt.Sprintf("%s/wp-json/wc/v3/products/categories?per_page=100&lang=%s&consumer_key=%s&consumer_secret=%s",
		*wcURL, lang, *wcKey, *wcSecret)
	var out []wcCategory
	return out, fetchJSONPaginated(url, &out)
}

func fetchProducts(page int, lang string) ([]wcProduct, error) {
	// _fields limite la réponse aux champs réellement utilisés (store.id
	// est le champ Dokan qui porte le vendeur — voir wcProduct.Store).
	// type/date_created/variations ajoutés le 2026-08-27 — absents avant,
	// ce qui perdait silencieusement le statut variable, la date réelle de
	// création, et la liste des variations de chaque produit.
	// stock_quantity/stock_status/manage_stock/backorders ajoutés le
	// 2026-08-27 également — absents avant, products.stock retombait donc
	// systématiquement sur son défaut SQL à l'INSERT (0, ou une valeur de
	// seed antérieure jamais écrasée), sans distinction rupture/
	// réapprovisionnement/stock non géré (voir doc-comment wcProduct).
	url := fmt.Sprintf("%s/wp-json/wc/v3/products?per_page=100&page=%d&lang=%s&consumer_key=%s&consumer_secret=%s"+
		"&_fields=id,name,slug,description,price,status,type,date_created,store,categories,images,meta_data,variations,"+
		"stock_quantity,stock_status,manage_stock,backorders",
		*wcURL, page, lang, *wcKey, *wcSecret)
	var out []wcProduct
	return out, fetchJSONPaginated(url, &out)
}

// fetchVariations — un produit "variable" ne développe jamais ses
// variations inline sur /products (juste leurs IDs, voir wcProduct.
// Variations) : un appel dédié par produit est nécessaire. lang est
// nécessaire pour rester cohérent avec la paire WPML du produit parent
// (une variation peut avoir un nom/attributs traduits différemment).
// fetchVariations — contrairement aux produits (une ligne par langue), les
// variations WPML sont marquées lang="all" (neutres, jamais dupliquées) :
// passer lang=fr/en (ou omettre lang) renvoie systématiquement une liste
// VIDE, sans erreur, pour tout produit variable dont les variations passent
// par WPML — confirmé le 2026-08-27 en interrogeant l'API directement
// (202 produits sur 613 étaient dans ce cas après le premier re-import).
// lang=all est le seul paramètre qui fonctionne pour cet endpoint précis ;
// le paramètre lang reçu ici n'est donc plus utilisé, conservé uniquement
// pour ne pas changer la signature de l'appelant.
func fetchVariations(productID int64, _ string) ([]wcVariation, error) {
	url := fmt.Sprintf("%s/wp-json/wc/v3/products/%d/variations?per_page=100&lang=all&consumer_key=%s&consumer_secret=%s"+
		"&_fields=id,sku,price,stock_quantity,stock_status,attributes,image",
		*wcURL, productID, *wcKey, *wcSecret)
	var out []wcVariation
	return out, fetchJSONPaginated(url, &out)
}

// parseWCDate — WooCommerce renvoie "2025-03-12T10:04:00" (heure locale du
// site, sans fuseau) sur date_created ; time.Now() en repli si le format
// est inattendu ou le champ vide, plutôt que de faire échouer tout l'import
// pour une date manquante sur un seul produit.
func parseWCDate(s string) time.Time {
	if s == "" {
		return time.Now()
	}
	t, err := time.Parse("2006-01-02T15:04:05", s)
	if err != nil {
		return time.Now()
	}
	return t
}

func extractTrid(p wcProduct) string {
	for _, m := range p.MetaData {
		if m.Key == "wpml_trid" {
			return fmt.Sprintf("%v", m.Value)
		}
	}
	return fmt.Sprintf("wc-%d", p.ID) // produit sans traduction : trid propre
}

func imageURLs(images []struct {
	Src string `json:"src"`
}) []string {
	out := make([]string, 0, len(images))
	for _, img := range images {
		if img.Src != "" {
			out = append(out, img.Src)
		}
	}
	return out
}

// slugFromShopURL — dokan/v1/stores ne renvoie pas de slug dédié, juste
// une URL de boutique complète (ex: https://.../store/nom-boutique) dont
// le dernier segment sert de slug — même logique que l'ancien frontend
// (mapStore côté woo-server.ts avant migration).
func slugFromShopURL(shopURL string, fallbackID int64) string {
	shopURL = strings.TrimRight(shopURL, "/")
	for i := len(shopURL) - 1; i >= 0; i-- {
		if shopURL[i] == '/' {
			return shopURL[i+1:]
		}
	}
	if shopURL != "" {
		return shopURL
	}
	return fmt.Sprintf("vendor-%d", fallbackID)
}

// parsePrice — le catalogue WooCommerce source stocke _price en USD réel,
// PAS en FCFA (confirmé dans le CLAUDE.md du frontend v0-miad-front-end,
// vérifié sur des produits réels : ex. price="16", price="37.78" — jamais
// des montants à l'échelle FCFA). products.price_usd (catalog-svc) est
// désormais elle aussi en USD réel : aucune conversion à faire, copie
// directe. Si le catalogue source venait un jour à stocker une autre
// devise, la conversion devrait se faire ICI, explicitement — jamais en
// silence dans un service en aval.
func parsePrice(s string) float64 {
	var usd float64
	_, _ = fmt.Sscanf(s, "%f", &usd)
	return usd
}

// resolveStock — traduit le modèle de stock WooCommerce (quantité gérée OU
// statut seul) vers (stock int, backordersAllowed bool) attendu par
// catalog-svc. WooCommerce a DEUX régimes distincts, pas un seul :
//  1. manage_stock=true : stock_quantity fait foi (nombre d'unités réel).
//  2. manage_stock=false : le vendeur ne suit pas de quantité, seul
//     stock_status compte ("instock"/"outofstock"/"onbackorder") —
//     stock_quantity est alors nil et NE DOIT JAMAIS être traité comme 0
//     (un produit "instock" sans quantité gérée n'est pas en rupture).
//
// "onbackorder" et backorders="yes"/"notify" indiquent tous deux qu'une
// commande reste possible malgré stock_quantity=0 — backordersAllowed=true
// dans ce cas, pour que catalog-svc n'affiche pas "rupture" à tort (voir
// bug signalé le 2026-08-27 : aucune des deux infos n'était importée avant,
// products.stock retombait sur son défaut SQL/une valeur de seed pour
// chaque produit, sans distinction rupture/réapprovisionnement/non géré).
func resolveStock(manageStock bool, stockQty *int, stockStatus, backorders string) (stock int, backordersAllowed bool) {
	backordersAllowed = stockStatus == "onbackorder" || backorders == "yes" || backorders == "notify"
	if manageStock && stockQty != nil {
		return *stockQty, backordersAllowed
	}
	// Stock non géré par quantité : dérive une valeur symbolique du statut
	// seul plutôt que de laisser 0 par défaut (rupture à tort pour tout
	// produit "instock" sans quantité suivie — le cas le plus fréquent sur
	// des boutiques artisanales qui ne comptent pas leurs pièces une à une).
	if stockStatus == "instock" || stockStatus == "" {
		return 1, backordersAllowed
	}
	return 0, backordersAllowed
}

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
	Enabled  bool   `json:"enabled"`
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
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	Description string `json:"description"`
	Price       string `json:"price"`
	Status      string `json:"status"`
	// author n'est PAS renvoyé par défaut dans wc/v3/products — il faut
	// explicitement le demander via _fields (voir fetchProducts). Sans
	// plugin Dokan actif ce champ peut être absent ; dans ce cas
	// vendor_id reste 0 et le produit est signalé plutôt qu'assigné au
	// hasard, pour ne jamais associer silencieusement un produit au
	// mauvais vendeur.
	Author     int64 `json:"author"`
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
			s.ID, s.Name, slugFromShopURL(s.ShopURL, s.ID), s.Gravatar, s.Banner,
			s.Address.Country, s.Address.City, s.Phone, s.Email, s.Enabled,
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

				var vendorID int64
				if p.Author != 0 {
					vendorID = wcIDToVendorID[p.Author]
				}
				if vendorID == 0 {
					unresolvedVendor++
				}

				var categoryID int64
				if len(p.Categories) > 0 {
					categoryID = wcCatIDToCatalogID[fmt.Sprintf("%s:%d", lang, p.Categories[0].ID)]
				}

				_, err := catalog.Exec(ctx, `
					INSERT INTO products (wc_id, trid, lang, vendor_id, category_id, name, slug, description, price_usd, images, status)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
					ON CONFLICT (wc_id, lang) DO UPDATE SET
						vendor_id=excluded.vendor_id, category_id=excluded.category_id,
						name=excluded.name, slug=excluded.slug, description=excluded.description,
						price_usd=excluded.price_usd, images=excluded.images, status=excluded.status`,
					p.ID, trid, lang, vendorID, categoryID, p.Name, p.Slug, p.Description,
					parsePrice(p.Price), imagesJSON, p.Status)
				if err != nil {
					log.Error("insert produit", "id", p.ID, "err", err)
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
		log.Error(fmt.Sprintf("ATTENTION : %d produits sans vendor_id résolu (champ 'author' absent de la réponse WooCommerce, ou vendeur non trouvé dans dokan/v1/stores) — vérifier manuellement ces produits en base (vendor_id=0)", unresolvedVendor))
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
	// _fields force explicitement l'inclusion de "author" — absent par
	// défaut de la réponse standard wc/v3/products.
	url := fmt.Sprintf("%s/wp-json/wc/v3/products?per_page=100&page=%d&lang=%s&consumer_key=%s&consumer_secret=%s"+
		"&_fields=id,name,slug,description,price,status,author,categories,images,meta_data",
		*wcURL, page, lang, *wcKey, *wcSecret)
	var out []wcProduct
	return out, fetchJSONPaginated(url, &out)
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
	for i := len(shopURL) - 1; i >= 0; i-- {
		if shopURL[i] == '/' {
			if i == len(shopURL)-1 {
				continue // URL finissant par "/" — continuer à chercher le vrai dernier segment
			}
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

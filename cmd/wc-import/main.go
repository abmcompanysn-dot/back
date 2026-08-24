// ============================================================
// Import ponctuel WooCommerce + Dokan → bases Postgres (phase 2).
// Réutilise la même logique de lecture que lib/woo-server.ts :
//   wc/v3/products?lang=fr|en   (trid via meta wpml_trid)
//   dokan/v1/stores
//   wc/v3/orders
// Usage : make import WC_URL=... WC_KEY=... WC_SECRET=...
// ============================================================
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"

	"github.com/miadmarket/miad-backend/internal/kit"
)

var (
	wcURL    = flag.String("wc-url", "", "https://api.miadmarket.ca")
	wcKey    = flag.String("wc-key", "", "ck_…")
	wcSecret = flag.String("wc-secret", "", "cs_…")
)

type wcProduct struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	Description string `json:"description"`
	Price       string `json:"price"`
	Status      string `json:"status"`
	Categories  []struct {
		ID int64 `json:"id"`
	} `json:"categories"`
	MetaData []struct {
		Key   string `json:"key"`
		Value any    `json:"value"`
	} `json:"meta_data"`
}

func main() {
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	if *wcURL == "" || *wcKey == "" {
		log.Error("flags --wc-url et --wc-key obligatoires")
		os.Exit(1)
	}
	ctx := context.Background()

	catalog, err := kit.NewPG(ctx, log, os.Getenv("DATABASE_URL_CATALOG"))
	if err != nil {
		log.Error("catalog db", "err", err)
		os.Exit(1)
	}
	defer catalog.Close()

	shippingURL := kit.Env("SHIPPING_SVC_URL", "http://shipping-svc:8085")
	usdToXof, err := fetchUSDToXOFRate(shippingURL)
	if err != nil {
		log.Error("taux de change indisponible — import stoppé pour éviter des prix faux", "err", err)
		os.Exit(1)
	}
	log.Info("taux de change USD->XOF lu depuis shipping-svc", "rate", usdToXof)
	parsePriceXOF := parsePrice(usdToXof)

	// Pour chaque langue : la même requête que le frontend actuel.
	// WPML renvoie les lignes de la langue demandée ; le trid
	// (meta wpml_trid) relie les paires — copié tel quel, sans
	// transformation (contrainte section 4 du brief).
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
				_, err := catalog.Exec(ctx, `
					INSERT INTO products (wc_id, trid, lang, name, slug, description, price_xof, status)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
					ON CONFLICT (wc_id, lang) DO UPDATE SET
						name=excluded.name, slug=excluded.slug,
						description=excluded.description, price_xof=excluded.price_xof`,
					p.ID, trid, lang, p.Name, p.Slug, p.Description, parsePriceXOF(p.Price), p.Status)
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
	// TODO(phase 2, suite) : mêmes boucles pour dokan/v1/stores → miad_vendor
	// et wc/v3/orders → miad_order, avec les mêmes garanties d'erreurs explicites.
	log.Info("import terminé")
}

func fetchProducts(page int, lang string) ([]wcProduct, error) {
	url := fmt.Sprintf("%s/wp-json/wc/v3/products?per_page=100&page=%d&lang=%s&consumer_key=%s&consumer_secret=%s",
		*wcURL, page, lang, *wcKey, *wcSecret)
	res, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d — échec EXPLICITE, on n'avance pas à l'aveugle", res.StatusCode)
	}
	var out []wcProduct
	return out, json.NewDecoder(res.Body).Decode(&out)
}

func extractTrid(p wcProduct) string {
	for _, m := range p.MetaData {
		if m.Key == "wpml_trid" {
			return fmt.Sprintf("%v", m.Value)
		}
	}
	return fmt.Sprintf("wc-%d", p.ID) // produit sans traduction : trid propre
}

// parsePrice — ATTENTION : le catalogue WooCommerce source stocke _price
// en USD réel, PAS en FCFA (confirmé dans le CLAUDE.md du frontend v0-miad-front-end,
// vérifié sur des produits réels : ex. price="16", price="37.78" — jamais
// des montants à l'échelle FCFA). Mais products.price_xof (catalog-svc)
// est nommée et traitée comme du FCFA partout dans ce service (colonne
// "price_xof", champ JSON "currency":"XOF"). Convertit au taux XOF lu
// depuis shipping-svc /exchange-rates (source UNIQUE, voir shipping-svc/
// main.go) — jamais une constante locale, pour ne pas réintroduire la
// duplication de taux que ce projet doit justement éliminer.
func parsePrice(usdToXof float64) func(s string) int64 {
	return func(s string) int64 {
		var usd float64
		_, _ = fmt.Sscanf(s, "%f", &usd)
		return int64(usd * usdToXof)
	}
}

// fetchUSDToXOFRate — interroge shipping-svc, seul détenteur du taux.
// Échec EXPLICITE : jamais de repli silencieux sur une valeur locale
// qui pourrait diverger de la table exchange_rates.
func fetchUSDToXOFRate(shippingURL string) (float64, error) {
	resp, err := http.Get(shippingURL + "/exchange-rates")
	if err != nil {
		return 0, fmt.Errorf("shipping-svc injoignable pour lire le taux XOF: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("shipping-svc a répondu %d sur /exchange-rates", resp.StatusCode)
	}
	var body struct {
		Rates []struct {
			Currency   string  `json:"currency"`
			RatePerUSD float64 `json:"rate_per_usd"`
		} `json:"rates"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0, fmt.Errorf("réponse /exchange-rates illisible: %w", err)
	}
	for _, r := range body.Rates {
		if r.Currency == "XOF" {
			return r.RatePerUSD, nil
		}
	}
	return 0, fmt.Errorf("taux XOF absent de /exchange-rates — le seeder shipping-svc n'a pas tourné")
}

var _ = base64.StdEncoding // réservé auth Basic si les clés query sont refusées

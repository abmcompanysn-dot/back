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
	wcURL    = flag.String("wc-url", "", "https://api.miadmarket.com")
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
					p.ID, trid, lang, p.Name, p.Slug, p.Description, parsePrice(p.Price), p.Status)
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

func parsePrice(s string) int64 {
	var f float64
	_, _ = fmt.Sscanf(s, "%f", &f)
	return int64(f) // prix XOF entiers
}

var _ = base64.StdEncoding // réservé auth Basic si les clés query sont refusées

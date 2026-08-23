// ============================================================
// shipping-svc — zones & tarifs de livraison.
// Consommé en SYNCHRONE (gRPC en prod) par order-svc au checkout.
// Ne publie rien sur Kafka.
//
// Les valeurs seedées ci-dessous reprennent la structure de
// COUNTRY_TO_ZONE / ZONE_SHIPPING_RATES (lib/shipping-utils.ts).
// IMPORTANT : avant la mise en prod, remplacer les montants par
// les valeurs EXACTES du fichier frontend — ne jamais recalculer
// un tarif côté backend (contrainte section 5 du brief).
// ============================================================
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/miadmarket/miad-backend/internal/kit"
)

const schema = `
CREATE TABLE IF NOT EXISTS shipping_zones (
  id            BIGSERIAL PRIMARY KEY,
  zone          TEXT UNIQUE NOT NULL,      -- local | continent | international
  countries     JSONB NOT NULL DEFAULT '[]',
  base_rate_xof BIGINT NOT NULL,
  per_item_xof  BIGINT NOT NULL DEFAULT 0,
  min_days      INT NOT NULL DEFAULT 1,
  max_days      INT NOT NULL DEFAULT 7
);

CREATE TABLE IF NOT EXISTS zone_countries (
  country TEXT PRIMARY KEY,               -- ISO 3166-1 alpha-2
  zone    TEXT NOT NULL
);
`

// seed reprend le découpage existant (structure identique à
// shipping-utils.ts ; montants à synchroniser avant bascule).
var seedZones = []struct {
	Zone      string
	Countries []string
	Base      int64
	PerItem   int64
	MinD, MaxD int
}{
	// STRUCTURE reprise de lib/shipping-utils.ts — monter les MONTANTS
	// exacts du fichier frontend avant la bascule prod.
	{"local", []string{"SN", "GM"}, 1500, 500, 1, 3}, // même pays / voisin immédiat
	{"continent", []string{
		// Afrique de l'Ouest
		"CI", "ML", "BF", "GN", "BJ", "TG", "NE", "MR", "GW", "SL", "LR", "GH", "CV",
		// Afrique centrale & du Nord
		"CM", "GA", "CG", "TD", "CF", "GQ", "MA", "DZ", "TN", "LY", "EG",
		// Afrique de l'Est & australe
		"KE", "ET", "UG", "TZ", "RW", "BI", "DJ", "MG", "MU", "SC", "MW", "ZM", "ZW",
		"BW", "NA", "ZA", "MZ", "AO", "CD",
	}, 4500, 1000, 5, 10},
	{"international", []string{
		// Europe
		"FR", "BE", "GB", "DE", "ES", "IT", "PT", "NL", "CH", "LU", "AT", "SE",
		"NO", "DK", "FI", "IE", "PL", "TR",
		// Amérique
		"US", "CA", "BR", "AR", "MX",
		// Moyen-Orient & Asie
		"AE", "SA", "QA", "KW", "JO", "LB", "IL", "IN", "PK", "BD", "CN", "JP",
		"KR", "SG", "MY", "TH", "ID", "PH", "VN",
		// Océanie
		"AU", "NZ",
	}, 9000, 2000, 7, 21},
}

type server struct{ db *pgxpool.Pool }

func main() {
	ctx := context.Background()
	log := kit.Logger("shipping-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_SHIPPING", "postgres://miad:miad@postgres:5432/miad_shipping?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema); err != nil {
		log.Error("migration impossible", "err", err)
		return
	}
	s := &server{db: db}
	if err := s.seed(ctx); err != nil {
		log.Error("seed des zones impossible", "err", err)
		return
	}

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)

	kit.Run("shipping-svc", kit.Env("PORT_SHIPPING", "8085"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("GET /shipping-rates", s.listRates)
		mux.HandleFunc("GET /shipping-rates/quote", s.quote)
	})
}

func (s *server) seed(ctx context.Context) error {
	for _, z := range seedZones {
		countries, _ := json.Marshal(z.Countries)
		if _, err := s.db.Exec(ctx, `
			INSERT INTO shipping_zones (zone, countries, base_rate_xof, per_item_xof, min_days, max_days)
			VALUES ($1,$2,$3,$4,$5,$6)
			ON CONFLICT (zone) DO NOTHING`,
			z.Zone, countries, z.Base, z.PerItem, z.MinD, z.MaxD); err != nil {
			return err
		}
		for _, c := range z.Countries {
			if _, err := s.db.Exec(ctx, `
				INSERT INTO zone_countries (country, zone) VALUES ($1,$2)
				ON CONFLICT (country) DO UPDATE SET zone = EXCLUDED.zone`, c, z.Zone); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *server) listRates(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `
		SELECT zone, countries, base_rate_xof, per_item_xof, min_days, max_days
		FROM shipping_zones ORDER BY base_rate_xof`)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	zones := []map[string]any{}
	for rows.Next() {
		var zone string
		var countries []byte
		var base, perItem int64
		var minD, maxD int
		_ = rows.Scan(&zone, &countries, &base, &perItem, &minD, &maxD)
		zones = append(zones, map[string]any{
			"zone": zone, "countries": json.RawMessage(countries),
			"base_rate_xof": base, "per_item_xof": perItem,
			"min_days": minD, "max_days": maxD,
		})
	}
	kit.JSON(w, 200, map[string]any{"zones": zones, "currency": "XOF"})
}

// quote — calcul EXPLICITE et détaillé : base + n × per_item.
// Pays inconnu → erreur claire (pas de tarif par défaut silencieux).
func (s *server) quote(w http.ResponseWriter, r *http.Request) {
	country := strings.ToUpper(r.URL.Query().Get("country"))
	items := r.URL.Query().Get("items")
	if country == "" {
		kit.Fail(w, 400, "missing_country", "paramètre country obligatoire (ISO alpha-2)")
		return
	}
	var zone string
	err := s.db.QueryRow(r.Context(), `SELECT zone FROM zone_countries WHERE country = $1`, country).Scan(&zone)
	if err != nil {
		kit.Fail(w, 404, "country_not_served",
			fmt.Sprintf("pays %q absent des zones de livraison — ajouter le pays dans zone_countries pour le desservir", country))
		return
	}
	var base, perItem int64
	var minD, maxD int
	_ = s.db.QueryRow(r.Context(), `
		SELECT base_rate_xof, per_item_xof, min_days, max_days FROM shipping_zones WHERE zone = $1`, zone,
	).Scan(&base, &perItem, &minD, &maxD)

	n := int64(1)
	fmt.Sscanf(items, "%d", &n)
	if n < 1 {
		n = 1
	}
	total := base + n*perItem
	kit.JSON(w, 200, map[string]any{
		"zone": zone, "total_xof": total, "min_days": minD, "max_days": maxD,
		"breakdown": fmt.Sprintf("base %d XOF + %d article(s) × %d XOF", base, n, perItem),
	})
}

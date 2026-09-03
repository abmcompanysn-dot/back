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
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/miadmarket/miad-backend/internal/kit"
)

const schema = `
CREATE TABLE IF NOT EXISTS shipping_zones (
  id            BIGSERIAL PRIMARY KEY,
  zone          TEXT UNIQUE NOT NULL,      -- local | continent | international
  countries     JSONB NOT NULL DEFAULT '[]',
  base_rate_usd DOUBLE PRECISION NOT NULL, -- USD réel, synchronisé avec lib/shipping-utils.ts du frontend
  per_item_usd  DOUBLE PRECISION NOT NULL DEFAULT 0,
  min_days      INT NOT NULL DEFAULT 1,
  max_days      INT NOT NULL DEFAULT 7
);

CREATE TABLE IF NOT EXISTS zone_countries (
  country TEXT PRIMARY KEY,               -- ISO 3166-1 alpha-2
  zone    TEXT NOT NULL
);

-- Tarif EXPRESS par zone (le standard reste base_rate_usd de shipping_zones).
ALTER TABLE shipping_zones ADD COLUMN IF NOT EXISTS express_rate_usd DOUBLE PRECISION;

-- ---------- Config globale de livraison (éditable en back-office) ----------
-- Une ligne par réglage scalaire. Alimente GET /shipping/config, l'unique
-- source du frontend (fin du calcul en dur dans lib/shipping-utils.ts /
-- useShippingRates.ts / app/page.tsx). Clés :
--   local_rate_usd              tarif quand vendeur ET client au même pays
--   zone_africa_rate_usd        tarif Afrique -> Afrique (zones AF<->AF)
--   free_shipping_threshold_usd sous-total à partir duquel la livraison est offerte (0 = jamais)
--   domestic_fallback_usd       repli livraison nationale SN quand le calcul par distance échoue
CREATE TABLE IF NOT EXISTS shipping_config (
  key   TEXT PRIMARY KEY,
  value DOUBLE PRECISION NOT NULL
);

-- Tarif standard + express par zone CONTINENTALE frontend (AF/EU/NA/SA/AS/OC).
-- shipping_zones garde les 3 zones agrégées internes (local/continent/
-- international) utilisées par order-svc via /shipping-rates/quote ; cette
-- table-ci est la vue "6 zones" que le checkout affiche et facture.
CREATE TABLE IF NOT EXISTS shipping_zone_rates (
  zone          TEXT PRIMARY KEY,          -- AF | EU | NA | SA | AS | OC
  standard_usd  DOUBLE PRECISION NOT NULL,
  express_usd   DOUBLE PRECISION NOT NULL
);

-- ---------- Taux de change : source UNIQUE USD -> devise ----------
-- Remplace les 3 constantes dupliquées du PHP historique
-- (MIAD_USD_TO_FCFA, miad_currency_rates['FCFA'], MIAD_DOMESTIC_FCFA_PER_USD).
-- Lu par shipping-svc (zone + national) ET par tout autre service qui a
-- besoin de convertir un prix USD (ex: cmd/wc-import).
CREATE TABLE IF NOT EXISTS exchange_rates (
  currency      TEXT PRIMARY KEY,   -- ISO 4217, ex. "XOF", "CAD"
  rate_per_usd  DOUBLE PRECISION NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Livraison nationale Sénégal (par distance, Haversine) ----------
-- Système VOLONTAIREMENT séparé de la livraison internationale par zone
-- (logique métier différente : distance réelle vs zone fixe).
CREATE TABLE IF NOT EXISTS domestic_tiers (
  id               BIGSERIAL PRIMARY KEY,
  max_distance_km  DOUBLE PRECISION NOT NULL,
  price_usd        DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS vendor_shipping_addresses (
  vendor_id  BIGINT PRIMARY KEY,
  address    TEXT NOT NULL DEFAULT '',
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8 états : voir domesticStages ci-dessous.
CREATE TABLE IF NOT EXISTS domestic_order_stages (
  order_id   BIGINT PRIMARY KEY,
  stage      TEXT NOT NULL DEFAULT 'pending_pickup',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`

// domesticStages — machine à états explicite pour la livraison locale
// (ramassage vendeur -> livraison client), distincte des 5 états de la
// livraison internationale (voir order-svc / DHL).
var domesticStages = map[string]bool{
	"pending_pickup":     true,
	"pickup_scheduled":   true,
	"picked_up":          true,
	"in_transit":         true,
	"out_for_delivery":   true,
	"delivery_attempted": true,
	"delivered":          true,
	"delivery_failed":    true,
}

// defaultExchangeRates — seed initial, à ajuster ensuite via
// POST /exchange-rates. Toutes relatives à 1 USD.
var defaultExchangeRates = map[string]float64{
	"XOF": 600.0, // FCFA (Sénégal, Guinée, Ghana zone UEMOA/CFA proche)
	"CAD": 1.41,  // 1 / 0.71 (voir CAD_TO_USD_RATE côté frontend)
}

// frontendZoneMap — les 3 zones internes (local/continent/international) de
// ce service exposées sous les 6 zones continentales que le frontend
// attend (AF/EU/NA/SA/AS/OC). "continent" alimente AF ; "international"
// alimente EU/NA/SA/AS/OC. Le tarif "local" (même pays) est un scalaire à
// part (shipping_config.local_rate_usd), pas une zone.
var frontendZoneOf = map[string]string{
	"AF": "continent",
	"EU": "international", "NA": "international", "SA": "international",
	"AS": "international", "OC": "international",
}

// defaultShippingConfig — valeurs initiales, EXACTEMENT celles qui étaient
// codées en dur côté frontend (useShippingRates.ts FALLBACK + app/page.tsx
// SHIPPING_FALLBACK + CheckoutPage FREE_SHIPPING_THRESHOLD + le repli
// SENEGAL_DOMESTIC_FALLBACK_USD). Modifiables ensuite en back-office.
var defaultShippingConfig = map[string]float64{
	"local_rate_usd":              3,
	"zone_africa_rate_usd":        6,
	"free_shipping_threshold_usd": 150,
	"domestic_fallback_usd":       8.33, // 5000 XOF / 600
}

// defaultExpressRates — tarif express par zone frontend, repris de
// useShippingRates.ts FALLBACK.zones[...].express. Le standard vient de
// seedZones (base_rate_usd).
var defaultExpressRates = map[string]float64{
	"AF": 30, "EU": 45, "NA": 50, "SA": 55, "AS": 55, "OC": 60,
}

// defaultStandardRates — tarif standard par zone frontend
// (useShippingRates.ts FALLBACK.zones[...].standard). Sert à afficher un
// tarif par zone même quand seedZones n'a que 3 zones agrégées.
var defaultStandardRates = map[string]float64{
	"AF": 12, "EU": 25, "NA": 25, "SA": 25, "AS": 25, "OC": 30,
}

// defaultDomesticTiers — tranches de distance Dakar-centré, EN USD.
// Aucun équivalent existant côté frontend (système Haversine national
// entièrement nouveau, pas une resynchronisation) — valeurs à confirmer
// avec le fondateur avant bascule prod, via POST /shipping-domestic/tiers.
var defaultDomesticTiers = []struct {
	MaxKM float64
	Price float64
}{
	{5, 2},
	{15, 3.5},
	{30, 6},
	{60, 9},
	{999999, 13}, // au-delà : tarif plafond, jamais de refus silencieux
}

// seed — montants EXACTS de lib/shipping-utils.ts ZONE_SHIPPING_RATES
// (frontend, section "standardMin"/"local", en USD réel) resynchronisés
// le jour du passage price_xof -> price_usd de tout le backend. Le
// frontend a 6 zones continentales (AF/EU/NA/SA/AS/OC) + "local" ; ce
// service en garde 3 (local/continent/international) — "continent" =
// tarif AF (le cas Sénégal→reste de l'Afrique, le plus fréquent pour
// MIAD Market), "international" = moyenne standardMin des 5 autres
// zones (EU/NA/SA/AS/OC ≈ 25-30$, arrondi à 27$). Documenté ici pour
// que la prochaine resynchronisation reparte de la même source.
var seedZones = []struct {
	Zone       string
	Countries  []string
	Base       float64
	PerItem    float64
	MinD, MaxD int
}{
	{"local", []string{"SN", "GM"}, 3, 1, 1, 3}, // ZONE_SHIPPING_RATES.AF.local = 10$ pour le même continent ; local strict (même pays/voisin immédiat) reste moins cher, valeur à confirmer avec le fondateur
	{"continent", []string{
		// Afrique de l'Ouest
		"CI", "ML", "BF", "GN", "BJ", "TG", "NE", "MR", "GW", "SL", "LR", "GH", "CV",
		// Afrique centrale & du Nord
		"CM", "GA", "CG", "TD", "CF", "GQ", "MA", "DZ", "TN", "LY", "EG",
		// Afrique de l'Est & australe
		"KE", "ET", "UG", "TZ", "RW", "BI", "DJ", "MG", "MU", "SC", "MW", "ZM", "ZW",
		"BW", "NA", "ZA", "MZ", "AO", "CD",
	}, 12, 5, 5, 10}, // ZONE_SHIPPING_RATES.AF.standardMin = 12$
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
	}, 27, 10, 7, 21}, // moyenne standardMin EU(25)/NA(25)/SA(25)/AS(25)/OC(30) ≈ 27$
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
	if err := s.seedExchangeRates(ctx); err != nil {
		log.Error("seed des taux de change impossible", "err", err)
		return
	}
	// Rafraîchissement automatique (voir exchange-rates-refresh.go) : le
	// seed ci-dessus ne s'exécute qu'une fois (ON CONFLICT DO NOTHING),
	// les valeurs y restaient donc figées indéfiniment (XOF à 600 alors
	// que le taux réel dérive) — un tick immédiat puis 1×/jour via une
	// API gratuite corrige ça sans jamais bloquer le démarrage du service.
	s.startExchangeRateRefreshLoop(log)
	if err := s.seedDomesticTiers(ctx); err != nil {
		log.Error("seed des tranches nationales impossible", "err", err)
		return
	}
	if err := s.seedShippingConfig(ctx); err != nil {
		log.Error("seed de la config livraison impossible", "err", err)
		return
	}

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)

	kit.Run("shipping-svc", kit.Env("PORT_SHIPPING", "8085"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("GET /shipping-rates", s.listRates)
		mux.HandleFunc("GET /shipping-rates/quote", s.quote)

		// Config unifiée consommée par le frontend (fin du calcul en dur).
		mux.HandleFunc("GET /shipping/config", s.getShippingConfig)
		mux.HandleFunc("POST /shipping/config", s.setShippingConfig)

		mux.HandleFunc("GET /exchange-rates", s.listExchangeRates)
		mux.HandleFunc("POST /exchange-rates", s.setExchangeRate)

		mux.HandleFunc("GET /shipping-domestic/tiers", s.listDomesticTiers)
		mux.HandleFunc("POST /shipping-domestic/tiers", s.setDomesticTier)
		mux.HandleFunc("DELETE /shipping-domestic/tiers/{id}", s.deleteDomesticTier)
		mux.HandleFunc("GET /vendor-shipping-address", s.getVendorShippingAddress)
		mux.HandleFunc("GET /vendor-shipping-addresses", s.listVendorShippingAddresses)
		mux.HandleFunc("POST /vendor-shipping-address", s.setVendorShippingAddress)
		mux.HandleFunc("POST /shipping-domestic/calculate", s.calculateDomestic)
		mux.HandleFunc("POST /shipping-domestic/order-stage", s.setDomesticOrderStage)
		mux.HandleFunc("GET /shipping-domestic/order-stage/{id}", s.getDomesticOrderStage)
	})
}

func (s *server) seed(ctx context.Context) error {
	for _, z := range seedZones {
		countries, _ := json.Marshal(z.Countries)
		if _, err := s.db.Exec(ctx, `
			INSERT INTO shipping_zones (zone, countries, base_rate_usd, per_item_usd, min_days, max_days)
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

func (s *server) seedExchangeRates(ctx context.Context) error {
	for currency, rate := range defaultExchangeRates {
		if _, err := s.db.Exec(ctx, `
			INSERT INTO exchange_rates (currency, rate_per_usd) VALUES ($1,$2)
			ON CONFLICT (currency) DO NOTHING`, currency, rate); err != nil {
			return err
		}
	}
	return nil
}

func (s *server) seedDomesticTiers(ctx context.Context) error {
	var n int
	if err := s.db.QueryRow(ctx, "SELECT count(*) FROM domestic_tiers").Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil // déjà configuré (admin a peut-être ajusté les tarifs)
	}
	for _, t := range defaultDomesticTiers {
		if _, err := s.db.Exec(ctx, `
			INSERT INTO domestic_tiers (max_distance_km, price_usd) VALUES ($1,$2)`,
			t.MaxKM, t.Price); err != nil {
			return err
		}
	}
	return nil
}

// seedShippingConfig — pose les scalaires (shipping_config) et la grille
// standard/express par zone frontend (shipping_zone_rates) si absents.
// Idempotent : ON CONFLICT DO NOTHING, l'admin peut ensuite tout ajuster.
func (s *server) seedShippingConfig(ctx context.Context) error {
	for k, v := range defaultShippingConfig {
		if _, err := s.db.Exec(ctx, `
			INSERT INTO shipping_config (key, value) VALUES ($1,$2)
			ON CONFLICT (key) DO NOTHING`, k, v); err != nil {
			return err
		}
	}
	for zone, std := range defaultStandardRates {
		if _, err := s.db.Exec(ctx, `
			INSERT INTO shipping_zone_rates (zone, standard_usd, express_usd) VALUES ($1,$2,$3)
			ON CONFLICT (zone) DO NOTHING`, zone, std, defaultExpressRates[zone]); err != nil {
			return err
		}
	}
	return nil
}

// getShippingConfig — GET /shipping/config. L'UNIQUE source du frontend
// pour les tarifs de livraison. Format calé sur ce que useShippingRates.ts
// (ShippingRatesConfig) et app/page.tsx (SHIPPING_FALLBACK) attendaient
// quand c'était codé en dur :
//
//	{
//	  "local": 3, "zone_africa": 6,
//	  "free_threshold": 150, "domestic_fallback_usd": 8.33,
//	  "zones": { "AF": {"standard":12,"express":30}, "EU": {...}, ... }
//	}
func (s *server) getShippingConfig(w http.ResponseWriter, r *http.Request) {
	cfg := map[string]float64{}
	rows, err := s.db.Query(r.Context(), `SELECT key, value FROM shipping_config`)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	for rows.Next() {
		var k string
		var v float64
		if rows.Scan(&k, &v) == nil {
			cfg[k] = v
		}
	}
	rows.Close()

	zones := map[string]map[string]float64{}
	zr, err := s.db.Query(r.Context(), `SELECT zone, standard_usd, express_usd FROM shipping_zone_rates`)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	for zr.Next() {
		var z string
		var std, exp float64
		if zr.Scan(&z, &std, &exp) == nil {
			zones[z] = map[string]float64{"standard": std, "express": exp}
		}
	}
	zr.Close()

	// Repli sur les défauts si une clé/zone manque (base fraîche, migration
	// partielle) — le frontend ne doit jamais recevoir un champ absent.
	get := func(k string) float64 {
		if v, ok := cfg[k]; ok {
			return v
		}
		return defaultShippingConfig[k]
	}
	for z, std := range defaultStandardRates {
		if _, ok := zones[z]; !ok {
			zones[z] = map[string]float64{"standard": std, "express": defaultExpressRates[z]}
		}
	}

	kit.JSON(w, 200, map[string]any{
		"local":                 get("local_rate_usd"),
		"zone_africa":           get("zone_africa_rate_usd"),
		"free_threshold":        get("free_shipping_threshold_usd"),
		"domestic_fallback_usd": get("domestic_fallback_usd"),
		"zones":                 zones,
		"currency":              "USD",
	})
}

// setShippingConfig — POST /shipping/config. Écrit les scalaires et/ou la
// grille par zone. Corps partiel accepté (seuls les champs fournis sont
// modifiés). Pas de contrôle d'accès ici, aligné sur setDomesticTier /
// setExchangeRate de ce même service : shipping-svc n'est pas exposé
// publiquement (Caddy ne route que /shipping-domestic/calculate et
// /shipping-rates* vers lui), les écritures passent par admin-svc qui,
// lui, exige un rôle admin. Aussi utilisé pour garder shipping_zones (les
// 3 zones agrégées internes, lues par order-svc/quote) en phase avec le
// tarif standard AF/EU édité en back-office.
func (s *server) setShippingConfig(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Local            *float64 `json:"local"`
		ZoneAfrica       *float64 `json:"zone_africa"`
		FreeThreshold    *float64 `json:"free_threshold"`
		DomesticFallback *float64 `json:"domestic_fallback_usd"`
		Zones            map[string]struct {
			Standard *float64 `json:"standard"`
			Express  *float64 `json:"express"`
		} `json:"zones"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	ctx := r.Context()
	setScalar := func(key string, v *float64) error {
		if v == nil {
			return nil
		}
		_, err := s.db.Exec(ctx, `
			INSERT INTO shipping_config (key, value) VALUES ($1,$2)
			ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, key, *v)
		return err
	}
	for _, pair := range []struct {
		k string
		v *float64
	}{
		{"local_rate_usd", body.Local},
		{"zone_africa_rate_usd", body.ZoneAfrica},
		{"free_shipping_threshold_usd", body.FreeThreshold},
		{"domestic_fallback_usd", body.DomesticFallback},
	} {
		if err := setScalar(pair.k, pair.v); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
	}
	for zone, rates := range body.Zones {
		zone = strings.ToUpper(zone)
		if _, ok := defaultStandardRates[zone]; !ok {
			continue // zone inconnue ignorée
		}
		// upsert en lisant l'existant pour un update partiel (standard seul, etc.)
		var curStd, curExp float64
		_ = s.db.QueryRow(ctx, `SELECT standard_usd, express_usd FROM shipping_zone_rates WHERE zone=$1`, zone).Scan(&curStd, &curExp)
		if curStd == 0 && curExp == 0 {
			curStd, curExp = defaultStandardRates[zone], defaultExpressRates[zone]
		}
		if rates.Standard != nil {
			curStd = *rates.Standard
		}
		if rates.Express != nil {
			curExp = *rates.Express
		}
		if _, err := s.db.Exec(ctx, `
			INSERT INTO shipping_zone_rates (zone, standard_usd, express_usd) VALUES ($1,$2,$3)
			ON CONFLICT (zone) DO UPDATE SET standard_usd = EXCLUDED.standard_usd, express_usd = EXCLUDED.express_usd`,
			zone, curStd, curExp); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		// Garder la zone agrégée interne correspondante en phase (base_rate_usd
		// = le standard de la zone frontend qui l'alimente) pour que
		// order-svc /quote facture le même montant.
		if internal, ok := frontendZoneOf[zone]; ok {
			_, _ = s.db.Exec(ctx, `UPDATE shipping_zones SET base_rate_usd=$2 WHERE zone=$1`, internal, curStd)
		}
	}
	kit.JSON(w, 200, map[string]any{"status": "ok"})
}

func (s *server) listRates(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `
		SELECT zone, countries, base_rate_usd, per_item_usd, min_days, max_days
		FROM shipping_zones ORDER BY base_rate_usd`)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	zones := []map[string]any{}
	for rows.Next() {
		var zone string
		var countries []byte
		var base, perItem float64
		var minD, maxD int
		_ = rows.Scan(&zone, &countries, &base, &perItem, &minD, &maxD)
		zones = append(zones, map[string]any{
			"zone": zone, "countries": json.RawMessage(countries),
			"base_rate_usd": base, "per_item_usd": perItem,
			"min_days": minD, "max_days": maxD,
		})
	}
	kit.JSON(w, 200, map[string]any{"zones": zones, "currency": "USD"})
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
	var base, perItem float64
	var minD, maxD int
	_ = s.db.QueryRow(r.Context(), `
		SELECT base_rate_usd, per_item_usd, min_days, max_days FROM shipping_zones WHERE zone = $1`, zone,
	).Scan(&base, &perItem, &minD, &maxD)

	n := int64(1)
	fmt.Sscanf(items, "%d", &n)
	if n < 1 {
		n = 1
	}
	total := base + float64(n)*perItem
	kit.JSON(w, 200, map[string]any{
		"zone": zone, "total_usd": total, "min_days": minD, "max_days": maxD,
		"breakdown": fmt.Sprintf("base %.2f $ + %d article(s) × %.2f $", base, n, perItem),
	})
}

// ---------- Taux de change (source unique) ----------

func (s *server) listExchangeRates(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `SELECT currency, rate_per_usd, updated_at FROM exchange_rates ORDER BY currency`)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	rates := []map[string]any{}
	for rows.Next() {
		var currency string
		var rate float64
		var at time.Time
		_ = rows.Scan(&currency, &rate, &at)
		rates = append(rates, map[string]any{
			"currency": currency, "rate_per_usd": rate,
			"updated_at": at.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{"rates": rates})
}

func (s *server) setExchangeRate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Currency   string  `json:"currency"`
		RatePerUSD float64 `json:"rate_per_usd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	body.Currency = strings.ToUpper(strings.TrimSpace(body.Currency))
	if body.Currency == "" || body.RatePerUSD <= 0 {
		kit.Fail(w, 400, "invalid_rate", "currency et rate_per_usd (> 0) obligatoires")
		return
	}
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO exchange_rates (currency, rate_per_usd, updated_at) VALUES ($1,$2,now())
		ON CONFLICT (currency) DO UPDATE SET rate_per_usd = EXCLUDED.rate_per_usd, updated_at = now()`,
		body.Currency, body.RatePerUSD); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"currency": body.Currency, "rate_per_usd": body.RatePerUSD})
}

// ---------- Livraison nationale Sénégal (Haversine) ----------

func (s *server) listDomesticTiers(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `SELECT id, max_distance_km, price_usd FROM domestic_tiers ORDER BY max_distance_km`)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	tiers := []map[string]any{}
	for rows.Next() {
		var id int64
		var price float64
		var maxKM float64
		_ = rows.Scan(&id, &maxKM, &price)
		tiers = append(tiers, map[string]any{
			"id": id, "max_distance_km": maxKM, "price_usd": price,
		})
	}
	kit.JSON(w, 200, map[string]any{"tiers": tiers})
}

func (s *server) setDomesticTier(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MaxDistanceKM float64 `json:"max_distance_km"`
		PriceUSD      float64 `json:"price_usd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.MaxDistanceKM <= 0 || body.PriceUSD < 0 {
		kit.Fail(w, 400, "invalid_tier", "max_distance_km (> 0) et price_usd (>= 0) obligatoires")
		return
	}
	var id int64
	if err := s.db.QueryRow(r.Context(), `
		INSERT INTO domestic_tiers (max_distance_km, price_usd) VALUES ($1,$2) RETURNING id`,
		body.MaxDistanceKM, body.PriceUSD).Scan(&id); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 201, map[string]any{"id": id, "max_distance_km": body.MaxDistanceKM, "price_usd": body.PriceUSD})
}

// deleteDomesticTier — DELETE /shipping-domestic/tiers/{id}. Retire une
// tranche de la grille par distance (édition back-office). On refuse la
// suppression de la DERNIÈRE tranche : sans grille, calculateDomestic
// renverrait "no_tier_matched" pour toute commande nationale.
func (s *server) deleteDomesticTier(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var n int
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM domestic_tiers`).Scan(&n); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if n <= 1 {
		kit.Fail(w, 409, "last_tier", "impossible de supprimer la dernière tranche tarifaire — la grille doit garder au moins une entrée")
		return
	}
	if _, err := s.db.Exec(r.Context(), `DELETE FROM domestic_tiers WHERE id = $1`, id); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"status": "ok", "deleted": id})
}

func (s *server) getVendorShippingAddress(w http.ResponseWriter, r *http.Request) {
	vendorID := r.URL.Query().Get("vendor_id")
	if vendorID == "" {
		kit.Fail(w, 400, "missing_vendor_id", "paramètre vendor_id obligatoire")
		return
	}
	var address string
	var lat, lng float64
	err := s.db.QueryRow(r.Context(),
		`SELECT address, lat, lng FROM vendor_shipping_addresses WHERE vendor_id = $1`, vendorID,
	).Scan(&address, &lat, &lng)
	if err != nil {
		kit.Fail(w, 404, "address_not_found", fmt.Sprintf("aucune adresse d'expédition pour le vendeur %s", vendorID))
		return
	}
	kit.JSON(w, 200, map[string]any{"vendor_id": vendorID, "address": address, "lat": lat, "lng": lng})
}

// listVendorShippingAddresses — toutes les adresses d'expédition vendeur
// enregistrées (alimente la carte admin des boutiques). Pas de pagination :
// quelques dizaines de vendeurs au plus.
func (s *server) listVendorShippingAddresses(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(),
		`SELECT vendor_id, address, lat, lng, updated_at FROM vendor_shipping_addresses ORDER BY vendor_id`)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var vendorID int64
		var address string
		var lat, lng float64
		var updatedAt time.Time
		if err := rows.Scan(&vendorID, &address, &lat, &lng, &updatedAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		items = append(items, map[string]any{
			"vendor_id": vendorID, "address": address, "lat": lat, "lng": lng,
			"updated_at": updatedAt.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{"items": items})
}

func (s *server) setVendorShippingAddress(w http.ResponseWriter, r *http.Request) {
	var body struct {
		VendorID int64   `json:"vendor_id"`
		Address  string  `json:"address"`
		Lat      float64 `json:"lat"`
		Lng      float64 `json:"lng"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.VendorID == 0 || (body.Lat == 0 && body.Lng == 0) {
		kit.Fail(w, 400, "missing_fields", "vendor_id et lat/lng obligatoires")
		return
	}
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO vendor_shipping_addresses (vendor_id, address, lat, lng, updated_at)
		VALUES ($1,$2,$3,$4,now())
		ON CONFLICT (vendor_id) DO UPDATE SET
			address = EXCLUDED.address, lat = EXCLUDED.lat, lng = EXCLUDED.lng, updated_at = now()`,
		body.VendorID, body.Address, body.Lat, body.Lng); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{
		"vendor_id": body.VendorID, "address": body.Address, "lat": body.Lat, "lng": body.Lng,
	})
}

// calculateDomestic — distance Haversine vendeur -> client, puis tranche
// tarifaire correspondante. Erreur EXPLICITE si l'adresse vendeur n'est
// pas encore renseignée (jamais de tarif par défaut silencieux).
func (s *server) calculateDomestic(w http.ResponseWriter, r *http.Request) {
	var body struct {
		VendorID int64   `json:"vendor_id"`
		DestLat  float64 `json:"dest_lat"`
		DestLng  float64 `json:"dest_lng"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.VendorID == 0 || body.DestLat == 0 || body.DestLng == 0 {
		kit.Fail(w, 400, "missing_fields", "vendor_id, dest_lat, dest_lng obligatoires")
		return
	}
	var vLat, vLng float64
	err := s.db.QueryRow(r.Context(),
		`SELECT lat, lng FROM vendor_shipping_addresses WHERE vendor_id = $1`, body.VendorID,
	).Scan(&vLat, &vLng)
	if err != nil {
		kit.Fail(w, 404, "vendor_address_missing",
			fmt.Sprintf("le vendeur %d n'a pas d'adresse d'expédition — POST /vendor-shipping-address d'abord", body.VendorID))
		return
	}
	distanceKM := haversineKM(vLat, vLng, body.DestLat, body.DestLng)

	var tierID int64
	var price float64
	err = s.db.QueryRow(r.Context(), `
		SELECT id, price_usd FROM domestic_tiers
		WHERE max_distance_km >= $1 ORDER BY max_distance_km ASC LIMIT 1`, distanceKM,
	).Scan(&tierID, &price)
	if err != nil {
		kit.Fail(w, 500, "no_tier_matched",
			fmt.Sprintf("aucune tranche tarifaire ne couvre %.1f km — vérifier domestic_tiers", distanceKM))
		return
	}
	kit.JSON(w, 200, map[string]any{
		"distance_km": math.Round(distanceKM*10) / 10,
		"price_usd":   price,
		"tier_id":     tierID,
	})
}

// haversineKM — distance orthodromique entre deux points (lat/lng en degrés).
func haversineKM(lat1, lng1, lat2, lng2 float64) float64 {
	const earthRadiusKM = 6371.0
	toRad := func(deg float64) float64 { return deg * math.Pi / 180 }
	dLat := toRad(lat2 - lat1)
	dLng := toRad(lng2 - lng1)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(toRad(lat1))*math.Cos(toRad(lat2))*math.Sin(dLng/2)*math.Sin(dLng/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return earthRadiusKM * c
}

// ---------- Statut de livraison nationale (8 états, machine explicite) ----------

func (s *server) setDomesticOrderStage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OrderID int64  `json:"order_id"`
		Stage   string `json:"stage"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.OrderID == 0 {
		kit.Fail(w, 400, "missing_order_id", "order_id obligatoire")
		return
	}
	if !domesticStages[body.Stage] {
		kit.Fail(w, 400, "invalid_stage", fmt.Sprintf("stage %q inconnu — valeurs valides : %v", body.Stage, stageNames()))
		return
	}
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO domestic_order_stages (order_id, stage, updated_at) VALUES ($1,$2,now())
		ON CONFLICT (order_id) DO UPDATE SET stage = EXCLUDED.stage, updated_at = now()`,
		body.OrderID, body.Stage); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"order_id": body.OrderID, "stage": body.Stage})
}

func (s *server) getDomesticOrderStage(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		kit.Fail(w, 400, "invalid_id", "id de commande invalide")
		return
	}
	var stage string
	var at time.Time
	err = s.db.QueryRow(r.Context(),
		`SELECT stage, updated_at FROM domestic_order_stages WHERE order_id = $1`, id,
	).Scan(&stage, &at)
	if err != nil {
		kit.Fail(w, 404, "stage_not_found", fmt.Sprintf("aucun statut national pour la commande %d", id))
		return
	}
	kit.JSON(w, 200, map[string]any{
		"order_id": id, "stage": stage, "updated_at": at.UTC().Format(time.RFC3339),
	})
}

func stageNames() []string {
	names := make([]string, 0, len(domesticStages))
	for k := range domesticStages {
		names = append(names, k)
	}
	return names
}

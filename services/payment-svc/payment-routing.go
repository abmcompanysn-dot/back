// ============================================================
// payment-routing.go — écran admin "Mobile Money" (2026-08-28) :
// visibilité + routage manuel PawaPay ⇄ PayDunya par pays/opérateur.
//
// Les deux agrégateurs ont des codes provider DIFFÉRENTS pour le même
// opérateur (ex. ORANGE_SEN côté PawaPay, ORANGE_SN côté PayDunya —
// suffixe ISO3 vs ISO2, pas le même référentiel) : la correspondance
// "même opérateur" se fait donc sur {country_iso2, label normalisé},
// pas sur le code brut d'aucun des deux agrégateurs.
package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/miadmarket/miad-backend/internal/kit"
)

// normalizeOperatorLabel — MTN Momo / Orange Money / etc. peuvent être
// écrits légèrement différemment d'un agrégateur à l'autre (déjà vu :
// "MTN MoMo" vs "MTN Money", "Moov Money" vs "Moov"). On compare sur le
// premier mot significatif (le nom de l'opérateur), pas le libellé
// complet — suffisant en pratique, les deux agrégateurs utilisent tous
// les deux Orange/MTN/Moov/Wave/etc. comme premier mot.
func normalizeOperatorLabel(label string) string {
	return strings.ToUpper(strings.Fields(label)[0])
}

// paymentRouteRow — une ligne du tableau admin : un opérateur pour un
// pays, ce que chaque agrégateur en sait, et l'override actif s'il y en
// a un.
type paymentRouteRow struct {
	CountryISO2      string  `json:"country_iso2"`
	CountryName      string  `json:"country_name"`
	OperatorLabel    string  `json:"operator_label"`
	PawapayCode      *string `json:"pawapay_code"`      // nil = non supporté par PawaPay
	PawapayAuthType  *string `json:"pawapay_auth_type"` // nil si PawapayCode nil ou inconnu
	PaydunyaCode     *string `json:"paydunya_code"`     // nil = non supporté par PayDunya
	PaydunyaBehavior *string `json:"paydunya_behavior"`
	ActiveAggregator string  `json:"active_aggregator"` // 'pawapay' | 'paydunya' — résolu (override ou défaut)
	IsOverride       bool    `json:"is_override"`       // true = ligne éditée manuellement en base
	OperatorEnabled  bool    `json:"operator_enabled"`  // false = masqué du sélecteur checkout (payment_operator_disabled)
	CountryEnabled   bool    `json:"country_enabled"`   // false = tout le pays masqué (payment_country_disabled)
}

// listPaymentRoutingHandler — GET /payments/routing. Construit le
// tableau complet en croisant pawapayCountries (PawaPay) et
// paydunyaSoftpayProviders (PayDunya) par {pays, opérateur normalisé},
// puis applique les overrides déjà enregistrés + le défaut global
// (le seul agrégateur actif en Configuration → Paiements, s'il n'y a
// pas d'override pour cette ligne précise).
func (s *server) listPaymentRoutingHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cfg, _ := s.pawapayActiveConfig(ctx) // nil si erreur, providerAuthType gère nil proprement

	// clé de regroupement : {ISO2}|{opérateur normalisé}
	type key struct{ country, operator string }
	rows := map[key]*paymentRouteRow{}

	for _, c := range pawapayCountries {
		for _, code := range c.Providers {
			label := providerDisplayLabel(code)
			op := normalizeOperatorLabel(label)
			k := key{c.ISO2, op}
			row, ok := rows[k]
			if !ok {
				row = &paymentRouteRow{CountryISO2: c.ISO2, CountryName: c.Name, OperatorLabel: label}
				rows[k] = row
			}
			codeCopy := code
			row.PawapayCode = &codeCopy
			authType := providerAuthType(cfg, c.ISO3, code)
			if authType != "" {
				row.PawapayAuthType = &authType
			}
		}
	}
	for _, p := range paydunyaSoftpayProviders {
		op := normalizeOperatorLabel(p.Label)
		k := key{p.CountryISO2, op}
		row, ok := rows[k]
		if !ok {
			row = &paymentRouteRow{CountryISO2: p.CountryISO2, CountryName: countryNameForISO2(p.CountryISO2), OperatorLabel: p.Label}
			rows[k] = row
		}
		codeCopy := p.Code
		row.PaydunyaCode = &codeCopy
		behavior := string(p.Behavior)
		row.PaydunyaBehavior = &behavior
	}

	// Overrides déjà enregistrés — clé de stockage {country_iso2,
	// provider_code} où provider_code est le code PawaPay OU PayDunya de
	// la ligne (peu importe lequel, on ne stocke qu'une valeur par ligne
	// logique) ; on retrouve la ligne via son PawapayCode ou PaydunyaCode.
	overrides := map[string]string{} // "{iso2}|{code}" -> aggregator
	orows, err := s.db.Query(ctx, "SELECT country_iso2, provider_code, aggregator FROM payment_routing_overrides")
	if err == nil {
		defer orows.Close()
		for orows.Next() {
			var iso2, code, agg string
			if orows.Scan(&iso2, &code, &agg) == nil {
				overrides[iso2+"|"+code] = agg
			}
		}
	}

	defaultAggregator := "paydunya"
	if s.pawapayEnabled() {
		defaultAggregator = "pawapay"
	}

	// Opérateurs/pays désactivés — même logique "absence = activé" que les
	// overrides de routage ci-dessus.
	disabledOperators := map[string]bool{} // "{iso2}|{opérateur normalisé}"
	dorows, err := s.db.Query(ctx, "SELECT country_iso2, operator_label FROM payment_operator_disabled")
	if err == nil {
		defer dorows.Close()
		for dorows.Next() {
			var iso2, op string
			if dorows.Scan(&iso2, &op) == nil {
				disabledOperators[iso2+"|"+op] = true
			}
		}
	}
	disabledCountries := map[string]bool{}
	dcrows, err := s.db.Query(ctx, "SELECT country_iso2 FROM payment_country_disabled")
	if err == nil {
		defer dcrows.Close()
		for dcrows.Next() {
			var iso2 string
			if dcrows.Scan(&iso2) == nil {
				disabledCountries[iso2] = true
			}
		}
	}

	out := make([]paymentRouteRow, 0, len(rows))
	for _, row := range rows {
		row.ActiveAggregator = defaultAggregator
		if row.PawapayCode != nil {
			if agg, ok := overrides[row.CountryISO2+"|"+*row.PawapayCode]; ok {
				row.ActiveAggregator, row.IsOverride = agg, true
			}
		}
		if row.PaydunyaCode != nil {
			if agg, ok := overrides[row.CountryISO2+"|"+*row.PaydunyaCode]; ok {
				row.ActiveAggregator, row.IsOverride = agg, true
			}
		}
		row.OperatorEnabled = !disabledOperators[row.CountryISO2+"|"+normalizeOperatorLabel(row.OperatorLabel)]
		row.CountryEnabled = !disabledCountries[row.CountryISO2]
		out = append(out, *row)
	}
	kit.JSON(w, 200, map[string]any{"routes": out})
}

// setOperatorEnabledHandler — PUT /payments/operator-enabled. Active ou
// désactive un opérateur pour un pays donné (masqué du sélecteur checkout
// pour TOUS les agrégateurs qui le supportent quand désactivé).
func (s *server) setOperatorEnabledHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CountryISO2   string `json:"country_iso2"`
		OperatorLabel string `json:"operator_label"`
		Enabled       bool   `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.CountryISO2 == "" || body.OperatorLabel == "" {
		kit.Fail(w, 400, "invalid_body", "country_iso2 et operator_label obligatoires")
		return
	}
	iso2 := strings.ToUpper(body.CountryISO2)
	op := normalizeOperatorLabel(body.OperatorLabel)
	var err error
	if body.Enabled {
		_, err = s.db.Exec(r.Context(),
			"DELETE FROM payment_operator_disabled WHERE country_iso2=$1 AND operator_label=$2", iso2, op)
	} else {
		_, err = s.db.Exec(r.Context(), `
			INSERT INTO payment_operator_disabled (country_iso2, operator_label) VALUES ($1, $2)
			ON CONFLICT (country_iso2, operator_label) DO NOTHING`, iso2, op)
	}
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]string{"status": "ok"})
}

// setCountryEnabledHandler — PUT /payments/country-enabled. Active ou
// désactive tout un pays d'un coup (masque tous ses opérateurs du
// sélecteur checkout, quel que soit l'agrégateur).
func (s *server) setCountryEnabledHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CountryISO2 string `json:"country_iso2"`
		Enabled     bool   `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.CountryISO2 == "" {
		kit.Fail(w, 400, "invalid_body", "country_iso2 obligatoire")
		return
	}
	iso2 := strings.ToUpper(body.CountryISO2)
	var err error
	if body.Enabled {
		_, err = s.db.Exec(r.Context(), "DELETE FROM payment_country_disabled WHERE country_iso2=$1", iso2)
	} else {
		_, err = s.db.Exec(r.Context(), `
			INSERT INTO payment_country_disabled (country_iso2) VALUES ($1)
			ON CONFLICT (country_iso2) DO NOTHING`, iso2)
	}
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]string{"status": "ok"})
}

// setPaymentRoutingHandler — PUT /payments/routing. Enregistre un choix
// manuel {pays, code} → agrégateur. Accepte le code PawaPay OU PayDunya
// de la ligne (le frontend envoie celui qu'il a sous la main) — les deux
// sont stockés comme clés valides pour la même ligne logique si les deux
// existent (évite de devoir deviner lequel a été utilisé à la lecture).
func (s *server) setPaymentRoutingHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CountryISO2  string `json:"country_iso2"`
		PawapayCode  string `json:"pawapay_code"`
		PaydunyaCode string `json:"paydunya_code"`
		Aggregator   string `json:"aggregator"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.CountryISO2 == "" || body.Aggregator == "" {
		kit.Fail(w, 400, "invalid_body", "country_iso2 et aggregator obligatoires")
		return
	}
	if body.Aggregator != "pawapay" && body.Aggregator != "paydunya" {
		kit.Fail(w, 400, "invalid_aggregator", "aggregator doit être pawapay ou paydunya")
		return
	}
	if body.PawapayCode == "" && body.PaydunyaCode == "" {
		kit.Fail(w, 400, "invalid_body", "pawapay_code ou paydunya_code requis")
		return
	}
	ctx := r.Context()
	iso2 := strings.ToUpper(body.CountryISO2)
	for _, code := range []string{body.PawapayCode, body.PaydunyaCode} {
		if code == "" {
			continue
		}
		if _, err := s.db.Exec(ctx, `
			INSERT INTO payment_routing_overrides (country_iso2, provider_code, aggregator)
			VALUES ($1, $2, $3)
			ON CONFLICT (country_iso2, provider_code) DO UPDATE SET aggregator = $3, updated_at = now()`,
			iso2, code, body.Aggregator); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
	}
	kit.JSON(w, 200, map[string]string{"status": "ok"})
}

// deletePaymentRoutingHandler — DELETE /payments/routing. Retire un
// override (retour au comportement par défaut, le seul agrégateur
// globalement actif).
func (s *server) deletePaymentRoutingHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CountryISO2  string `json:"country_iso2"`
		PawapayCode  string `json:"pawapay_code"`
		PaydunyaCode string `json:"paydunya_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.CountryISO2 == "" {
		kit.Fail(w, 400, "invalid_body", "country_iso2 obligatoire")
		return
	}
	ctx := r.Context()
	iso2 := strings.ToUpper(body.CountryISO2)
	for _, code := range []string{body.PawapayCode, body.PaydunyaCode} {
		if code == "" {
			continue
		}
		if _, err := s.db.Exec(ctx,
			"DELETE FROM payment_routing_overrides WHERE country_iso2=$1 AND provider_code=$2", iso2, code); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
	}
	kit.JSON(w, 200, map[string]string{"status": "ok"})
}

// providerDisplayLabel — même dictionnaire que providerInfo côté
// frontend (MobileMoneyDirectForm.tsx PROVIDER_INFO), dupliqué ici en
// version minimale (juste le libellé, pas les logos) pour construire le
// tableau admin sans dépendance croisée backend/frontend. À garder
// synchronisé si de nouveaux préfixes provider PawaPay apparaissent.
func providerDisplayLabel(code string) string {
	prefix := strings.Split(code, "_")[0]
	labels := map[string]string{
		"ORANGE": "Orange Money", "FREE": "Free Money", "WAVE": "Wave", "EXPRESSO": "Expresso",
		"MTN": "MTN MoMo", "MOOV": "Moov Money", "TOGOCOM": "Togocom", "VODACOM": "M-Pesa (Vodacom)",
		"AIRTEL": "Airtel Money", "MPESA": "M-Pesa", "VODAFONE": "Vodafone Cash", "AIRTELTIGO": "AirtelTigo",
		"TIGO": "Tigo", "HALOTEL": "Halotel", "HALOPESA": "HaloPesa", "ZAMTEL": "Zamtel",
		"TNM": "TNM Mpamba", "MOVITEL": "M-Pesa (Movitel)", "AFRICELL": "Africell Money",
	}
	if l, ok := labels[prefix]; ok {
		return l
	}
	return prefix
}

// countryNameForISO2 — pawapayCountries a déjà les noms FR par ISO2,
// réutilisé pour les pays PayDunya qui s'y trouvent aussi (tous les pays
// PayDunya SoftPay sont un sous-ensemble des pays PawaPay dans ce
// catalogue) ; repli sur le code ISO2 brut si absent (ne devrait pas
// arriver en pratique).
func countryNameForISO2(iso2 string) string {
	if c := findPawapayCountryByISO2(iso2); c != nil {
		return c.Name
	}
	return iso2
}

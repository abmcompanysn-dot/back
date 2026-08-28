// ============================================================
// pawapay.go — Intégration PawaPay (mobile money multi-pays Afrique).
//
// PawaPay est un agrégateur mobile money : un seul compte marchand
// PawaPay donne accès à M-Pesa (KE/TZ/CD), MTN MoMo, Airtel Money,
// Orange Money, Wave, Free Money, Vodacom, etc. sur ~20 pays.
//
// Flux CLIENT (deposit) : DEUX chemins, voir initiateMobileMoneyDeposit
// (2026-08-28) qui choisit automatiquement entre les deux selon
// l'authType de l'opérateur (GET /v2/active-conf) :
//   - PAYMENT PAGE hébergée (POST /v2/paymentpage, createPawaPayPaymentPage
//     ci-dessous) : PawaPay affiche sa propre page, MÊME modèle que
//     PayDunya (createPayDunyaInvoice, voir main.go) — utilisé quand
//     l'opérateur exige authType=REDIRECT_AUTH, ou par repli si la
//     config active est indisponible.
//   - Dépôt DIRECT (POST /v2/deposits) : le client reste sur notre page
//     checkout (numéro + opérateur saisis chez nous), PawaPay déclenche
//     le push USSD, le frontend fait du polling GET /v2/deposits/{id}
//     jusqu'à COMPLETED/FAILED — utilisé pour PROVIDER_AUTH/PREAUTH.
//
// Flux VERSEMENT (payout) : POST /v2/payouts, cette fois avec le MSISDN
// du bénéficiaire (le vendeur) — pas de page hébergée pour les payouts.
//
// Flux REMBOURSEMENT (refund) : POST /refunds référençant le depositId.
//
// SÉCURITÉ WEBHOOK (voir pawapayWebhook dans main.go) : le corps du
// callback n'est JAMAIS la source de vérité — on en extrait seulement
// l'id (depositId/payoutId/refundId) puis on rappelle GET /v2/... pour
// le statut authoritatif. Sans ça, quiconque connaît l'URL du webhook
// pourrait simuler un paiement réussi.
//
// DEVISE : le catalogue est en USD (source de vérité, voir catalog-svc).
// PawaPay facture en devise LOCALE du pays choisi. Conversion :
//  1. shipping-svc/exchange-rates (source unique, éditable admin) en priorité
//  2. table pawapayFallbackRates ci-dessous en secours (relevé manuel daté)
//
// XOF/XAF : parité fixe avec le catalogue USD ? NON — le catalogue est en
// USD réel, XOF n'est pas 1:1 avec USD. On convertit toujours.
// ============================================================
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- Table pays → opérateurs PawaPay ----------

// pawapayCountry — un pays couvert par PawaPay : sa devise de facturation,
// son indicatic téléphonique international (dialCode, SANS le +) et la
// liste de ses opérateurs mobile money (code "provider" PawaPay).
//
// Le client n'a PAS à choisir l'opérateur chez nous : la Payment Page
// PawaPay le lui demande. Cette table sert (a) au sélecteur de PAYS au
// checkout, (b) à la normalisation MSISDN (dialCode), (c) à la conversion
// de devise (currency). Les listes d'opérateurs sont indicatives (pour un
// éventuel affichage de logos) — la vérité vient de /v2/active-conf.
//
// Codes provider : format <OPERATEUR>_<PAYS-ISO3> (ex. MTN_MOMO_CIV,
// ORANGE_SEN, MPESA_KEN, VODACOM_MPESA_TZA). Relevé sur la doc PawaPay
// v2 (docs.pawapay.io) le 2026-08-27.
type pawapayCountry struct {
	ISO3      string   // ISO 3166-1 alpha-3 (attendu par PawaPay)
	ISO2      string   // ISO 3166-1 alpha-2 (utilisé côté frontend / formData.country)
	Name      string   // libellé FR pour le sélecteur
	Currency  string   // ISO 4217, devise de facturation PawaPay pour ce pays
	DialCode  string   // indicatif international SANS le "+"
	Providers []string // codes provider PawaPay (indicatif)
}

// pawapayCountries — marché cible : TOUS les pays PawaPay Afrique
// (décision fondateur 2026-08-27). Défaut de sélecteur : Sénégal (SN),
// cohérent avec userCountryCode='sn' du checkout et le marché historique.
var pawapayCountries = []pawapayCountry{
	{ISO3: "SEN", ISO2: "SN", Name: "Sénégal", Currency: "XOF", DialCode: "221",
		Providers: []string{"ORANGE_SEN", "FREE_SEN", "WAVE_SEN", "EXPRESSO_SEN"}},
	{ISO3: "CIV", ISO2: "CI", Name: "Côte d'Ivoire", Currency: "XOF", DialCode: "225",
		Providers: []string{"MTN_MOMO_CIV", "ORANGE_CIV", "MOOV_CIV", "WAVE_CIV"}},
	{ISO3: "BEN", ISO2: "BJ", Name: "Bénin", Currency: "XOF", DialCode: "229",
		Providers: []string{"MTN_MOMO_BEN", "MOOV_BEN"}},
	{ISO3: "BFA", ISO2: "BF", Name: "Burkina Faso", Currency: "XOF", DialCode: "226",
		Providers: []string{"ORANGE_BFA", "MOOV_BFA"}},
	{ISO3: "MLI", ISO2: "ML", Name: "Mali", Currency: "XOF", DialCode: "223",
		Providers: []string{"ORANGE_MLI", "MOOV_MLI"}},
	{ISO3: "TGO", ISO2: "TG", Name: "Togo", Currency: "XOF", DialCode: "228",
		Providers: []string{"TOGOCOM_TGO", "MOOV_TGO"}},
	{ISO3: "CMR", ISO2: "CM", Name: "Cameroun", Currency: "XAF", DialCode: "237",
		Providers: []string{"MTN_MOMO_CMR", "ORANGE_CMR"}},
	{ISO3: "COD", ISO2: "CD", Name: "RD Congo", Currency: "CDF", DialCode: "243",
		Providers: []string{"VODACOM_MPESA_COD", "AIRTEL_COD", "ORANGE_COD"}},
	{ISO3: "GHA", ISO2: "GH", Name: "Ghana", Currency: "GHS", DialCode: "233",
		Providers: []string{"MTN_MOMO_GHA", "AIRTELTIGO_GHA", "VODAFONE_GHA"}},
	{ISO3: "NGA", ISO2: "NG", Name: "Nigeria", Currency: "NGN", DialCode: "234",
		Providers: []string{"MTN_MOMO_NGA", "AIRTEL_NGA"}},
	{ISO3: "KEN", ISO2: "KE", Name: "Kenya", Currency: "KES", DialCode: "254",
		Providers: []string{"MPESA_KEN", "AIRTEL_KEN"}},
	{ISO3: "TZA", ISO2: "TZ", Name: "Tanzanie", Currency: "TZS", DialCode: "255",
		Providers: []string{"VODACOM_MPESA_TZA", "AIRTEL_TZA", "TIGO_TZA", "HALOTEL_TZA"}},
	{ISO3: "UGA", ISO2: "UG", Name: "Ouganda", Currency: "UGX", DialCode: "256",
		Providers: []string{"MTN_MOMO_UGA", "AIRTEL_UGA"}},
	{ISO3: "RWA", ISO2: "RW", Name: "Rwanda", Currency: "RWF", DialCode: "250",
		Providers: []string{"MTN_MOMO_RWA", "AIRTEL_RWA"}},
	{ISO3: "ZMB", ISO2: "ZM", Name: "Zambie", Currency: "ZMW", DialCode: "260",
		Providers: []string{"MTN_MOMO_ZMB", "AIRTEL_OAPI_ZMB", "ZAMTEL_ZMB"}},
	{ISO3: "MWI", ISO2: "MW", Name: "Malawi", Currency: "MWK", DialCode: "265",
		Providers: []string{"AIRTEL_MWI", "TNM_MWI"}},
	{ISO3: "MOZ", ISO2: "MZ", Name: "Mozambique", Currency: "MZN", DialCode: "258",
		Providers: []string{"VODACOM_MPESA_MOZ", "MOVITEL_MOZ"}},
	{ISO3: "GAB", ISO2: "GA", Name: "Gabon", Currency: "XAF", DialCode: "241",
		Providers: []string{"AIRTEL_GAB", "MOOV_GAB"}},
	{ISO3: "SLE", ISO2: "SL", Name: "Sierra Leone", Currency: "SLE", DialCode: "232",
		Providers: []string{"ORANGE_SLE", "AFRICELL_SLE"}},
}

// pawapayFallbackRates — unités de devise locale pour 1 USD. Table
// statique fixée manuellement (source : exchangerate-api.com, relevé le
// 2026-08-27), utilisée UNIQUEMENT en secours si shipping-svc/exchange-rates
// ne connaît pas la devise. À rafraîchir périodiquement — un taux figé qui
// dérive fait sous/sur-facturer le client. shipping-svc reste la source
// préférée (éditable par l'admin sans redéploiement).
var pawapayFallbackRates = map[string]float64{
	"XOF": 568.76, "XAF": 568.76,
	"GHS": 11.58, "KES": 129.24, "NGN": 1360.25, "TZS": 2680.0,
	"UGX": 3720.0, "RWF": 1330.0, "ZMW": 26.30, "MWK": 1735.0,
	"MZN": 63.90, "CDF": 2870.0, "SLE": 22.60,
}

func findPawapayCountryByISO2(iso2 string) *pawapayCountry {
	up := strings.ToUpper(strings.TrimSpace(iso2))
	for i := range pawapayCountries {
		if pawapayCountries[i].ISO2 == up {
			return &pawapayCountries[i]
		}
	}
	return nil
}

func findPawapayCountryByISO3(iso3 string) *pawapayCountry {
	up := strings.ToUpper(strings.TrimSpace(iso3))
	for i := range pawapayCountries {
		if pawapayCountries[i].ISO3 == up {
			return &pawapayCountries[i]
		}
	}
	return nil
}

// ---------- Normalisation MSISDN ----------

var nonDigit = regexp.MustCompile(`\D`)

// normalizeMSISDN — met un numéro au format international attendu par
// PawaPay : chiffres uniquement, indicatif pays inclus, SANS le "+"
// (ex. "221771234567").
//
//   - retire tout ce qui n'est pas un chiffre ;
//   - si le numéro commence déjà par l'indicatif du pays, le garde tel quel ;
//   - sinon, retire un éventuel "0" de tête (préfixe national) puis préfixe
//     l'indicatif.
//
// EXCEPTION BÉNIN (dialCode 229) : depuis la réforme de numérotation 2021,
// le "01" initial fait partie intégrante du numéro et ne doit PAS être
// retiré comme un simple préfixe national. Ex : "01 90 01 02 03" →
// "2290190010203" (on garde le 01), surtout pas "229190010203".
func normalizeMSISDN(raw, dialCode string) string {
	digits := nonDigit.ReplaceAllString(raw, "")
	if digits == "" {
		return ""
	}
	if strings.HasPrefix(digits, dialCode) {
		return digits
	}
	// Bénin : le "01" fait partie du numéro national, on ne le retire pas.
	if dialCode == "229" {
		return dialCode + digits
	}
	digits = strings.TrimPrefix(digits, "0")
	return dialCode + digits
}

// maskMSISDN — pour les logs : ne jamais écrire le numéro complet en clair
// (check-list sécurité §8). Garde l'indicatif + 2 chiffres, masque le reste.
func maskMSISDN(msisdn string) string {
	if len(msisdn) <= 5 {
		return "***"
	}
	return msisdn[:5] + strings.Repeat("*", len(msisdn)-7) + msisdn[len(msisdn)-2:]
}

// ---------- UUID v4 (idempotence PawaPay) ----------

// newUUIDv4 — chaque opération PawaPay (deposit/payout/refund) est
// identifiée par un UUID v4 généré côté client, qui sert AUSSI de clé
// d'idempotence : renvoyer la même requête avec le même id ne crée pas de
// doublon. On le stocke dans payments.provider_ref pour pouvoir retrouver
// la ligne à la réception du webhook.
func newUUIDv4() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ---------- Client PawaPay ----------

// pawapayBaseURL — sandbox vs production. Le mode est déterminé par le
// champ settings pawapay_environment ("sandbox" par défaut), PAS déduit de
// la clé API (PawaPay ne préfixe pas ses clés comme Stripe/PayDunya).
// Bascule explicite et vérifiée vers "production" avant mise en ligne
// réelle (check-list §8).
func pawapayBaseURL(environment string) string {
	if strings.EqualFold(strings.TrimSpace(environment), "production") {
		return "https://api.pawapay.io"
	}
	return "https://api.sandbox.pawapay.io"
}

// pawapayOrderMetadata — la v2 attend un TABLEAU dont chaque élément est un
// objet {"<clé>":"<valeur>"} (une seule paire), avec un éventuel
// "isPII": true. PAS {"fieldName":...,"fieldValue":...} (ancien format v1),
// PAS un objet plat {"orderId":"abc"} (→ DUPLICATE_METADATA_FIELD).
// Exemple attendu : [{"orderId":"344"},{"customerEmail":"x@y.z","isPII":true}]
func pawapayOrderMetadata(orderID int64, reference, customerEmail string) []map[string]any {
	m := []map[string]any{
		{"orderId": strconv.FormatInt(orderID, 10)},
	}
	if reference != "" {
		m = append(m, map[string]any{"reference": reference})
	}
	if customerEmail != "" {
		m = append(m, map[string]any{"customerEmail": customerEmail, "isPII": true})
	}
	return m
}

// pawapayResolveRate — unités de devise locale pour 1 USD. shipping-svc
// d'abord (source unique éditable), table figée en secours. XOF/XAF passent
// aussi par ici : le catalogue est en USD réel, pas de parité 1:1.
func (s *server) pawapayResolveRate(ctx context.Context, currency string) (float64, error) {
	if currency == "USD" {
		return 1, nil
	}
	if rate, err := s.fetchExchangeRate(ctx, currency); err == nil && rate > 0 {
		return rate, nil
	}
	if rate, ok := pawapayFallbackRates[currency]; ok {
		slog.Warn("pawapay: taux de change via table de secours figée (shipping-svc indisponible pour cette devise)", "currency", currency, "rate", rate)
		return rate, nil
	}
	return 0, fmt.Errorf("aucun taux USD→%s (ni shipping-svc/exchange-rates ni table de secours)", currency)
}

// pawapayLocalAmount — convertit un montant USD dans la devise locale du
// pays, arrondi selon les décimales de la devise. XOF/XAF/UGX/RWF n'ont
// pas de décimales (montant entier) ; les autres en ont 2. La Payment Page
// accepte jusqu'à 3 décimales mais on suit la convention de la devise.
func pawapayLocalAmount(usd, rate float64, currency string) string {
	local := usd * rate
	switch currency {
	case "XOF", "XAF", "UGX", "RWF", "MWK", "TZS", "CDF":
		return strconv.FormatInt(int64(math.Round(local)), 10)
	default:
		return strconv.FormatFloat(math.Round(local*100)/100, 'f', 2, 64)
	}
}

// pawapayHTTP — appel authentifié à l'API PawaPay. Bearer <api key>.
func (s *server) pawapayHTTP(ctx context.Context, method, path string, body any) (int, []byte, error) {
	key := s.pawapayAPIKey
	if key == "" {
		return 0, nil, fmt.Errorf("PAWAPAY_API_KEY absente")
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(raw)
	}
	url := pawapayBaseURL(s.pawapayEnvironment) + path
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, raw, nil
}

// ---------- Deposit : Payment Page hébergée ----------

// createPawaPayPaymentPage — crée une session de page de paiement hébergée
// PawaPay (POST /v2/paymentpage) et renvoie (depositId, redirectUrl).
//
// depositId : UUID v4 généré ici, stocké en provider_ref, sert de clé
// d'idempotence ET de clé de corrélation à la réception du webhook.
// msisdn : optionnel — on transmet le téléphone de livraison du client
// (déjà saisi au checkout) comme valeur PAR DÉFAUT ; si vide ou invalide,
// on l'omet et PawaPay demande le numéro sur sa page. On ne bloque jamais
// le checkout sur un numéro mal formé côté MIAD.
// amount : fixé (le client ne peut pas le changer sur la page) → nécessite
// que `country` soit renseigné (contrainte PawaPay).
func (s *server) createPawaPayPaymentPage(ctx context.Context, ev orderCreatedEvent, buyerCountryISO2, buyerPhone, customerEmail string) (depositID, redirectURL string, err error) {
	country := findPawapayCountryByISO2(buyerCountryISO2)
	if country == nil {
		// Repli sur le Sénégal (marché par défaut) plutôt que d'échouer :
		// un client d'un pays non couvert verra la page PawaPay Sénégal et
		// pourra quand même payer depuis un numéro sénégalais, ou PawaPay
		// refusera proprement. Mieux qu'un 500 au checkout.
		country = findPawapayCountryByISO2("SN")
		slog.Warn("pawapay: pays acheteur non couvert, repli sur SN", "buyer_country", buyerCountryISO2)
	}

	rate, err := s.pawapayResolveRate(ctx, country.Currency)
	if err != nil {
		return "", "", err
	}
	amountLocal := pawapayLocalAmount(ev.TotalUSD, rate, country.Currency)

	depositID = newUUIDv4()
	front := s.storefrontURL

	// Montant : l'API sandbox /v2/paymentpage REFUSE un champ "amount" à plat
	// (UNSUPPORTED_PARAMETER, constaté en prod le 2026-08-27 — la doc "guide"
	// PawaPay montre pourtant "amount"+"country" à plat, mais c'est l'ancien
	// format v1 ; la v2 réelle attend amountDetails{amount,currency}, comme
	// l'API reference). Idem : "customerMessage" (4-22 car.) remplace
	// "statementDescription", et "phoneNumber" remplace "msisdn".
	payload := map[string]any{
		"depositId": depositID,
		// order-received résout la commande PARENT (GET /orders/parent/{id}),
		// jamais une sous-commande — même return_url que PayDunya.
		"returnUrl": front + "/order-received?order_id=" + strconv.FormatInt(redirectOrderID(ev), 10) + "&provider=pawapay",
		"amountDetails": map[string]any{
			"amount":   amountLocal,
			"currency": country.Currency,
		},
		"country":         country.ISO3,
		"reason":          "Commande MIAD " + ev.Reference,
		"language":        "FR",
		"customerMessage": pawapayStatementDescription(ev.Reference),
		"metadata":        pawapayOrderMetadata(redirectOrderID(ev), ev.Reference, customerEmail),
	}
	if msisdn := normalizeMSISDN(buyerPhone, country.DialCode); len(msisdn) >= 8 {
		payload["phoneNumber"] = msisdn
	}

	status, raw, err := s.pawapayHTTP(ctx, http.MethodPost, "/v2/paymentpage", payload)
	if err != nil {
		return "", "", err
	}
	if status != http.StatusOK && status != http.StatusCreated {
		return "", "", fmt.Errorf("PawaPay a refusé la création de la page (%d): %s", status, strings.TrimSpace(string(raw)))
	}
	var doc struct {
		RedirectURL string `json:"redirectUrl"`
		DepositID   string `json:"depositId"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", "", err
	}
	if doc.RedirectURL == "" {
		return "", "", fmt.Errorf("PawaPay: redirectUrl vide dans la réponse (%s)", strings.TrimSpace(string(raw)))
	}
	return depositID, doc.RedirectURL, nil
}

// pawapayStatementDescription — 4 à 22 caractères alphanumériques, apparaît
// sur le relevé mobile money du client. On part de la référence de commande
// en retirant tout caractère non alphanumérique et en bornant la longueur.
func pawapayStatementDescription(reference string) string {
	clean := regexp.MustCompile(`[^A-Za-z0-9]`).ReplaceAllString(reference, "")
	if clean == "" {
		clean = "MIAD"
	}
	if len(clean) > 22 {
		clean = clean[:22]
	}
	for len(clean) < 4 {
		clean += "0"
	}
	return clean
}

// ---------- Statuts (GET) — source de vérité après webhook ----------

// pawapayDepositStatus — GET /v2/deposits/{id}. Statuts possibles :
// ACCEPTED, PROCESSING, IN_RECONCILIATION (transitoires), COMPLETED,
// FAILED (finaux). "NOT_FOUND" au niveau enveloppe = deposit jamais
// parvenu à PawaPay (page expirée / abandon).
func (s *server) pawapayDepositStatus(ctx context.Context, depositID string) (status, failureCode string, err error) {
	code, raw, err := s.pawapayHTTP(ctx, http.MethodGet, "/v2/deposits/"+depositID, nil)
	if err != nil {
		return "", "", err
	}
	if code != http.StatusOK {
		return "", "", fmt.Errorf("PawaPay GET deposit (%d): %s", code, strings.TrimSpace(string(raw)))
	}
	var doc struct {
		Status string `json:"status"` // FOUND | NOT_FOUND
		Data   struct {
			Status        string `json:"status"`
			FailureReason struct {
				FailureCode string `json:"failureCode"`
			} `json:"failureReason"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", "", err
	}
	if doc.Status == "NOT_FOUND" {
		return "NOT_FOUND", "", nil
	}
	return doc.Data.Status, doc.Data.FailureReason.FailureCode, nil
}

// pawapayPayoutStatus — GET /v2/payouts/{id}. Statuts : ACCEPTED,
// ENQUEUED, PROCESSING, IN_RECONCILIATION (transitoires), COMPLETED,
// FAILED (finaux).
func (s *server) pawapayPayoutStatus(ctx context.Context, payoutID string) (status, failureCode string, err error) {
	code, raw, err := s.pawapayHTTP(ctx, http.MethodGet, "/v2/payouts/"+payoutID, nil)
	if err != nil {
		return "", "", err
	}
	if code != http.StatusOK {
		return "", "", fmt.Errorf("PawaPay GET payout (%d): %s", code, strings.TrimSpace(string(raw)))
	}
	var doc struct {
		Status string `json:"status"`
		Data   struct {
			Status        string `json:"status"`
			FailureReason struct {
				FailureCode string `json:"failureCode"`
			} `json:"failureReason"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", "", err
	}
	if doc.Status == "NOT_FOUND" {
		return "NOT_FOUND", "", nil
	}
	return doc.Data.Status, doc.Data.FailureReason.FailureCode, nil
}

// ---------- Payout : versement sortant vers un vendeur ----------

// createPawaPayPayout — POST /v2/payouts. Contrairement au deposit, pas de
// page hébergée : on fournit directement le MSISDN du bénéficiaire.
// Renvoie (payoutId, statutInitial). Statut initial ACCEPTED/ENQUEUED =
// pris en charge ; REJECTED = refus immédiat (rejectionReason dans err) ;
// DUPLICATE_IGNORED = payoutId déjà vu (idempotence).
//
// recipientCountryISO2 / recipientPhone : renseignés par l'admin au moment
// d'approuver la demande de retrait (payout_requests.method contient déjà
// un champ libre "méthode" ; on ajoute pays + numéro).
func (s *server) createPawaPayPayout(ctx context.Context, payoutRequestID, vendorID int64, amountUSD float64, recipientCountryISO2, recipientPhone string) (payoutID, initialStatus string, err error) {
	country := findPawapayCountryByISO2(recipientCountryISO2)
	if country == nil {
		return "", "", fmt.Errorf("pays bénéficiaire %q non couvert par PawaPay", recipientCountryISO2)
	}
	msisdn := normalizeMSISDN(recipientPhone, country.DialCode)
	if len(msisdn) < 8 {
		return "", "", fmt.Errorf("numéro bénéficiaire invalide après normalisation")
	}
	rate, err := s.pawapayResolveRate(ctx, country.Currency)
	if err != nil {
		return "", "", err
	}
	amountLocal := pawapayLocalAmount(amountUSD, rate, country.Currency)

	payoutID = newUUIDv4()
	// v2 /payouts : amountDetails{amount,currency}, recipient de type "MMO"
	// avec accountDetails{phoneNumber,provider} (aligné sur GET /v2/payouts
	// et le format deposit). customerMessage 4-22 car.
	payload := map[string]any{
		"payoutId": payoutID,
		"amountDetails": map[string]any{
			"amount":   amountLocal,
			"currency": country.Currency,
		},
		"country": country.ISO3,
		"recipient": map[string]any{
			"type": "MMO",
			"accountDetails": map[string]any{
				"phoneNumber": msisdn,
				"provider":    firstProvider(country),
			},
		},
		"customerMessage": pawapayStatementDescription(fmt.Sprintf("MIADPO%d", payoutRequestID)),
		"metadata": []map[string]any{
			{"payoutRequestId": strconv.FormatInt(payoutRequestID, 10)},
			{"vendorId": strconv.FormatInt(vendorID, 10)},
		},
	}

	status, raw, err := s.pawapayHTTP(ctx, http.MethodPost, "/v2/payouts", payload)
	if err != nil {
		return "", "", err
	}
	if status != http.StatusOK && status != http.StatusCreated {
		return "", "", fmt.Errorf("PawaPay a refusé le payout (%d): %s", status, strings.TrimSpace(string(raw)))
	}
	var doc struct {
		PayoutID        string `json:"payoutId"`
		Status          string `json:"status"`
		RejectionReason struct {
			RejectionCode string `json:"rejectionCode"`
		} `json:"rejectionReason"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", "", err
	}
	if doc.Status == "REJECTED" {
		return payoutID, "REJECTED", fmt.Errorf("PawaPay a rejeté le payout: %s", doc.RejectionReason.RejectionCode)
	}
	return payoutID, doc.Status, nil
}

// firstProvider — correspondent par défaut pour un payout : premier
// opérateur listé du pays. En pratique l'admin devrait choisir, mais pour
// un premier jet on prend le principal (MTN/Orange/M-Pesa selon le pays).
// PawaPay valide le couple (numéro, correspondent) et rejette si incohérent.
func firstProvider(c *pawapayCountry) string {
	if len(c.Providers) > 0 {
		return c.Providers[0]
	}
	return ""
}

// ---------- Refund : remboursement d'un deposit ----------

// createPawaPayRefund — POST /refunds (v1, pas /v2 — l'endpoint refund n'a
// pas de variante v2 documentée au 2026-08-27). Rembourse tout ou partie
// d'un deposit COMPLETED, référencé par son depositId. Idempotent sur
// refundId. Renvoie (refundId, statut) : ACCEPTED | REJECTED |
// DUPLICATE_IGNORED.
func (s *server) createPawaPayRefund(ctx context.Context, depositID string, amountLocal string) (refundID, status string, err error) {
	refundID = newUUIDv4()
	payload := map[string]any{
		"refundId":  refundID,
		"depositId": depositID,
	}
	if amountLocal != "" {
		payload["amount"] = amountLocal // omis = remboursement total
	}
	code, raw, err := s.pawapayHTTP(ctx, http.MethodPost, "/refunds", payload)
	if err != nil {
		return "", "", err
	}
	if code != http.StatusOK && code != http.StatusCreated {
		return "", "", fmt.Errorf("PawaPay a refusé le refund (%d): %s", code, strings.TrimSpace(string(raw)))
	}
	var doc struct {
		RefundID        string `json:"refundId"`
		Status          string `json:"status"`
		RejectionReason struct {
			RejectionCode string `json:"rejectionCode"`
		} `json:"rejectionReason"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", "", err
	}
	if doc.Status == "REJECTED" {
		return refundID, "REJECTED", fmt.Errorf("PawaPay a rejeté le refund: %s", doc.RejectionReason.RejectionCode)
	}
	return refundID, doc.Status, nil
}

// pawapayRefundStatus — GET /refunds/{id}.
func (s *server) pawapayRefundStatus(ctx context.Context, refundID string) (status string, err error) {
	code, raw, err := s.pawapayHTTP(ctx, http.MethodGet, "/refunds/"+refundID, nil)
	if err != nil {
		return "", err
	}
	if code != http.StatusOK {
		return "", fmt.Errorf("PawaPay GET refund (%d): %s", code, strings.TrimSpace(string(raw)))
	}
	var doc struct {
		Status string `json:"status"`
		Data   struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", err
	}
	if doc.Data.Status != "" {
		return doc.Data.Status, nil
	}
	return doc.Status, nil
}

// pawapayIsFinalSuccess / pawapayIsFinalFailure — mappe les statuts PawaPay
// vers la logique interne confirmPayment/markFailed. Les statuts
// transitoires (ACCEPTED/PROCESSING/IN_RECONCILIATION/ENQUEUED) ne
// déclenchent NI l'un NI l'autre — on attend un webhook ultérieur ou un
// nouveau polling.
func pawapayIsFinalSuccess(status string) bool { return status == "COMPLETED" }
func pawapayIsFinalFailure(status string) bool {
	return status == "FAILED" || status == "NOT_FOUND" || status == "REJECTED"
}

// ---------- Deposit SANS redirection (2026-08-28) ----------
//
// Alternative à createPawaPayPaymentPage ci-dessus : le client reste sur
// notre propre page checkout (numéro + opérateur saisis chez nous), au
// lieu d'être envoyé sur une page PawaPay. Voir le plan
// pawapay-sans-redirection.md pour le contexte complet — en résumé :
// certains opérateurs (authType=REDIRECT_AUTH) exigent quand même une
// redirection côté PawaPay, gérée de façon transparente par
// initiateMobileMoneyDeposit ci-dessous (le client ne voit qu'un seul
// endpoint, la bascule se fait en interne).

// pawapayActiveProvider — un opérateur mobile money tel que renvoyé par
// GET /v2/active-conf, avec son authType (détermine si le flux direct
// est possible pour cet opérateur précis).
//
// Structure RÉELLE de l'API (constatée le 2026-08-28 par appel direct —
// la doc "guide" avait déjà induit en erreur une fois sur cet endpoint,
// voir createPawaPayPaymentPage) : authType n'est PAS un champ plat du
// provider, il est niché sous providers[].currencies[].operationTypes.
// DEPOSIT.authType — un provider a potentiellement plusieurs devises,
// chacune avec son propre authType (rare en pratique mais possible). On
// prend le authType de la PREMIÈRE devise trouvée : dans les faits, un
// provider PawaPay n'opère que dans une seule devise par pays.
type pawapayActiveProvider struct {
	Provider string `json:"provider"`
	AuthType string `json:"authType"` // PROVIDER_AUTH | PREAUTH | REDIRECT_AUTH
}

type pawapayActiveCountry struct {
	Country   string `json:"country"` // ISO3
	Providers []struct {
		Provider   string `json:"provider"`
		Currencies []struct {
			OperationTypes struct {
				Deposit struct {
					AuthType string `json:"authType"`
				} `json:"DEPOSIT"`
			} `json:"operationTypes"`
		} `json:"currencies"`
	} `json:"providers"`
}

// pawapayActiveConfig — GET /v2/active-conf, mis en cache process-local
// 1h (config quasi statique, évite un appel réseau à chaque affichage du
// sélecteur checkout). Remplace à terme pawapayCountries (codé en dur,
// gardé comme repli si l'appel échoue — voir activeConfigCache ci-dessous).
var (
	activeConfigCache     map[string][]pawapayActiveProvider // clé = ISO3
	activeConfigCacheAt   time.Time
	activeConfigCacheLock sync.Mutex
)

func (s *server) pawapayActiveConfig(ctx context.Context) (map[string][]pawapayActiveProvider, error) {
	activeConfigCacheLock.Lock()
	defer activeConfigCacheLock.Unlock()
	if activeConfigCache != nil && time.Since(activeConfigCacheAt) < time.Hour {
		return activeConfigCache, nil
	}
	code, raw, err := s.pawapayHTTP(ctx, http.MethodGet, "/v2/active-conf?operationType=DEPOSIT", nil)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("PawaPay GET active-conf (%d): %s", code, strings.TrimSpace(string(raw)))
	}
	var doc struct {
		Countries []pawapayActiveCountry `json:"countries"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	byCountry := make(map[string][]pawapayActiveProvider)
	for _, c := range doc.Countries {
		for _, p := range c.Providers {
			authType := ""
			if len(p.Currencies) > 0 {
				authType = p.Currencies[0].OperationTypes.Deposit.AuthType
			}
			byCountry[c.Country] = append(byCountry[c.Country], pawapayActiveProvider{
				Provider: p.Provider,
				AuthType: authType,
			})
		}
	}
	activeConfigCache = byCountry
	activeConfigCacheAt = time.Now()
	return byCountry, nil
}

// providerAuthType — cherche l'authType d'un provider précis dans la
// config active ; "" (inconnu) si l'appel /v2/active-conf a échoué ou si
// le provider n'y figure pas — dans ce cas, initiateMobileMoneyDeposit
// retombe prudemment sur la Payment Page (comportement déjà éprouvé)
// plutôt que de tenter un dépôt direct à l'aveugle.
func providerAuthType(cfg map[string][]pawapayActiveProvider, countryISO3, provider string) string {
	for _, p := range cfg[countryISO3] {
		if p.Provider == provider {
			return p.AuthType
		}
	}
	return ""
}

// initiateMobileMoneyDeposit — point d'entrée unique appelé par le
// checkout (POST /payments/mobile-money/deposit), agrégateur-agnostique
// dans son contrat (order_id, country, provider, phone) même si seul
// PawaPay est branché aujourd'hui. Route en interne :
//   - authType REDIRECT_AUTH, ou config active indisponible → Payment
//     Page hébergée (redirectUrl renvoyé, le frontend redirige le client)
//   - PROVIDER_AUTH / PREAUTH → dépôt direct /v2/deposits (pas de
//     redirectUrl, le frontend passe en polling GET .../status)
func (s *server) initiateMobileMoneyDeposit(ctx context.Context, ev orderCreatedEvent, countryISO2, provider, phoneRaw, customerEmail string) (depositID, redirectURL string, err error) {
	country := findPawapayCountryByISO2(countryISO2)
	if country == nil {
		return "", "", fmt.Errorf("pays non couvert par PawaPay: %s", countryISO2)
	}
	cfg, cfgErr := s.pawapayActiveConfig(ctx)
	authType := ""
	if cfgErr == nil {
		authType = providerAuthType(cfg, country.ISO3, provider)
	} else {
		slog.Warn("initiateMobileMoneyDeposit: /v2/active-conf indisponible, repli Payment Page", "provider", provider, "err", cfgErr)
	}
	if authType == "REDIRECT_AUTH" || authType == "" {
		// Repli Payment Page — soit l'opérateur l'exige, soit on ne sait
		// pas (config indisponible) : mieux vaut le flux éprouvé qu'un
		// dépôt direct à l'aveugle sur un opérateur mal supporté.
		return s.createPawaPayPaymentPage(ctx, ev, countryISO2, phoneRaw, customerEmail)
	}

	phone := normalizeMSISDN(phoneRaw, country.DialCode)
	if phone == "" {
		return "", "", fmt.Errorf("numéro de téléphone invalide")
	}
	rate, err := s.pawapayResolveRate(ctx, country.Currency)
	if err != nil {
		return "", "", err
	}
	amount := pawapayLocalAmount(ev.TotalUSD, rate, country.Currency)
	depositID = newUUIDv4()

	payload := map[string]any{
		"depositId": depositID,
		"payer": map[string]any{
			"type": "MMO",
			"accountDetails": map[string]any{
				"phoneNumber": phone,
				"provider":    provider,
			},
		},
		"amount":          amount,
		"currency":        country.Currency,
		"customerMessage": pawapayStatementDescription(ev.Reference),
		"metadata":        pawapayOrderMetadata(redirectOrderID(ev), ev.Reference, customerEmail),
	}
	code, raw, err := s.pawapayHTTP(ctx, http.MethodPost, "/v2/deposits", payload)
	if err != nil {
		return "", "", err
	}
	var resp struct {
		Status        string `json:"status"`
		FailureReason struct {
			FailureMessage string `json:"failureMessage"`
		} `json:"failureReason"`
	}
	_ = json.Unmarshal(raw, &resp)
	if code != http.StatusOK || (resp.Status != "ACCEPTED" && resp.Status != "DUPLICATE_IGNORED") {
		msg := resp.FailureReason.FailureMessage
		if msg == "" {
			msg = strings.TrimSpace(string(raw))
		}
		return "", "", fmt.Errorf("PawaPay a refusé le dépôt (%d, %s): %s", code, resp.Status, msg)
	}
	return depositID, "", nil // pas de redirectUrl : le frontend passe en polling
}

// ============================================================
// paydunya-softpay.go — PayDunya SoftPay (paiement mobile money SANS
// redirection, 2026-08-28).
//
// Contrairement à PawaPay (schéma de requête uniforme, voir pawapay.go),
// chaque opérateur SoftPay a ses PROPRES noms de champs JSON — pas de
// format commun. Doc complète obtenue directement du fondateur (compte
// développeur PayDunya) le 2026-08-28 — voir le plan
// pawapay-sans-redirection.md section 9 pour le détail par opérateur.
//
// Flux en 2 étapes (3 pour Wizall) :
//  1. POST /api/v1/checkout-invoice/create — DÉJÀ fait par
//     createPayDunyaInvoice (main.go), réutilisé tel quel.
//  2. POST /api/v1/softpay/<endpoint> avec les champs propres à
//     l'opérateur + le token de l'étape 1.
//
// Trois comportements de réponse possibles (behavior ci-dessous) :
//   - "sync"     : success=true = payé, fin immédiate (Wizall confirm,
//     MTN CI, Moov CI, T-Money Togo, Celtiis Cash...).
//   - "pending"  : success=true = demande acceptée, PAS payé — client
//     doit encore agir sur son téléphone (composer un code,
//     confirmer SMS...). Polling/webhook IPN nécessaire.
//   - "redirect" : réponse contient "url", redirection classique comme
//     l'ancien flux (Wave, Djamo, Orange Money CI en QR).
//
// "PAYDUNYA" (compte direct email+mot de passe du client) volontairement
// ABSENT de ce fichier — pas un opérateur mobile money, exclu du
// sélecteur checkout (décision fondateur 2026-08-28).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/miadmarket/miad-backend/internal/kit"
)

type paydunyaSoftpayBehavior string

const (
	softpayBehaviorSync     paydunyaSoftpayBehavior = "sync"
	softpayBehaviorPending  paydunyaSoftpayBehavior = "pending"
	softpayBehaviorRedirect paydunyaSoftpayBehavior = "redirect"
)

// paydunyaSoftpayProvider — un opérateur PayDunya SoftPay : son endpoint,
// le nom exact de chaque champ attendu (varie par opérateur, voir
// buildFields), et son comportement de réponse.
type paydunyaSoftpayProvider struct {
	Code           string // identifiant interne MIAD, ex. "ORANGE_SN"
	CountryISO2    string
	Label          string
	Endpoint       string // suffixe après /api/v1/softpay/
	Behavior       paydunyaSoftpayBehavior
	TokenField     string // "invoice_token" ou "payment_token" selon l'opérateur
	RequiresOTP    bool   // Orange Money CI : le client doit composer un code USSD AVANT l'appel
	OTPInstruction string
	// buildFields — construit le corps JSON spécifique à cet opérateur à
	// partir des valeurs communes (nom, email, téléphone, token, OTP
	// éventuel). Isolé par opérateur car AUCUN nom de champ n'est partagé
	// entre eux (voir doc en tête de fichier).
	buildFields func(name, email, phone, token, otp string) map[string]any
}

var paydunyaSoftpayProviders = []paydunyaSoftpayProvider{
	{
		Code: "ORANGE_SN", CountryISO2: "SN", Label: "Orange Money", Endpoint: "new-orange-money-senegal",
		Behavior: softpayBehaviorRedirect, TokenField: "invoice_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"customer_name": name, "customer_email": email, "phone_number": phone, "invoice_token": token}
		},
	},
	{
		Code: "FREE_SN", CountryISO2: "SN", Label: "Free Money", Endpoint: "free-money-senegal",
		Behavior: softpayBehaviorPending, TokenField: "payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"customer_name": name, "customer_email": email, "phone_number": phone, "payment_token": token}
		},
	},
	{
		Code: "EXPRESSO_SN", CountryISO2: "SN", Label: "Expresso", Endpoint: "expresso-senegal",
		Behavior: softpayBehaviorPending, TokenField: "payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"expresso_sn_fullName": name, "expresso_sn_email": email, "expresso_sn_phone": phone, "payment_token": token}
		},
	},
	{
		Code: "WAVE_SN", CountryISO2: "SN", Label: "Wave", Endpoint: "wave-senegal",
		Behavior: softpayBehaviorRedirect, TokenField: "wave_senegal_payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"wave_senegal_fullName": name, "wave_senegal_email": email, "wave_senegal_phone": phone, "wave_senegal_payment_token": token}
		},
	},
	{
		// Wizall — flux à 3 étapes : cet appel initial renvoie un
		// TransactionID (pas un statut final), voir
		// initiateWizallConfirm pour la 2e étape (OTP reçu par SMS).
		Code: "WIZALL_SN", CountryISO2: "SN", Label: "Wizall", Endpoint: "wizall-money-senegal",
		Behavior: softpayBehaviorPending, TokenField: "invoice_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"customer_name": name, "customer_email": email, "phone_number": phone, "invoice_token": token}
		},
	},
	{
		Code: "DJAMO_SN", CountryISO2: "SN", Label: "Djamo", Endpoint: "djamo",
		Behavior: softpayBehaviorRedirect, TokenField: "djamo_payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"djamo_fullName": name, "djamo_email": email, "djamo_phone": phone, "code_country": "sn", "djamo_payment_token": token}
		},
	},
	{
		// Orange Money CI — le client doit composer #144*82# option 2
		// AVANT cet appel pour obtenir orange_money_ci_otp. UI doit
		// afficher cette instruction avant le formulaire (RequiresOTP).
		Code: "ORANGE_CI", CountryISO2: "CI", Label: "Orange Money", Endpoint: "orange-money-ci",
		Behavior: softpayBehaviorSync, TokenField: "payment_token", RequiresOTP: true,
		OTPInstruction: "Composez #144*82# puis choisissez l'option 2 sur votre téléphone pour obtenir votre code.",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"orange_money_ci_customer_fullname": name, "orange_money_ci_email": email, "orange_money_ci_phone_number": phone, "orange_money_ci_otp": otp, "payment_token": token}
		},
	},
	{
		Code: "MTN_CI", CountryISO2: "CI", Label: "MTN MoMo", Endpoint: "mtn-ci",
		Behavior: softpayBehaviorSync, TokenField: "payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"mtn_ci_customer_fullname": name, "mtn_ci_email": email, "mtn_ci_phone_number": phone, "mtn_ci_wallet_provider": "MTNCI", "payment_token": token}
		},
	},
	{
		Code: "MOOV_CI", CountryISO2: "CI", Label: "Moov Money", Endpoint: "moov-ci",
		Behavior: softpayBehaviorSync, TokenField: "payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"moov_ci_customer_fullname": name, "moov_ci_email": email, "moov_ci_phone_number": phone, "payment_token": token}
		},
	},
	{
		Code: "WAVE_CI", CountryISO2: "CI", Label: "Wave", Endpoint: "wave-ci",
		Behavior: softpayBehaviorRedirect, TokenField: "wave_ci_payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"wave_ci_fullName": name, "wave_ci_email": email, "wave_ci_phone": phone, "wave_ci_payment_token": token}
		},
	},
	{
		Code: "DJAMO_CI", CountryISO2: "CI", Label: "Djamo", Endpoint: "djamo",
		Behavior: softpayBehaviorRedirect, TokenField: "djamo_payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"djamo_fullName": name, "djamo_email": email, "djamo_phone": phone, "code_country": "ci", "djamo_payment_token": token}
		},
	},
	{
		Code: "ORANGE_BF", CountryISO2: "BF", Label: "Orange Money", Endpoint: "orange-money-burkina",
		Behavior: softpayBehaviorSync, TokenField: "payment_token", RequiresOTP: true,
		OTPInstruction: "Un code de confirmation Orange Money vous sera envoyé par SMS.",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"name_bf": name, "email_bf": email, "phone_bf": phone, "otp_code": otp, "payment_token": token}
		},
	},
	{
		Code: "MOOV_BF", CountryISO2: "BF", Label: "Moov Money", Endpoint: "moov-burkina",
		Behavior: softpayBehaviorPending, TokenField: "moov_burkina_faso_payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"moov_burkina_faso_fullName": name, "moov_burkina_faso_email": email, "moov_burkina_faso_phone_number": phone, "moov_burkina_faso_payment_token": token}
		},
	},
	{
		Code: "MOOV_BJ", CountryISO2: "BJ", Label: "Moov Money", Endpoint: "moov-benin",
		Behavior: softpayBehaviorSync, TokenField: "payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"moov_benin_customer_fullname": name, "moov_benin_email": email, "moov_benin_phone_number": phone, "payment_token": token}
		},
	},
	{
		Code: "MTN_BJ", CountryISO2: "BJ", Label: "MTN MoMo", Endpoint: "mtn-benin",
		Behavior: softpayBehaviorPending, TokenField: "payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"mtn_benin_customer_fullname": name, "mtn_benin_email": email, "mtn_benin_phone_number": phone, "mtn_benin_wallet_provider": "MTNBENIN", "payment_token": token}
		},
	},
	{
		Code: "TMONEY_TG", CountryISO2: "TG", Label: "T-Money", Endpoint: "t-money-togo",
		Behavior: softpayBehaviorPending, TokenField: "payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"name_t_money": name, "email_t_money": email, "phone_t_money": phone, "payment_token": token}
		},
	},
	{
		Code: "MOOV_TG", CountryISO2: "TG", Label: "Moov Money", Endpoint: "moov-togo",
		Behavior: softpayBehaviorSync, TokenField: "payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"moov_togo_customer_fullname": name, "moov_togo_email": email, "moov_togo_customer_address": "", "moov_togo_phone_number": phone, "payment_token": token}
		},
	},
	{
		Code: "ORANGE_ML", CountryISO2: "ML", Label: "Orange Money", Endpoint: "orange-money-mali",
		Behavior: softpayBehaviorPending, TokenField: "payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"orange_money_mali_customer_fullname": name, "orange_money_mali_email": email, "orange_money_mali_phone_number": phone, "orange_money_mali_customer_address": "", "payment_token": token}
		},
	},
	{
		Code: "MOOV_ML", CountryISO2: "ML", Label: "Moov Money", Endpoint: "moov-mali",
		Behavior: softpayBehaviorPending, TokenField: "payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"moov_ml_customer_fullname": name, "moov_ml_email": email, "moov_ml_phone_number": phone, "moov_ml_customer_address": "", "payment_token": token}
		},
	},
	{
		Code: "MTN_CM", CountryISO2: "CM", Label: "MTN MoMo", Endpoint: "mtn-cameroun",
		Behavior: softpayBehaviorPending, TokenField: "payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"mtn_cameroun_customer_fullname": name, "mtn_cameroun_email": email, "mtn_cameroun_phone_number": phone, "mtn_cameroun_wallet_provider": "MTNCAMEROUN", "payment_token": token}
		},
	},
	{
		Code: "CELTIIS_BJ", CountryISO2: "BJ", Label: "Celtiis Cash", Endpoint: "celtiis-cash",
		Behavior: softpayBehaviorSync, TokenField: "payment_token",
		buildFields: func(name, email, phone, token, otp string) map[string]any {
			return map[string]any{"celtiis_cash_customer_fullname": name, "celtiis_cash_customer_email": email, "celtiis_cash_phone_number": phone, "payment_token": token}
		},
	},
}

// paydunyaAPIPrefix — même logique que createPayDunyaInvoice (main.go) :
// PayDunya a deux préfixes distincts pour test/prod (pas déduits de
// l'URL de base seule), déterminé par le préfixe test_ sur la clé
// privée. Dupliqué ici plutôt qu'exporté depuis main.go pour garder
// paydunya-softpay.go indépendant — même package, donc appel direct
// possible, mais la duplication rend explicite que les deux call sites
// doivent rester cohérents si PayDunya change son schéma un jour.
func paydunyaAPIPrefix(privateKey string) string {
	if strings.HasPrefix(privateKey, "test_") {
		return "/sandbox-api/v1"
	}
	return "/api/v1"
}

// listPaydunyaSoftpayProviders — GET /paydunya/softpay-providers, même
// rôle que listPawapayCountries pour l'autre agrégateur : le checkout
// (MobileMoneyDirectForm.tsx) l'utilise pour construire son sélecteur.
// Pas de config "active" distante à interroger côté PayDunya (contraste
// avec /v2/active-conf de PawaPay) — cette liste EST la source de
// vérité, câblée en dur depuis la doc officielle du 2026-08-28.
func (s *server) listPaydunyaSoftpayProviders(w http.ResponseWriter, r *http.Request) {
	out := make([]map[string]any, 0, len(paydunyaSoftpayProviders))
	for _, p := range paydunyaSoftpayProviders {
		out = append(out, map[string]any{
			"code": p.Code, "country_iso2": p.CountryISO2, "label": p.Label,
			"behavior": string(p.Behavior), "requires_otp": p.RequiresOTP,
			"otp_instruction": p.OTPInstruction,
		})
	}
	kit.JSON(w, 200, map[string]any{"providers": out})
}

func findPaydunyaSoftpayProvider(code string) *paydunyaSoftpayProvider {
	for i := range paydunyaSoftpayProviders {
		if paydunyaSoftpayProviders[i].Code == code {
			return &paydunyaSoftpayProviders[i]
		}
	}
	return nil
}

// paydunyaSoftpayResult — normalise les 3 comportements de réponse
// possibles (sync/pending/redirect) vers une forme unique exploitable
// par l'appelant, quel que soit l'opérateur.
type paydunyaSoftpayResult struct {
	Success     bool
	Message     string
	RedirectURL string // non vide seulement si Behavior == redirect et succès
	WizallTxID  string // non vide seulement pour WIZALL_SN (2e étape requise)
}

// initiateSoftpayDeposit — appelle POST /api/v1/softpay/<endpoint> pour
// l'opérateur demandé. invoiceToken vient d'un createPayDunyaInvoice déjà
// exécuté (même étape 1 que l'ancien flux, réutilisée telle quelle).
func (s *server) initiateSoftpayDeposit(ctx context.Context, providerCode, name, email, phone, invoiceToken, otp string) (*paydunyaSoftpayResult, error) {
	p := findPaydunyaSoftpayProvider(providerCode)
	if p == nil {
		return nil, fmt.Errorf("opérateur PayDunya SoftPay inconnu: %s", providerCode)
	}
	if p.RequiresOTP && otp == "" {
		return nil, fmt.Errorf("code de confirmation requis pour %s", p.Label)
	}

	fields := p.buildFields(name, email, phone, invoiceToken, otp)
	raw, _ := json.Marshal(fields)
	url := s.paydunyaAPIBase + paydunyaAPIPrefix(s.paydunyaAPIKeyPrivate) + "/softpay/" + p.Endpoint
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("PAYDUNYA-MASTER-KEY", s.paydunyaMasterKey)
	req.Header.Set("PAYDUNYA-PRIVATE-KEY", s.paydunyaAPIKeyPrivate)
	req.Header.Set("PAYDUNYA-TOKEN", s.paydunyaToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("PayDunya SoftPay injoignable: %w", err)
	}
	defer resp.Body.Close()
	respRaw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	var doc struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		URL     string `json:"url"`
		Data    struct {
			TransactionID string `json:"TransactionID"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respRaw, &doc); err != nil {
		return nil, fmt.Errorf("réponse PayDunya SoftPay illisible (%d): %s", resp.StatusCode, strings.TrimSpace(string(respRaw)))
	}
	return &paydunyaSoftpayResult{
		Success:     doc.Success,
		Message:     doc.Message,
		RedirectURL: doc.URL,
		WizallTxID:  doc.Data.TransactionID,
	}, nil
}

// confirmWizallDeposit — 2e étape spécifique à Wizall (OTP reçu par SMS
// après initiateSoftpayDeposit ci-dessus). Aucun autre opérateur SoftPay
// n'a ce flux à 3 étapes.
func (s *server) confirmWizallDeposit(ctx context.Context, phone, transactionID, authCode string) (*paydunyaSoftpayResult, error) {
	fields := map[string]any{
		"authorization_code": authCode,
		"phone_number":       phone,
		"transaction_id":     transactionID,
	}
	raw, _ := json.Marshal(fields)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.paydunyaAPIBase+paydunyaAPIPrefix(s.paydunyaAPIKeyPrivate)+"/softpay/wizall-money-senegal/confirm", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("PAYDUNYA-MASTER-KEY", s.paydunyaMasterKey)
	req.Header.Set("PAYDUNYA-PRIVATE-KEY", s.paydunyaAPIKeyPrivate)
	req.Header.Set("PAYDUNYA-TOKEN", s.paydunyaToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("PayDunya Wizall confirm injoignable: %w", err)
	}
	defer resp.Body.Close()
	respRaw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var doc struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(respRaw, &doc); err != nil {
		return nil, fmt.Errorf("réponse PayDunya Wizall confirm illisible (%d): %s", resp.StatusCode, strings.TrimSpace(string(respRaw)))
	}
	return &paydunyaSoftpayResult{Success: doc.Success, Message: doc.Message}, nil
}

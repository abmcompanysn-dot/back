// ============================================================
// payment-svc — Stripe (carte, PaymentIntent + Elements EMBARQUÉ,
// PAS de redirection Checkout — le frontend affiche son propre
// formulaire de carte) + PayDunya (Wave, Orange Money, redirection).
// Consomme order.created → pré-crée le paiement PayDunya (asynchrone,
// redirection de toute façon). Pour Stripe : POST /payments/init est
// SYNCHRONE et crée le PaymentIntent à la demande — le frontend en a
// besoin immédiatement pour afficher Stripe Elements, il ne peut pas
// attendre un aller-retour Kafka.
// Publie payment.confirmed / payment.failed.
// payments.order_id : référence logique, jamais de FK SQL.
// ============================================================
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/IBM/sarama"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stripe/stripe-go/v82/webhook"

	"github.com/miadmarket/miad-backend/internal/kit"
)

const schema = `
CREATE TABLE IF NOT EXISTS payments (
  id           BIGSERIAL PRIMARY KEY,
  -- order_id stocke le PARENT_ORDER_ID (commande groupée), pas l'id d'une
  -- sous-commande vendeur — changé le 2026-08-26 : un client ne doit payer
  -- qu'UNE FOIS pour toute sa commande, peu importe le nombre de boutiques
  -- dedans (auparavant : une facture Stripe/PayDunya PAR sous-commande,
  -- jamais vraiment utilisable — le frontend ne payait/attendait de toute
  -- façon que payments[0], les autres sous-commandes restaient orphelines
  -- en pending_payment indéfiniment). La répartition par vendeur reste
  -- intacte : confirmParentPayment (order-svc) boucle sur les sous-
  -- commandes à la confirmation, et creditVendorWallet (plus bas) est
  -- toujours appelé une fois par sous-commande avec SON propre montant.
  order_id     BIGINT NOT NULL,
  provider     TEXT NOT NULL CHECK (provider IN ('stripe','paydunya','pawapay')),
  provider_ref TEXT DEFAULT '', -- Stripe: pi_... | PayDunya: token facture | PawaPay: depositId (UUID v4, aussi clé d'idempotence + corrélation webhook)
  client_secret TEXT DEFAULT '', -- Stripe PaymentIntent uniquement (Elements embarqué) ; jamais rempli pour PayDunya/PawaPay
  redirect_url TEXT DEFAULT '', -- PayDunya (URL facture) ET PawaPay (URL Payment Page hébergée) ; jamais rempli pour Stripe
  amount_usd   DOUBLE PRECISION NOT NULL DEFAULT 0, -- USD réel (voir catalog-svc) ; converti en XOF uniquement à l'appel PayDunya
  currency     TEXT NOT NULL DEFAULT 'USD',
  status       TEXT NOT NULL DEFAULT 'initiated',
  method       TEXT DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments (provider_ref);

-- Wallet vendeur (module Finances/Vendeurs) : solde dû, ledger des
-- mouvements, demandes de retrait. Posé ici plutôt que vendor-svc car
-- payment-svc gère déjà toutes les transactions/passerelles.
CREATE TABLE IF NOT EXISTS vendor_wallets (
  vendor_id  BIGINT PRIMARY KEY,
  balance_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id         BIGSERIAL PRIMARY KEY,
  vendor_id  BIGINT NOT NULL,
  type       TEXT NOT NULL, -- sale | commission | payout | adjustment
  amount_usd DOUBLE PRECISION NOT NULL, -- + crédit / - débit
  order_id   BIGINT,
  note       TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_vendor ON wallet_transactions (vendor_id, created_at DESC);
CREATE TABLE IF NOT EXISTS payout_requests (
  id         BIGSERIAL PRIMARY KEY,
  vendor_id  BIGINT NOT NULL,
  amount_usd DOUBLE PRECISION NOT NULL,
  method     TEXT DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | paid
  admin_note TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payout_status ON payout_requests (status, created_at DESC);

-- Colonnes PawaPay pour le versement sortant (module Finances). Un
-- payout_request peut être exécuté via PawaPay (transfert mobile money
-- automatique) OU traité manuellement par l'admin (Wave/RIB, comportement
-- historique) : ces colonnes ne sont remplies que dans le premier cas.
ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS pawapay_payout_id TEXT DEFAULT '';
ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS pawapay_status    TEXT DEFAULT '';
ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS recipient_country TEXT DEFAULT ''; -- ISO2
ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS recipient_phone   TEXT DEFAULT '';

-- Remboursements PawaPay (et, à terme, autres fournisseurs). Un refund
-- référence le paiement d'origine par son order_id (jamais de FK SQL,
-- cohérent avec payments.order_id) et le provider_ref d'origine
-- (depositId PawaPay / pi_ Stripe). status suit le vocabulaire PawaPay :
-- pending | accepted | completed | rejected | failed.
CREATE TABLE IF NOT EXISTS refunds (
  id             BIGSERIAL PRIMARY KEY,
  order_id       BIGINT NOT NULL,
  provider       TEXT NOT NULL CHECK (provider IN ('stripe','paydunya','pawapay')),
  provider_ref   TEXT DEFAULT '',        -- refundId PawaPay (UUID v4) une fois créé
  source_ref     TEXT DEFAULT '',        -- provider_ref du paiement remboursé (depositId, pi_...)
  amount_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending',
  reason         TEXT DEFAULT '',
  created_by     TEXT DEFAULT '',        -- admin à l'origine du remboursement
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds (order_id);
CREATE INDEX IF NOT EXISTS idx_refunds_ref ON refunds (provider_ref);
`

// getSettings/putSettings — Configuration Système (page admin), portage
// des variables d'env historiques vers une config éditable en base sans
// redéploiement. Même pattern que fulfillment-svc (dhl_settings).
func (s *server) getSettings(w http.ResponseWriter, r *http.Request) {
	kit.JSON(w, 200, s.settings.Snapshot())
}

func (s *server) putSettings(w http.ResponseWriter, r *http.Request) {
	var body map[string]string
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	toSave := map[string]string{}
	for k, v := range body {
		if !s.settings.IsKnown(k) {
			continue
		}
		if s.settings.IsSecret(k) && v == "" {
			continue // champ secret vide = "inchangé", jamais écrasé par du vide
		}
		toSave[k] = v
	}
	if len(toSave) == 0 {
		kit.Fail(w, 400, "no_valid_fields", "aucun champ reconnu à mettre à jour")
		return
	}
	if err := s.settings.Save(r.Context(), toSave); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"ok": true, "updated": len(toSave)})
}

// defaultCommissionRate — taux plateforme appliqué à défaut de commission
// vendeur/catégorie spécifique (résolution simplifiée en premier jet : pas
// d'appel catalog-svc par ligne de commande, seulement vendor-svc pour un
// éventuel override). Peut être ajusté sans redéploiement via env.
//
// Fraction décimale (0.10 = 10%), PAS un pourcentage entier — corrigé le
// 2026-08-25 : ce fichier lisait "10" comme défaut et divisait par 100 en
// aval, alors qu'order-svc lit la MÊME variable d'env comme une fraction
// (défaut "0.10", multipliée directement sans division). Les deux
// produisaient le même résultat par coïncidence des défauts, mais un vrai
// PLATFORM_COMMISSION_RATE=10 dans .env aurait fait calculer 1000% de
// commission côté order-svc. Unifié en fraction partout (cohérent avec
// vendors.commission_rate, déjà une fraction).
func (s *server) defaultCommissionRate() float64 {
	rate, err := strconv.ParseFloat(s.platformCommissionRate, 64)
	if err != nil {
		return 0.10
	}
	return rate
}

type server struct {
	db          *pgxpool.Pool
	producer    sarama.SyncProducer
	orderURL    string
	shippingURL string // source des exchange-rates pour la conversion PayDunya (USD -> XOF)
	vendorURL   string // résolution du commission_rate override vendeur (module Finances)

	settings *kit.SettingsStore
	// Champs pointés par settings (voir NewSettingsStore) — jamais lus
	// directement ailleurs que via settings.Snapshot()/les accès protégés
	// par son mutex interne ; gardés ici seulement pour être passés en
	// *string à NewSettingsStore.
	platformCommissionRate string
	stripeSecretKey        string
	stripeWebhookSecret    string
	stripeEnabledStr       string
	paydunyaAPIKeyPrivate  string
	paydunyaAPIKeyPublic   string
	paydunyaMasterKey      string
	paydunyaToken          string
	paydunyaAPIBase        string
	paydunyaEnabledStr     string
	pawapayAPIKey          string
	pawapayEnvironment     string // "sandbox" (défaut) | "production"
	pawapayEnabledStr      string
	storefrontURL          string
}

// stripeEnabled/paydunyaEnabled — toggle indépendant des clés API (demandé
// le 2026-08-26 : pouvoir couper temporairement un moyen de paiement sans
// effacer sa clé). Stocké comme string ("true"/"false", vide = activé par
// défaut) car kit.SettingsField ne supporte que *string — pas de nouveau
// type à ajouter à kit pour ce seul besoin.
func (s *server) stripeEnabled() bool   { return s.stripeEnabledStr != "false" }
func (s *server) paydunyaEnabled() bool { return s.paydunyaEnabledStr != "false" }

// pawapayEnabled — désactivé par DÉFAUT (contrairement à Stripe/PayDunya
// activés par défaut) : l'intégration part en sandbox, l'admin l'active
// explicitement depuis Configuration Système une fois la clé saisie et le
// bon environnement choisi. Vide = désactivé ; "true" = activé.
func (s *server) pawapayEnabled() bool { return s.pawapayEnabledStr == "true" }

const settingsTable = "payment_settings"

func (s *server) settingsFields() []kit.SettingsField {
	return []kit.SettingsField{
		{Key: "platform_commission_rate", Ptr: &s.platformCommissionRate, Description: "Taux de commission plateforme (fraction, ex: 0.10 = 10%) appliqué à défaut d'un override vendeur"},
		{Key: "stripe_secret_key", Ptr: &s.stripeSecretKey, Secret: true, Description: "Clé secrète API Stripe (paiements carte)"},
		{Key: "stripe_webhook_secret", Ptr: &s.stripeWebhookSecret, Secret: true, Description: "Secret de vérification de signature des webhooks Stripe"},
		{Key: "stripe_enabled", Ptr: &s.stripeEnabledStr, Description: "Activer Stripe comme moyen de paiement (\"false\" pour désactiver sans effacer la clé) — vide ou toute autre valeur = activé"},
		{Key: "paydunya_api_key_private", Ptr: &s.paydunyaAPIKeyPrivate, Secret: true, Description: "Clé API privée PayDunya (Wave, Orange Money)"},
		{Key: "paydunya_api_key_public", Ptr: &s.paydunyaAPIKeyPublic, Secret: true, Description: "Clé API publique PayDunya (liée au compte marchand)"},
		{Key: "paydunya_master_key", Ptr: &s.paydunyaMasterKey, Secret: true, Description: "Clé maître PayDunya (signature/validation)"},
		{Key: "paydunya_token", Ptr: &s.paydunyaToken, Secret: true, Description: "Token PayDunya (Dashboard → Intégrez notre API → Token) — obligatoire en header PAYDUNYA-TOKEN sur checkout-invoice/create"},
		{Key: "paydunya_api_base", Ptr: &s.paydunyaAPIBase, Description: "URL de base de l'API PayDunya"},
		{Key: "paydunya_enabled", Ptr: &s.paydunyaEnabledStr, Description: "Activer PayDunya comme moyen de paiement (\"false\" pour désactiver sans effacer la clé) — vide ou toute autre valeur = activé"},
		{Key: "pawapay_api_key", Ptr: &s.pawapayAPIKey, Secret: true, Description: "Clé API PawaPay (mobile money multi-pays Afrique) — Bearer token, côté serveur uniquement"},
		{Key: "pawapay_environment", Ptr: &s.pawapayEnvironment, Description: "Environnement PawaPay : \"sandbox\" (défaut, pour le développement) ou \"production\" (bascule explicite avant mise en ligne réelle)"},
		{Key: "pawapay_enabled", Ptr: &s.pawapayEnabledStr, Description: "Activer PawaPay comme moyen de paiement mobile money (\"true\" pour activer — désactivé par défaut). Sert d'interrupteur PawaPay ⇄ PayDunya : activer l'un, mettre l'autre à \"false\""},
		{Key: "storefront_url", Ptr: &s.storefrontURL, Description: "URL du site public, utilisée pour les liens de retour après paiement"},
	}
}

func main() {
	ctx := context.Background()
	log := kit.Logger("payment-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_PAYMENT", "postgres://miad:miad@postgres:5432/miad_payment?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema+kit.SettingsStoreSchema(settingsTable)); err != nil {
		log.Error("migration impossible", "err", err)
		return
	}
	// Migration 2026-08-26 : order_id passe de "id sous-commande" à "id
	// commande groupée" (voir doc-comment de la colonne dans schema) — un
	// paiement Stripe/PayDunya unique par commande, pas un par vendeur.
	// Des lignes existantes en prod violent déjà l'unicité voulue (une
	// ligne payments par sous-commande créée avant ce changement) : on
	// garde la plus ancienne par order_id (première créée = celle sur
	// laquelle le client a effectivement payé) et supprime les doublons
	// avant de poser l'index unique, sinon CREATE UNIQUE INDEX échoue au
	// démarrage. Idempotent : DROP+CREATE ne fait rien si déjà en place.
	if _, err := db.Exec(ctx, `
		DELETE FROM payments a USING payments b
		WHERE a.order_id = b.order_id AND a.id > b.id`); err != nil {
		log.Error("nettoyage doublons payments impossible", "err", err)
		return
	}
	if _, err := db.Exec(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_order_unique ON payments (order_id)`); err != nil {
		log.Error("index unique payments impossible", "err", err)
		return
	}
	// Migration 2026-08-27 : ajout de 'pawapay' au CHECK provider des tables
	// payments et refunds. `kit.Migrate` ne fait que CREATE TABLE IF NOT
	// EXISTS — sur une table déjà créée avec l'ancien CHECK
	// ('stripe','paydunya'), la nouvelle définition du schéma n'est jamais
	// appliquée, et tout INSERT provider='pawapay' échoue en violation de
	// contrainte (attrapé silencieusement par initiateFor → "paiement déjà
	// initié", constaté en prod le 2026-08-27 : aucune ligne payments créée
	// pour les commandes PawaPay). DROP + ADD explicite, idempotent (NOT
	// VALID évité : les lignes existantes respectent déjà le nouveau CHECK,
	// plus permissif). Le nom de contrainte auto-généré par Postgres est
	// <table>_<colonne>_check.
	for _, mig := range []struct{ table, check string }{
		{"payments", "provider IN ('stripe','paydunya','pawapay')"},
		{"refunds", "provider IN ('stripe','paydunya','pawapay')"},
	} {
		_, _ = db.Exec(ctx, fmt.Sprintf(`ALTER TABLE %s DROP CONSTRAINT IF EXISTS %s_provider_check`, mig.table, mig.table))
		if _, err := db.Exec(ctx, fmt.Sprintf(`ALTER TABLE %s ADD CONSTRAINT %s_provider_check CHECK (%s)`, mig.table, mig.table, mig.check)); err != nil {
			log.Error("migration CHECK provider impossible", "table", mig.table, "err", err)
			return
		}
	}

	s := &server{
		db:          db,
		producer:    kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		orderURL:    kit.Env("ORDER_SVC_URL", "http://order-svc:8083"),
		shippingURL: kit.Env("SHIPPING_SVC_URL", "http://shipping-svc:8085"),
		vendorURL:   kit.Env("VENDOR_SVC_URL", "http://vendor-svc:8082"),

		platformCommissionRate: kit.Env("PLATFORM_COMMISSION_RATE", "0.10"),
		stripeSecretKey:        kit.Env("STRIPE_SECRET_KEY", ""),
		stripeWebhookSecret:    kit.Env("STRIPE_WEBHOOK_SECRET", ""),
		paydunyaAPIKeyPrivate:  kit.Env("PAYDUNYA_API_KEY_PRIVATE", ""),
		paydunyaAPIKeyPublic:   kit.Env("PAYDUNYA_API_KEY_PUBLIC", ""),
		paydunyaMasterKey:      kit.Env("PAYDUNYA_MASTER_KEY", ""),
		paydunyaAPIBase:        kit.Env("PAYDUNYA_API_BASE", "https://app.paydunya.com"),
		pawapayAPIKey:          kit.Env("PAWAPAY_API_KEY", ""),
		pawapayEnvironment:     kit.Env("PAWAPAY_ENVIRONMENT", "sandbox"),
		pawapayEnabledStr:      kit.Env("PAWAPAY_ENABLED", ""),
		storefrontURL:          kit.Env("STOREFRONT_URL", "http://localhost:3000"),
	}
	s.settings = kit.NewSettingsStore(db, settingsTable, s.settingsFields())
	// Configuration Système (base) a priorité sur les variables d'env
	// ci-dessus dès qu'un admin les a éditées au moins une fois depuis l'UI.
	if err := s.settings.Load(ctx); err != nil {
		log.Error("chargement payment_settings impossible", "err", err)
	}

	go s.consumeOrders(log)

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	health.Add("stripe_key", func(ctx context.Context) error {
		if s.stripeSecretKey == "" {
			return fmt.Errorf("STRIPE_SECRET_KEY absente — paiements carte inopérants")
		}
		return nil
	})
	health.Add("paydunya_keys", func(ctx context.Context) error {
		if s.paydunyaAPIKeyPrivate == "" {
			return fmt.Errorf("clé PayDunya absente — paiements mobiles inopérants")
		}
		return nil
	})
	health.Add("pawapay_key", func(ctx context.Context) error {
		if s.pawapayEnabled() && s.pawapayAPIKey == "" {
			return fmt.Errorf("PawaPay activé mais PAWAPAY_API_KEY absente — paiements mobiles inopérants")
		}
		return nil
	})

	kit.Run("payment-svc", kit.Env("PORT_PAYMENT", "8084"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("GET /settings", s.getSettings)
		mux.HandleFunc("PUT /settings", s.putSettings)
		mux.HandleFunc("POST /payments/init", s.initPayment)
		mux.HandleFunc("GET /payments", s.listPayments)
		mux.HandleFunc("GET /payments/order/{order_id}", s.getPayment)
		mux.HandleFunc("GET /payment-methods", s.listPaymentMethods)
		mux.HandleFunc("POST /payments/webhook/stripe", s.stripeWebhook)
		mux.HandleFunc("POST /payments/webhook/paydunya", s.paydunyaCallback)
		mux.HandleFunc("POST /payments/webhook/pawapay", s.pawapayWebhook)
		mux.HandleFunc("GET /pawapay/countries", s.listPawapayCountries)
		mux.HandleFunc("GET /wallet/{vendor_id}", s.getWallet)
		mux.HandleFunc("GET /wallet/{vendor_id}/transactions", s.listWalletTransactions)
		mux.HandleFunc("POST /payout-requests", s.createPayoutRequest)
		mux.HandleFunc("GET /payout-requests", s.listPayoutRequests)
		mux.HandleFunc("POST /payout-requests/{id}/approve", s.approvePayout)
		mux.HandleFunc("POST /payout-requests/{id}/reject", s.rejectPayout)
		mux.HandleFunc("POST /payout-requests/{id}/pawapay", s.executePayoutViaPawapay)
		mux.HandleFunc("POST /refunds", s.createRefund)
		mux.HandleFunc("GET /refunds", s.listRefunds)
		mux.HandleFunc("GET /finance/overview", s.financeOverview)
		mux.HandleFunc("GET /finance/transactions", s.financeTransactions)
	})
}

// listPaymentMethods — liste statique dérivée de la présence des clés
// d'env déjà lues au démarrage (voir health-checks stripe_key/paydunya_keys
// ci-dessus) : pas de table, pas de persistance, juste un reflet de ce qui
// est réellement configuré. Format proche WooCommerce (wc/v3/payment_gateways)
// pour compatibilité frontend (gateway id/title/enabled).
// stripeMode — le mode test/live Stripe est déterminé par le PRÉFIXE de la
// clé secrète (sk_test_... vs sk_live_...), pas par un champ séparé —
// c'est Stripe qui impose cette convention, aucune ambiguïté possible.
// Affiché en Configuration pour éviter de confondre les deux (demandé le
// 2026-08-26 : tester par erreur en live, ou l'inverse).
func stripeMode(secretKey string) string {
	switch {
	case strings.HasPrefix(secretKey, "sk_test_"):
		return "test"
	case strings.HasPrefix(secretKey, "sk_live_"):
		return "live"
	default:
		return "unknown"
	}
}

func (s *server) listPaymentMethods(w http.ResponseWriter, r *http.Request) {
	gateways := []map[string]any{
		{
			"id": "stripe", "title": "Carte bancaire", "method_title": "Stripe",
			"enabled": s.stripeSecretKey != "" && s.stripeEnabled(),
			"mode":    stripeMode(s.stripeSecretKey),
		},
		{
			"id": "paydunya", "title": "Mobile Money / PayDunya", "method_title": "PayDunya",
			"enabled": s.paydunyaAPIKeyPrivate != "" && s.paydunyaEnabled(),
		},
		{
			"id": "pawapay", "title": "Mobile Money", "method_title": "PawaPay",
			"enabled": s.pawapayAPIKey != "" && s.pawapayEnabled(),
			"mode":    s.pawapayEnvironment,
		},
	}
	kit.JSON(w, 200, map[string]any{"gateways": gateways})
}

// listPawapayCountries — table pays/opérateurs exposée au frontend pour le
// sélecteur de pays du checkout PawaPay. Statique, dérivée de
// pawapayCountries (voir pawapay.go).
func (s *server) listPawapayCountries(w http.ResponseWriter, r *http.Request) {
	out := make([]map[string]any, 0, len(pawapayCountries))
	for _, c := range pawapayCountries {
		out = append(out, map[string]any{
			"iso2": c.ISO2, "iso3": c.ISO3, "name": c.Name,
			"currency": c.Currency, "dial_code": c.DialCode, "providers": c.Providers,
		})
	}
	kit.JSON(w, 200, map[string]any{"countries": out, "default_iso2": "SN"})
}

/* ---------- Finances : agrégation (module Finances) ---------- */

// financeOverview — GMV, revenu commission plateforme et volume par
// méthode sur une période (?period=today|7d|30d|year, défaut 30d).
// Ne recalcule rien depuis les commandes : s'appuie sur payments.status='confirmed'
// (paiements réellement encaissés) et sur wallet_transactions type='commission'
// (déjà posé au module Vendeurs) pour le revenu plateforme — deux tables déjà
// à jour en continu, pas de nouvelle agrégation coûteuse à construire.
func (s *server) financeOverview(w http.ResponseWriter, r *http.Request) {
	since := periodSince(r.URL.Query().Get("period"))

	var gmv float64
	var orderCount int64
	if err := s.db.QueryRow(r.Context(),
		"SELECT COALESCE(SUM(amount_usd),0), count(*) FROM payments WHERE status = 'confirmed' AND created_at >= $1",
		since,
	).Scan(&gmv, &orderCount); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	var commissionRevenue float64
	if err := s.db.QueryRow(r.Context(),
		"SELECT COALESCE(-SUM(amount_usd),0) FROM wallet_transactions WHERE type = 'commission' AND created_at >= $1",
		since,
	).Scan(&commissionRevenue); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	rows, err := s.db.Query(r.Context(),
		"SELECT provider, count(*), COALESCE(SUM(amount_usd),0) FROM payments WHERE status = 'confirmed' AND created_at >= $1 GROUP BY provider",
		since)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	byMethod := []map[string]any{}
	for rows.Next() {
		var provider string
		var count int64
		var amount float64
		if err := rows.Scan(&provider, &count, &amount); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		byMethod = append(byMethod, map[string]any{"provider": provider, "count": count, "amount_usd": amount})
	}

	avgBasket := 0.0
	if orderCount > 0 {
		avgBasket = gmv / float64(orderCount)
	}

	var pendingPayoutsTotal float64
	var pendingPayoutsCount int64
	_ = s.db.QueryRow(r.Context(),
		"SELECT COALESCE(SUM(amount_usd),0), count(*) FROM payout_requests WHERE status = 'pending'",
	).Scan(&pendingPayoutsTotal, &pendingPayoutsCount)

	kit.JSON(w, 200, map[string]any{
		"gmv_usd": gmv, "orders_count": orderCount, "average_basket_usd": avgBasket,
		"commission_revenue_usd":    commissionRevenue,
		"by_payment_method":         byMethod,
		"pending_payouts_total_usd": pendingPayoutsTotal, "pending_payouts_count": pendingPayoutsCount,
	})
}

func periodSince(period string) time.Time {
	now := time.Now().UTC()
	switch period {
	case "today":
		return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	case "7d":
		return now.AddDate(0, 0, -7)
	case "year":
		return now.AddDate(-1, 0, 0)
	default: // 30d
		return now.AddDate(0, 0, -30)
	}
}

// financeTransactions — journal global des paiements confirmés, avec la
// commission plateforme calculée par ligne (même résolution que
// creditVendorWallet : vendor override > taux global — appel vendor-svc
// par ligne, acceptable pour ce volume de listing paginé).
func (s *server) financeTransactions(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(kit.EnvOr(r.URL.Query().Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(r.URL.Query().Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM payments WHERE status = 'confirmed'").Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT id, order_id, provider, provider_ref, amount_usd, method, confirmed_at
		FROM payments WHERE status = 'confirmed'
		ORDER BY id DESC LIMIT $1 OFFSET $2`, pageSize, (page-1)*pageSize)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, orderID int64
		var amount float64
		var provider, providerRef, method string
		var confirmedAt *time.Time
		if err := rows.Scan(&id, &orderID, &provider, &providerRef, &amount, &method, &confirmedAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		var commission float64
		_ = s.db.QueryRow(r.Context(),
			"SELECT COALESCE(-SUM(amount_usd),0) FROM wallet_transactions WHERE type = 'commission' AND order_id = $1",
			orderID).Scan(&commission)
		var confirmedStr any
		if confirmedAt != nil {
			confirmedStr = confirmedAt.UTC().Format(time.RFC3339)
		}
		items = append(items, map[string]any{
			"id": id, "order_id": orderID, "provider": provider, "provider_ref": providerRef,
			"amount_usd": amount, "commission_usd": commission, "net_usd": amount - commission,
			"method": method, "confirmed_at": confirmedStr,
		})
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

/* ---------- Wallet vendeur & payouts (modules Vendeurs/Finances) ---------- */

func (s *server) getWallet(w http.ResponseWriter, r *http.Request) {
	vendorID := r.PathValue("vendor_id")
	var balance float64
	var updatedAt time.Time
	err := s.db.QueryRow(r.Context(),
		"SELECT balance_usd, updated_at FROM vendor_wallets WHERE vendor_id = $1", vendorID,
	).Scan(&balance, &updatedAt)
	if err != nil {
		// Pas d'erreur si le vendeur n'a encore aucun mouvement — solde 0,
		// jamais un 404 (un vendeur sans vente n'a juste rien à afficher).
		kit.JSON(w, 200, map[string]any{"vendor_id": vendorID, "balance_usd": 0, "updated_at": nil})
		return
	}
	kit.JSON(w, 200, map[string]any{
		"vendor_id": vendorID, "balance_usd": balance, "updated_at": updatedAt.UTC().Format(time.RFC3339),
	})
}

func (s *server) listWalletTransactions(w http.ResponseWriter, r *http.Request) {
	vendorID := r.PathValue("vendor_id")
	page, _ := strconv.Atoi(kit.EnvOr(r.URL.Query().Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(r.URL.Query().Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	var total int64
	if err := s.db.QueryRow(r.Context(),
		"SELECT count(*) FROM wallet_transactions WHERE vendor_id = $1", vendorID,
	).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT id, type, amount_usd, order_id, note, created_at
		FROM wallet_transactions WHERE vendor_id = $1
		ORDER BY created_at DESC LIMIT $2 OFFSET $3`, vendorID, pageSize, (page-1)*pageSize)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var txType, note string
		var amount float64
		var orderID *int64
		var createdAt time.Time
		if err := rows.Scan(&id, &txType, &amount, &orderID, &note, &createdAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		items = append(items, map[string]any{
			"id": id, "type": txType, "amount_usd": amount, "order_id": orderID,
			"note": note, "created_at": createdAt.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

// createPayoutRequest — self-service vendeur (appelé par vendor-svc côté
// dashboard vendeur, pas directement admin) mais nécessaire pour que la
// liste admin des demandes ait des données. Vérifie le solde disponible
// avant d'accepter la demande — jamais de demande supérieure au solde.
func (s *server) createPayoutRequest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		VendorID  int64   `json:"vendor_id"`
		AmountUSD float64 `json:"amount_usd"`
		Method    string  `json:"method"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.VendorID == 0 || body.AmountUSD <= 0 {
		kit.Fail(w, 400, "missing_fields", "vendor_id et amount_usd (>0) requis")
		return
	}
	var balance float64
	_ = s.db.QueryRow(r.Context(), "SELECT balance_usd FROM vendor_wallets WHERE vendor_id = $1", body.VendorID).Scan(&balance)
	if body.AmountUSD > balance {
		kit.Fail(w, 400, "insufficient_balance", fmt.Sprintf("solde disponible %.2f USD, demande %.2f USD", balance, body.AmountUSD))
		return
	}
	var id int64
	err := s.db.QueryRow(r.Context(), `
		INSERT INTO payout_requests (vendor_id, amount_usd, method) VALUES ($1,$2,$3) RETURNING id`,
		body.VendorID, body.AmountUSD, body.Method,
	).Scan(&id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.Publish(s.producer, "payout_request.created", fmt.Sprint(id), map[string]any{
		"payout_id": id, "vendor_id": body.VendorID, "amount_usd": body.AmountUSD,
		"at": time.Now().UTC().Format(time.RFC3339),
	})
	kit.JSON(w, 201, map[string]any{"id": id})
}

func (s *server) listPayoutRequests(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(kit.EnvOr(q.Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(q.Get("page_size"), "20"))
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
		where += fmt.Sprintf(" AND status = $%d", len(args))
	}
	if v := q.Get("vendor_id"); v != "" {
		args = append(args, v)
		where += fmt.Sprintf(" AND vendor_id = $%d", len(args))
	}
	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM payout_requests "+where, args...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(r.Context(), fmt.Sprintf(`
		SELECT id, vendor_id, amount_usd, method, status, admin_note, created_at, processed_at
		FROM payout_requests %s ORDER BY created_at DESC LIMIT $%d OFFSET $%d`, where, len(args)-1, len(args)), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, vendorID int64
		var amount float64
		var method, status, adminNote string
		var createdAt time.Time
		var processedAt *time.Time
		if err := rows.Scan(&id, &vendorID, &amount, &method, &status, &adminNote, &createdAt, &processedAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		var processedStr any
		if processedAt != nil {
			processedStr = processedAt.UTC().Format(time.RFC3339)
		}
		items = append(items, map[string]any{
			"id": id, "vendor_id": vendorID, "amount_usd": amount, "method": method,
			"status": status, "admin_note": adminNote,
			"created_at": createdAt.UTC().Format(time.RFC3339), "processed_at": processedStr,
		})
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

// approvePayout — marque la demande payée et DÉBITE le wallet dans la
// même transaction. "Payé" ici signifie que l'admin a traité le virement
// manuellement (Wave/Orange Money/RIB) — pas d'intégration bancaire
// automatique, cohérent avec l'absence de passerelle de virement sortant
// dans le dépôt.
func (s *server) approvePayout(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	var body struct {
		AdminNote string `json:"admin_note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	var vendorID int64
	var amount float64
	var status string
	if err := s.db.QueryRow(r.Context(),
		"SELECT vendor_id, amount_usd, status FROM payout_requests WHERE id = $1", id,
	).Scan(&vendorID, &amount, &status); err != nil {
		kit.Fail(w, 404, "payout_not_found", fmt.Sprintf("demande %d introuvable", id))
		return
	}
	if status != "pending" {
		kit.Fail(w, 409, "already_processed", fmt.Sprintf("demande déjà au statut %q", status))
		return
	}

	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		"UPDATE vendor_wallets SET balance_usd = balance_usd - $2, updated_at = now() WHERE vendor_id = $1",
		vendorID, amount); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if _, err := tx.Exec(ctx,
		"INSERT INTO wallet_transactions (vendor_id, type, amount_usd, note) VALUES ($1,'payout',$2,$3)",
		vendorID, -amount, fmt.Sprintf("payout #%d", id)); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if _, err := tx.Exec(ctx,
		"UPDATE payout_requests SET status = 'paid', admin_note = $2, processed_at = now() WHERE id = $1",
		id, body.AdminNote); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.Publish(s.producer, "payout_request.approved", fmt.Sprint(id), map[string]any{
		"payout_id": id, "vendor_id": vendorID, "amount_usd": amount,
		"at": time.Now().UTC().Format(time.RFC3339),
	})
	kit.JSON(w, 200, map[string]any{"id": id, "status": "paid"})
}

func (s *server) rejectPayout(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	var body struct {
		AdminNote string `json:"admin_note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	var vendorID int64
	var amount float64
	_ = s.db.QueryRow(r.Context(),
		"SELECT vendor_id, amount_usd FROM payout_requests WHERE id = $1", id,
	).Scan(&vendorID, &amount)

	tag, err := s.db.Exec(r.Context(),
		"UPDATE payout_requests SET status = 'rejected', admin_note = $2, processed_at = now() WHERE id = $1 AND status = 'pending'",
		id, body.AdminNote)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 409, "not_pending", fmt.Sprintf("demande %d introuvable ou déjà traitée", id))
		return
	}
	kit.Publish(s.producer, "payout_request.rejected", fmt.Sprint(id), map[string]any{
		"payout_id": id, "vendor_id": vendorID, "amount_usd": amount, "admin_note": body.AdminNote,
		"at": time.Now().UTC().Format(time.RFC3339),
	})
	kit.JSON(w, 200, map[string]any{"id": id, "status": "rejected"})
}

// executePayoutViaPawapay — exécute une demande de retrait vendeur via un
// transfert mobile money PawaPay automatique, en alternative au traitement
// manuel d'approvePayout (Wave/RIB). Débite le wallet dans la MÊME
// transaction que le déclenchement du payout (comme approvePayout), puis
// appelle PawaPay. Le statut final arrive par webhook (pawapayHandlePayoutWebhook).
//
// Corps : { "recipient_country": "SN", "recipient_phone": "77...", "admin_note": "" }
//
// Si PawaPay REJETTE immédiatement (solde marchand insuffisant, numéro
// invalide...), la transaction est annulée (rollback) — le wallet vendeur
// n'est pas débité et la demande reste 'pending' pour retenter autrement.
func (s *server) executePayoutViaPawapay(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	var body struct {
		RecipientCountry string `json:"recipient_country"` // ISO2
		RecipientPhone   string `json:"recipient_phone"`
		AdminNote        string `json:"admin_note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.RecipientCountry == "" || body.RecipientPhone == "" {
		kit.Fail(w, 400, "missing_fields", "recipient_country (ISO2) et recipient_phone requis")
		return
	}
	if !s.pawapayEnabled() || s.pawapayAPIKey == "" {
		kit.Fail(w, 409, "pawapay_disabled", "PawaPay n'est pas activé — utilisez l'approbation manuelle")
		return
	}

	var vendorID int64
	var amount float64
	var status string
	if err := s.db.QueryRow(r.Context(),
		"SELECT vendor_id, amount_usd, status FROM payout_requests WHERE id = $1", id,
	).Scan(&vendorID, &amount, &status); err != nil {
		kit.Fail(w, 404, "payout_not_found", fmt.Sprintf("demande %d introuvable", id))
		return
	}
	if status != "pending" {
		kit.Fail(w, 409, "already_processed", fmt.Sprintf("demande déjà au statut %q", status))
		return
	}

	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	// Débit wallet + ledger, comme approvePayout.
	if _, err := tx.Exec(ctx,
		"UPDATE vendor_wallets SET balance_usd = balance_usd - $2, updated_at = now() WHERE vendor_id = $1",
		vendorID, amount); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if _, err := tx.Exec(ctx,
		"INSERT INTO wallet_transactions (vendor_id, type, amount_usd, note) VALUES ($1,'payout',$2,$3)",
		vendorID, -amount, fmt.Sprintf("payout PawaPay #%d", id)); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	payoutID, initialStatus, err := s.createPawaPayPayout(ctx, id, vendorID, amount, body.RecipientCountry, body.RecipientPhone)
	if err != nil {
		// Rollback implicite (defer) : wallet non débité, demande reste pending.
		slog.Error("executePayoutViaPawapay: PawaPay a rejeté/échoué", "payout_request_id", id, "err", err)
		kit.Fail(w, 502, "pawapay_payout_failed", err.Error())
		return
	}

	// 'approved' (pas 'paid') : le versement est LANCÉ, la confirmation
	// finale viendra du webhook. pawapay_status garde le statut initial
	// (ACCEPTED/ENQUEUED/PROCESSING).
	if _, err := tx.Exec(ctx, `
		UPDATE payout_requests
		SET status='approved', admin_note=$2, pawapay_payout_id=$3, pawapay_status=$4,
		    recipient_country=$5, recipient_phone=$6, processed_at=now()
		WHERE id=$1`,
		id, body.AdminNote, payoutID, initialStatus, strings.ToUpper(body.RecipientCountry), body.RecipientPhone); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	slog.Info("payout PawaPay lancé", "payout_request_id", id, "vendor_id", vendorID, "pawapay_payout_id", payoutID, "initial_status", initialStatus)
	kit.Publish(s.producer, "payout_request.approved", fmt.Sprint(id), map[string]any{
		"payout_id": id, "vendor_id": vendorID, "amount_usd": amount, "provider": "pawapay",
		"at": time.Now().UTC().Format(time.RFC3339),
	})
	kit.JSON(w, 200, map[string]any{"id": id, "status": "approved", "pawapay_payout_id": payoutID, "pawapay_status": initialStatus})
}

// createRefund — rembourse (tout ou partie) le paiement d'une commande via
// PawaPay. Réservé aux paiements provider='pawapay' au statut 'confirmed'.
//
// Corps : { "order_id": 123, "amount_usd": 0, "reason": "...", "created_by": "admin@..." }
// amount_usd=0 ou absent = remboursement TOTAL.
func (s *server) createRefund(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OrderID   int64   `json:"order_id"`
		AmountUSD float64 `json:"amount_usd"`
		Reason    string  `json:"reason"`
		CreatedBy string  `json:"created_by"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.OrderID == 0 {
		kit.Fail(w, 400, "invalid_body", "order_id obligatoire")
		return
	}
	ctx := r.Context()

	var provider, providerRef, payStatus string
	var paidUSD float64
	if err := s.db.QueryRow(ctx,
		"SELECT provider, provider_ref, status, amount_usd FROM payments WHERE order_id=$1 ORDER BY id DESC LIMIT 1", body.OrderID,
	).Scan(&provider, &providerRef, &payStatus, &paidUSD); err != nil {
		kit.Fail(w, 404, "payment_not_found", fmt.Sprintf("aucun paiement pour la commande %d", body.OrderID))
		return
	}
	if provider != "pawapay" {
		kit.Fail(w, 409, "unsupported_provider", fmt.Sprintf("remboursement automatique disponible pour PawaPay uniquement (paiement %q)", provider))
		return
	}
	if payStatus != "confirmed" {
		kit.Fail(w, 409, "not_refundable", fmt.Sprintf("le paiement doit être confirmé (statut actuel %q)", payStatus))
		return
	}
	refundUSD := body.AmountUSD
	if refundUSD <= 0 || refundUSD > paidUSD {
		refundUSD = paidUSD // total
	}

	// Montant en devise locale : PawaPay attend le remboursement dans la
	// devise du deposit d'origine. On reconvertit USD→local avec le même
	// mécanisme que le deposit. Le pays du deposit n'est pas stocké — on le
	// relit depuis PawaPay via le statut (payer.accountDetails.provider →
	// suffixe pays), sinon repli sur remboursement total (amount omis).
	var amountLocal string
	if country := s.pawapayCountryForDeposit(ctx, providerRef); country != nil && (body.AmountUSD > 0 && body.AmountUSD < paidUSD) {
		if rate, err := s.pawapayResolveRate(ctx, country.Currency); err == nil {
			amountLocal = pawapayLocalAmount(refundUSD, rate, country.Currency)
		}
	}

	refundID, status, err := s.createPawaPayRefund(ctx, providerRef, amountLocal)
	if err != nil {
		slog.Error("createRefund: PawaPay a rejeté le remboursement", "order_id", body.OrderID, "err", err)
		kit.Fail(w, 502, "pawapay_refund_failed", err.Error())
		return
	}
	var newID int64
	if err := s.db.QueryRow(ctx, `
		INSERT INTO refunds (order_id, provider, provider_ref, source_ref, amount_usd, status, reason, created_by)
		VALUES ($1,'pawapay',$2,$3,$4,$5,$6,$7) RETURNING id`,
		body.OrderID, refundID, providerRef, refundUSD, strings.ToLower(status), body.Reason, body.CreatedBy,
	).Scan(&newID); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.Publish(s.producer, "refund.created", fmt.Sprint(body.OrderID), map[string]any{
		"refund_id": newID, "order_id": body.OrderID, "amount_usd": refundUSD, "provider": "pawapay",
		"status": status, "at": time.Now().UTC().Format(time.RFC3339),
	})
	slog.Info("remboursement PawaPay créé", "refund_id", newID, "order_id", body.OrderID, "amount_usd", refundUSD, "pawapay_refund_id", refundID, "status", status)
	kit.JSON(w, 201, map[string]any{"id": newID, "status": status, "pawapay_refund_id": refundID, "amount_usd": refundUSD})
}

// pawapayCountryForDeposit — retrouve le pays PawaPay d'un deposit à partir
// du suffixe ISO3 du code provider (ex. "MTN_MOMO_CIV" → CIV). Best-effort :
// renvoie nil si indéterminable (le remboursement se fera alors en total).
func (s *server) pawapayCountryForDeposit(ctx context.Context, depositID string) *pawapayCountry {
	code, raw, err := s.pawapayHTTP(ctx, http.MethodGet, "/v2/deposits/"+depositID, nil)
	if err != nil || code != http.StatusOK {
		return nil
	}
	var doc struct {
		Data struct {
			Country string `json:"country"` // ISO3
		} `json:"data"`
	}
	if json.Unmarshal(raw, &doc) != nil || doc.Data.Country == "" {
		return nil
	}
	return findPawapayCountryByISO3(doc.Data.Country)
}

func (s *server) listRefunds(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(kit.EnvOr(q.Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(q.Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	where := "WHERE 1=1"
	args := []any{}
	if v := q.Get("order_id"); v != "" {
		args = append(args, v)
		where += fmt.Sprintf(" AND order_id = $%d", len(args))
	}
	if v := q.Get("status"); v != "" {
		args = append(args, v)
		where += fmt.Sprintf(" AND status = $%d", len(args))
	}
	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM refunds "+where, args...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(r.Context(), fmt.Sprintf(`
		SELECT id, order_id, provider, provider_ref, source_ref, amount_usd, status, reason, created_by, created_at, updated_at
		FROM refunds %s ORDER BY created_at DESC LIMIT $%d OFFSET $%d`, where, len(args)-1, len(args)), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, orderID int64
		var amount float64
		var provider, providerRef, sourceRef, status, reason, createdBy string
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&id, &orderID, &provider, &providerRef, &sourceRef, &amount, &status, &reason, &createdBy, &createdAt, &updatedAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		items = append(items, map[string]any{
			"id": id, "order_id": orderID, "provider": provider, "provider_ref": providerRef,
			"source_ref": sourceRef, "amount_usd": amount, "status": status, "reason": reason,
			"created_by": createdBy, "created_at": createdAt.UTC().Format(time.RFC3339),
			"updated_at": updatedAt.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

/* ---------- Consommation order.created ---------- */

type orderCreatedEvent struct {
	OrderID       int64   `json:"order_id"`
	ParentOrderID int64   `json:"parent_order_id"`
	Reference     string  `json:"reference"`
	TotalUSD      float64 `json:"total_usd"`
	PaymentMethod string  `json:"payment_method"`
}

func (s *server) consumeOrders(log *slog.Logger) {
	brokers := kit.Env("KAFKA_BROKERS", "kafka:9092")
	if brokers == "" {
		log.Warn("KAFKA_BROKERS vide — consommation désactivée (mode dev)")
		return
	}
	cfg := sarama.NewConfig()
	cfg.Consumer.Offsets.Initial = sarama.OffsetOldest
	cfg.Version = sarama.V2_8_0_0
	for {
		group, err := sarama.NewConsumerGroup([]string{brokers}, "payment-svc", cfg)
		if err != nil {
			log.Error("kafka injoignable — retry 5 s", "err", err)
			time.Sleep(5 * time.Second)
			continue
		}
		log.Info("consommateur Kafka connecté", "topics", "order.created")
		handler := consumerFunc(func(ctx context.Context, msg *sarama.ConsumerMessage) {
			if msg.Topic != "order.created" {
				return
			}
			var ev orderCreatedEvent
			if err := json.Unmarshal(msg.Value, &ev); err != nil {
				log.Error("événement illisible", "err", err)
				return
			}
			s.initiateFor(ctx, log, ev)
		})
		_ = group.Consume(context.Background(), []string{"order.created"}, handler)
		group.Close()
	}
}

// initiateFor — pré-crée le paiement dès order.created (Kafka), ET la
// session chez le fournisseur pour PayDunya (redirection, pas besoin
// d'un aller-retour synchrone). Pour Stripe, la ligne "initiated" est
// posée ici mais le PaymentIntent réel est créé au premier appel de
// POST /payments/init (voir initPayment) : le frontend en a besoin
// immédiatement pour Stripe Elements, il ne peut pas attendre que ce
// consommateur Kafka ait tourné. Les deux chemins convergent sur la
// même ligne "payments" (idempotent via ON CONFLICT).
//
// Un paiement PAR COMMANDE GROUPÉE, pas par sous-commande (2026-08-26) :
// cet event arrive une fois PAR VENDEUR (order-svc publie order.created
// pour chaque sous-commande créée) — ON CONFLICT (order_id) DO NOTHING
// avec order_id=redirectOrderID(ev) (le parent) garantit qu'une seule
// ligne "payments" existe pour tout le groupe, peu importe combien de
// sous-commandes/vendeurs il contient ; les events suivants pour les
// autres vendeurs de la même commande n'ont plus rien à faire ici. Le
// montant utilisé est le TOTAL agrégé du groupe (via GET /orders/parent),
// pas ev.TotalUSD qui n'est que le total d'UNE sous-commande.
func (s *server) initiateFor(ctx context.Context, log *slog.Logger, ev orderCreatedEvent) {
	provider := ev.PaymentMethod
	if provider == "" {
		provider = "stripe"
	}
	groupOrderID := redirectOrderID(ev)
	totalUSD := ev.TotalUSD
	if parent, err := fetchParentOrder(ctx, s.orderURL, groupOrderID); err == nil {
		totalUSD = parent.TotalUSD
	} else {
		log.Warn("total agrégé indisponible, repli sur le total de la sous-commande", "parent_order_id", groupOrderID, "err", err)
	}
	var id int64
	err := s.db.QueryRow(ctx, `
		INSERT INTO payments (order_id, provider, amount_usd, status)
		VALUES ($1, $2, $3, 'initiated')
		ON CONFLICT (order_id) DO NOTHING RETURNING id`, groupOrderID, provider, totalUSD).Scan(&id)
	if err != nil {
		// pgx.ErrNoRows = ON CONFLICT DO NOTHING a supprimé la ligne du
		// RETURNING → la ligne payments existe déjà pour ce groupe, cas
		// nominal (un event order.created par sous-commande). TOUTE AUTRE
		// erreur (ex. violation du CHECK provider si la migration n'a pas
		// tourné) doit être loggée explicitement — sinon elle passe pour un
		// simple doublon et le paiement n'est jamais initié sans trace
		// (constaté en prod le 2026-08-27 avec provider='pawapay').
		if err == pgx.ErrNoRows {
			log.Info("paiement déjà initié pour ce groupe", "order_id", ev.OrderID, "group_order_id", groupOrderID)
		} else {
			log.Error("INSERT payments a échoué (autre que doublon) — paiement NON initié", "order_id", ev.OrderID, "provider", provider, "err", err)
		}
		return
	}
	if provider != "paydunya" {
		// Stripe : PaymentIntent créé à la demande via POST /payments/init.
		// PawaPay : la Payment Page hébergée a besoin du PAYS et du TÉLÉPHONE
		// de l'acheteur (choix du client / adresse de livraison) — absents de
		// l'event Kafka order.created. La session est donc créée à la demande
		// dans POST /payments/init (même raison que Stripe : le frontend a
		// besoin du redirect_url tout de suite après /api/orders), pas ici.
		return
	}

	// Même verrou anti-doublon que initPayment (voir son commentaire) :
	// entre cet INSERT (ligne posée en 'initiated') et l'appel réseau
	// PayDunya ci-dessous, POST /payments/init peut arriver entre-temps
	// (le frontend appelle /api/orders juste après avoir créé la commande,
	// à quelques centaines de ms de cet event Kafka) et lire lui aussi
	// status='initiated' — les deux chemins appelleraient alors PayDunya
	// en parallèle pour la même commande sans ce verrou.
	locked, err := s.db.Exec(ctx, "UPDATE payments SET status='creating' WHERE id=$1 AND status='initiated'", id)
	if err != nil {
		log.Error("verrou création facture PayDunya impossible", "order_id", groupOrderID, "err", err)
		return
	}
	if locked.RowsAffected() == 0 {
		log.Info("facture PayDunya déjà en cours de création ailleurs", "order_id", groupOrderID)
		return
	}
	// groupOrderID/totalUSD (pas ev.OrderID/ev.TotalUSD) : la facture doit
	// porter sur le total agrégé du groupe, avec le parent en métadonnée
	// (metadata[order_id] côté PayDunya), pas une sous-commande.
	groupEv := ev
	groupEv.OrderID = groupOrderID
	groupEv.TotalUSD = totalUSD
	ref, redirect, err := s.createPayDunyaInvoice(ctx, groupEv)
	if err != nil {
		// EXPLICITE : le paiement est marqué failed, l'événement part sur Kafka.
		_, _ = s.db.Exec(ctx, "UPDATE payments SET status='failed' WHERE id=$1", id)
		kit.Publish(s.producer, "payment.failed", fmt.Sprint(groupOrderID), map[string]any{
			"order_id": groupOrderID, "provider": provider, "reason": err.Error(),
			"at": time.Now().UTC().Format(time.RFC3339),
		})
		log.Error("création de facture PayDunya impossible", "order_id", groupOrderID, "err", err)
		return
	}
	_, _ = s.db.Exec(ctx, "UPDATE payments SET provider_ref=$2, redirect_url=$3 WHERE id=$1", id, ref, redirect)
	log.Info("facture PayDunya créée", "payment_id", id, "order_id", groupOrderID, "ref", ref)
}

/* ---------- Fournisseurs réels ---------- */

// createStripePaymentIntent — PaymentIntent (PAS Checkout Session) :
// le frontend affiche son propre formulaire de carte via Stripe Elements
// et confirme le paiement lui-même avec le client_secret renvoyé ici,
// sans jamais quitter le site. order_id part en métadonnée (pas
// client_reference_id, propre à Checkout Session) — c'est là que le
// webhook stripeWebhook le relit pour retrouver la commande.
func (s *server) createStripePaymentIntent(orderID int64, reference string, totalUSD float64) (id, clientSecret string, err error) {
	key := s.stripeSecretKey
	if key == "" {
		return "", "", fmt.Errorf("STRIPE_SECRET_KEY absente")
	}
	// Stripe attend amount dans la plus PETITE unité de la devise.
	// USD a 2 décimales (cents) — contrairement au XOF (zéro décimale)
	// utilisé auparavant ici, qui n'aurait pas eu besoin de ce ×100.
	amountCents := int64(math.Round(totalUSD * 100))
	form := url.Values{}
	form.Set("amount", strconv.FormatInt(amountCents, 10))
	form.Set("currency", "usd")
	form.Set("automatic_payment_methods[enabled]", "true")
	form.Set("description", "Commande MIAD "+reference)
	form.Set("metadata[order_id]", strconv.FormatInt(orderID, 10))
	form.Set("metadata[reference]", reference)

	req, _ := http.NewRequest(http.MethodPost, "https://api.stripe.com/v1/payment_intents",
		strings.NewReader(form.Encode()))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return "", "", fmt.Errorf("Stripe a refusé (%d): %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var doc struct {
		ID           string `json:"id"`
		ClientSecret string `json:"client_secret"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", "", err
	}
	return doc.ID, doc.ClientSecret, nil
}

// createPayDunyaInvoice — PayDunya (Wave, Orange Money) facture en XOF,
// devise locale UEMOA de ses moyens de paiement mobile ; le stockage
// interne reste en USD (source de vérité), converti ici uniquement pour
// cet appel via le taux exposé par shipping-svc (exchange_rates,
// source UNIQUE — voir shipping-svc/main.go).
// createPayDunyaInvoice — endpoint et structure de payload corrigés le
// 2026-08-26 d'après la doc officielle PayDunya (jamais vérifiée contre la
// vraie doc jusqu'ici, cassée en prod : l'ancienne URL checkout-api/v1/
// checkout/invoice renvoie une vraie page 404 PayDunya, pas une erreur
// d'auth). Trois erreurs corrigées :
//  1. URL : /api/v1/checkout-invoice/create (pas /checkout-api/v1/checkout/invoice)
//  2. "items" est un OBJET indexé item_0/item_1/... (pas un tableau JSON),
//     et "store.name" est un nœud racine obligatoire (absent avant)
//  3. response_code de succès est "00" (pas "0000"), et l'URL de paiement
//     est directement response_text — inutile de la reconstruire à la main
//     (l'ancienne reconstruction pointait en plus vers l'URL cassée)
// redirectOrderID — le parent groupe (multi-vendeur) est le seul ID que
// order-received/confirm-paydunya sait résoudre (GET /orders/parent/{id}),
// jamais l'ID d'une sous-commande individuelle. Repli sur OrderID si
// ParentOrderID est absent (event Kafka ancien format, avant le fix du
// 2026-08-26) plutôt que de planter — pire cas identique au bug d'avant.
func redirectOrderID(ev orderCreatedEvent) int64 {
	if ev.ParentOrderID != 0 {
		return ev.ParentOrderID
	}
	return ev.OrderID
}

func (s *server) createPayDunyaInvoice(ctx context.Context, ev orderCreatedEvent) (ref, redirect string, err error) {
	priv := s.paydunyaAPIKeyPrivate
	pub := s.paydunyaAPIKeyPublic
	master := s.paydunyaMasterKey
	token := s.paydunyaToken
	if priv == "" {
		return "", "", fmt.Errorf("PAYDUNYA_API_KEY_PRIVATE absente")
	}
	rateXOF, err := s.fetchExchangeRate(ctx, "XOF")
	if err != nil {
		return "", "", fmt.Errorf("taux XOF indisponible pour la conversion PayDunya: %w", err)
	}
	amountXOF := int64(math.Round(ev.TotalUSD * rateXOF))

	front := s.storefrontURL
	payload := map[string]any{
		"invoice": map[string]any{
			"total_amount": amountXOF,
			"description":  "Commande MIAD " + ev.Reference,
			"items": map[string]any{
				"item_0": map[string]any{
					"name": "Commande " + ev.Reference, "quantity": 1,
					"unit_price": amountXOF, "total_price": amountXOF,
				},
			},
		},
		"store": map[string]any{
			"name": "MIAD Market",
		},
		"actions": map[string]any{
			// Domaine fixe de la passerelle Caddy (voir deploy/Caddyfile) —
			// même convention que les URLs de webhook affichées en
			// Configuration (Stripe/Resend), pas de nouveau champ settings
			// pour une valeur qui ne change jamais en pratique.
			"callback_url": "https://origin.miadmarket.ca/payments/webhook/paydunya",
			// /checkout/success et /checkout/cancel n'ont jamais existé côté
			// frontend (404 confirmé en prod le 2026-08-26, commande 145 —
			// paiement bien confirmé côté backend malgré la 404, donc pas
			// bloquant pour la commande elle-même, juste une mauvaise UX de
			// retour). order-received est la vraie page de confirmation,
			// déjà utilisée par Stripe et déjà écrite pour PayDunya
			// spécifiquement ("PayDunya redirige ici (actions.return_url)
			// avec order_id + token", voir app/order-received/page.tsx) —
			// jamais branchée côté payment-svc jusqu'ici. Pas de page
			// "cancel" dédiée : /checkout est le seul repli existant.
			"return_url": front + "/order-received?order_id=" + strconv.FormatInt(redirectOrderID(ev), 10),
			"cancel_url": front + "/checkout",
		},
		"custom_data": map[string]any{"order_id": ev.OrderID},
	}
	body, _ := json.Marshal(payload)
	// PayDunya a DEUX endpoints distincts pour test et production
	// (sandbox-api/v1/... vs api/v1/...), pas un seul endpoint qui déduit
	// le mode depuis les clés — appeler api/v1/ (prod) avec des clés
	// test_... échoue avec "LIVE Private Key and Token combination is
	// invalid" même si tout le reste (payload, headers) est correct.
	// Confirmé en prod le 2026-08-26 après avoir déjà corrigé l'URL une
	// première fois vers la bonne route /checkout-invoice/create, mais
	// sans distinguer test/prod — mode déduit ici du préfixe test_ sur la
	// clé privée, même logique que stripeMode().
	apiPrefix := "/api/v1"
	if strings.HasPrefix(priv, "test_") {
		apiPrefix = "/sandbox-api/v1"
	}
	base := s.paydunyaAPIBase
	req, _ := http.NewRequest(http.MethodPost, base+apiPrefix+"/checkout-invoice/create", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("PAYDUNYA-MASTER-KEY", master)
	req.Header.Set("PAYDUNYA-PRIVATE-KEY", priv)
	req.Header.Set("PAYDUNYA-PUBLIC-KEY", pub)
	req.Header.Set("PAYDUNYA-TOKEN", token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return "", "", fmt.Errorf("PayDunya a refusé (%d): %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var doc struct {
		ResponseCode string `json:"response_code"`
		ResponseText string `json:"response_text"`
		Token        string `json:"token"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", "", err
	}
	if doc.ResponseCode != "00" || doc.Token == "" {
		return "", "", fmt.Errorf("PayDunya: %s (%s)", doc.ResponseText, doc.ResponseCode)
	}
	return doc.Token, doc.ResponseText, nil
}

// fetchExchangeRate — lit shipping-svc/exchange-rates (source UNIQUE des
// taux, voir shipping-svc/main.go). Échec EXPLICITE si indisponible :
// jamais de taux par défaut codé en dur ici, qui divergerait de la
// table exchange_rates au premier ajustement admin.
func (s *server) fetchExchangeRate(ctx context.Context, currency string) (float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.shippingURL+"/exchange-rates", nil)
	if err != nil {
		return 0, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("shipping-svc injoignable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("shipping-svc a répondu %d", resp.StatusCode)
	}
	var body struct {
		Rates []struct {
			Currency   string  `json:"currency"`
			RatePerUSD float64 `json:"rate_per_usd"`
		} `json:"rates"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0, err
	}
	for _, r := range body.Rates {
		if r.Currency == currency {
			return r.RatePerUSD, nil
		}
	}
	return 0, fmt.Errorf("taux %s absent de exchange_rates", currency)
}

/* ---------- Webhooks ---------- */

// stripeWebhook — vérification de signature via le SDK officiel Stripe
// (github.com/stripe/stripe-go/webhook). Remplace une implémentation HMAC
// manuelle qui contenait un vrai bug : elle retirait le préfixe "whsec_"
// du secret avant de l'utiliser comme clé HMAC. Stripe utilise le secret
// COMPLET (préfixe "whsec_" inclus) comme clé — voir webhook.ComputeSignature
// dans le SDK officiel, `hmac.New(sha256.New, []byte(secret))` sans aucun
// TrimPrefix. Ce bug (distinct du bug base64 corrigé plus tôt) a été
// confirmé le 2026-08-26 en comparant notre calcul manuel à celui du SDK
// officiel sur un vrai payload Stripe : le SDK validait la signature avec
// succès, notre code la rejetait systématiquement (silencieusement, kit.Fail
// ne logue rien) — cause racine du "paiement non confirmé" malgré paiement
// réussi côté Stripe pour toutes les commandes de test de la session.
func (s *server) stripeWebhook(w http.ResponseWriter, r *http.Request) {
	secret := s.stripeWebhookSecret
	if secret == "" {
		kit.Fail(w, 503, "webhook_not_configured", "STRIPE_WEBHOOK_SECRET absente — webhook refusé")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		kit.Fail(w, 400, "body_unreadable", err.Error())
		return
	}
	sig := r.Header.Get("Stripe-Signature")
	stripeEvent, err := webhook.ConstructEventWithOptions(body, sig, secret, webhook.ConstructEventOptions{
		IgnoreAPIVersionMismatch: true,
	})
	if err != nil {
		slog.Error("signature Stripe rejetée", "err", err, "sig_header_present", sig != "", "secret_len", len(secret), "body_len", len(body))
		kit.Fail(w, 401, "bad_signature", "signature Stripe invalide — événement rejeté")
		return
	}
	// stripeEvent.Data.Raw est déjà event.data.object lui-même (le SDK a
	// retiré un niveau d'imbrication par rapport à l'ancien code manuel qui
	// décodait le body entier) — PAS besoin (et ça casse le parsing) d'un
	// wrapper "Object" ici : le charge/payment_intent a lui-même un champ
	// JSON "object" qui est une STRING (ex: "object":"charge"), qui rentre
	// en collision avec un champ Go nommé Object.
	var eventData struct {
		ID       string `json:"id"`
		Metadata struct {
			OrderID string `json:"order_id"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(stripeEvent.Data.Raw, &eventData); err != nil {
		slog.Error("échec parsing event.data.object", "err", err, "type", stripeEvent.Type, "raw_len", len(stripeEvent.Data.Raw), "raw_prefix", string(stripeEvent.Data.Raw[:min(200, len(stripeEvent.Data.Raw))]))
		kit.Fail(w, 400, "invalid_event", err.Error())
		return
	}
	orderID, _ := strconv.ParseInt(eventData.Metadata.OrderID, 10, 64)
	// Log explicite de CHAQUE webhook reçu (type + order_id résolu) : sans
	// ça, un événement Stripe qui tombe dans un cas inattendu (metadata
	// vide, type non géré, orderID=0) échouait silencieusement — kit.Fail
	// n'écrit jamais dans les logs (juste la réponse JSON), donc un 409/500
	// ici était invisible même en lisant les logs du pod (bug de prod
	// trouvé le 2026-08-26 : paiement confirmé côté Stripe, mais order-svc
	// jamais notifié, sans aucune trace exploitable).
	slog.Info("webhook Stripe reçu", "type", stripeEvent.Type, "order_id", orderID, "raw_order_id", eventData.Metadata.OrderID, "payment_intent_id", eventData.ID)
	switch stripeEvent.Type {
	case "payment_intent.succeeded":
		s.confirmPayment(w, r, orderID, "stripe", eventData.ID)
	case "payment_intent.payment_failed", "payment_intent.canceled":
		s.markFailed(w, r, orderID, "stripe")
	default:
		kit.JSON(w, 200, map[string]string{"received": string(stripeEvent.Type)})
	}
}

// paydunyaCallback — PayDunya notifie avec le token de la facture.
// Structure corrigée le 2026-08-26 d'après la doc officielle (IPN), deux
// bugs distincts :
//  1. status est un champ de premier niveau sous "data" (data.status), PAS
//     imbriqué sous data.invoice.status comme le code le lisait avant.
//  2. Le PLUS GRAVE : la doc précise explicitement que PayDunya poste sur
//     le callback en application/x-www-form-urlencoded (clés imbriquées
//     data[status], data[invoice][token]...), PAS en JSON — alors que
//     tout le reste de cette API PayDunya (création de facture, etc.) est
//     du JSON. json.Unmarshal sur un body form-urlencoded échoue toujours
//     en erreur de parsing JSON → 400 invalid_callback, silencieux car
//     kit.Fail ne loggue jamais rien : aucune trace visible côté serveur,
//     alors que le webhook était bien reçu (log "req POST .../paydunya"
//     présent) — ce qui explique la commande jamais confirmée malgré un
//     paiement PayDunya réussi et un callback livré avec succès (HTTP 200
//     implicite de kit.Fail... même ça c'est un problème, voir plus bas).
//     Body lu comme form-urlencoded en priorité (le vrai format PayDunya),
//     JSON en repli pour ne pas casser un éventuel test manuel.
func (s *server) paydunyaCallback(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		kit.Fail(w, 400, "body_unreadable", err.Error())
		return
	}

	status, token := parsePayDunyaCallbackForm(body)
	if token == "" {
		// Repli JSON (jamais confirmé comme format réel par PayDunya, mais
		// coûte rien à essayer avant d'abandonner).
		var doc struct {
			Data struct {
				Status  string `json:"status"`
				Invoice struct {
					Token string `json:"token"`
				} `json:"invoice"`
			} `json:"data"`
		}
		if json.Unmarshal(body, &doc) == nil {
			status, token = doc.Data.Status, doc.Data.Invoice.Token
		}
	}
	if token == "" {
		slog.Error("paydunyaCallback: token introuvable dans le body (ni form-urlencoded ni JSON)", "body_prefix", string(body[:min(200, len(body))]))
		kit.Fail(w, 400, "invalid_callback", "token introuvable dans le body")
		return
	}

	var orderID int64
	if err := s.db.QueryRow(r.Context(), "SELECT order_id FROM payments WHERE provider_ref=$1", token).Scan(&orderID); err != nil {
		slog.Error("paydunyaCallback: token inconnu", "token", token, "status", status)
		kit.Fail(w, 404, "unknown_token", "facture PayDunya inconnue: "+token)
		return
	}
	slog.Info("paydunyaCallback reçu", "order_id", orderID, "token", token, "status", status)
	if strings.EqualFold(status, "completed") {
		s.confirmPayment(w, r, orderID, "paydunya", token)
	} else {
		s.markFailed(w, r, orderID, "paydunya")
	}
}

// parsePayDunyaCallbackForm — extrait data[status] et data[invoice][token]
// d'un body application/x-www-form-urlencoded (le vrai format du callback
// PayDunya, confirmé par leur doc). url.ParseQuery gère nativement les
// clés avec crochets comme des chaînes littérales (pas de nesting réel en
// query string), donc on cherche directement ces clés exactes.
func parsePayDunyaCallbackForm(body []byte) (status, token string) {
	values, err := url.ParseQuery(string(body))
	if err != nil {
		return "", ""
	}
	return values.Get("data[status]"), values.Get("data[invoice][token]")
}

// pawapayWebhook — callback PawaPay (deposits, payouts, refunds). PawaPay
// POST un JSON à cette URL quand une opération atteint un statut final.
//
// RÈGLE DE SÉCURITÉ NON NÉGOCIABLE (spec §5) : le corps du webhook n'est
// JAMAIS la source de vérité. On n'en extrait QUE l'identifiant de la
// transaction (depositId / payoutId / refundId), puis on RAPPELLE l'API
// PawaPay (GET /v2/deposits/{id} etc.) pour obtenir le statut authoritatif,
// et on ne traite que celui-là. Sans cette re-vérification, quiconque
// connaît cette URL pourrait simuler un paiement réussi en postant un faux
// corps {"status":"COMPLETED"}.
//
// Répond toujours 200 rapidement (PawaPay retente sinon) — même en cas de
// statut transitoire ou d'id inconnu, sauf erreur interne réelle.
func (s *server) pawapayWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		kit.Fail(w, 400, "body_unreadable", err.Error())
		return
	}
	// On ne lit QUE les identifiants — jamais le statut du corps.
	var envelope struct {
		DepositID string `json:"depositId"`
		PayoutID  string `json:"payoutId"`
		RefundID  string `json:"refundId"`
		// PawaPay v2 peut aussi imbriquer sous "data"
		Data struct {
			DepositID string `json:"depositId"`
			PayoutID  string `json:"payoutId"`
			RefundID  string `json:"refundId"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		slog.Error("pawapayWebhook: corps illisible", "err", err, "body_prefix", string(body[:min(200, len(body))]))
		kit.Fail(w, 400, "invalid_body", "JSON attendu")
		return
	}
	depositID := firstNonEmpty(envelope.DepositID, envelope.Data.DepositID)
	payoutID := firstNonEmpty(envelope.PayoutID, envelope.Data.PayoutID)
	refundID := firstNonEmpty(envelope.RefundID, envelope.Data.RefundID)

	ctx := r.Context()
	switch {
	case depositID != "":
		s.pawapayHandleDepositWebhook(ctx, w, r, depositID)
	case payoutID != "":
		s.pawapayHandlePayoutWebhook(ctx, w, payoutID)
	case refundID != "":
		s.pawapayHandleRefundWebhook(ctx, w, refundID)
	default:
		slog.Error("pawapayWebhook: aucun identifiant reconnu dans le corps", "body_prefix", string(body[:min(200, len(body))]))
		kit.JSON(w, 200, map[string]string{"received": "ignored"})
	}
}

// pawapayHandleDepositWebhook — re-vérifie le statut du deposit auprès de
// PawaPay puis confirme/échoue la commande. orderID retrouvé via
// payments.provider_ref = depositId.
func (s *server) pawapayHandleDepositWebhook(ctx context.Context, w http.ResponseWriter, r *http.Request, depositID string) {
	var orderID int64
	if err := s.db.QueryRow(ctx, "SELECT order_id FROM payments WHERE provider_ref=$1 AND provider='pawapay'", depositID).Scan(&orderID); err != nil {
		slog.Error("pawapayWebhook: depositId inconnu", "deposit_id", depositID)
		kit.JSON(w, 200, map[string]string{"received": "unknown_deposit"})
		return
	}
	status, failureCode, err := s.pawapayDepositStatus(ctx, depositID)
	if err != nil {
		slog.Error("pawapayWebhook: re-vérification statut deposit impossible", "deposit_id", depositID, "order_id", orderID, "err", err)
		kit.Fail(w, 502, "pawapay_verify_failed", err.Error())
		return
	}
	slog.Info("pawapayWebhook deposit re-vérifié", "order_id", orderID, "deposit_id", depositID, "authoritative_status", status, "failure_code", failureCode)
	switch {
	case pawapayIsFinalSuccess(status):
		s.confirmPayment(w, r, orderID, "pawapay", depositID)
	case pawapayIsFinalFailure(status):
		s.markFailed(w, r, orderID, "pawapay")
	default:
		// ACCEPTED / PROCESSING / IN_RECONCILIATION — pas encore final,
		// on attend un webhook ultérieur. 200 pour ne pas faire retenter
		// PawaPay en boucle.
		kit.JSON(w, 200, map[string]string{"received": "pending", "status": status})
	}
}

// pawapayHandlePayoutWebhook — re-vérifie le statut du payout et met à jour
// payout_requests. Un payout COMPLETED confirme le versement au vendeur ;
// FAILED laisse la demande en 'approved' avec pawapay_status='FAILED' pour
// relance manuelle (pas de retry automatique aveugle, spec §7.4).
func (s *server) pawapayHandlePayoutWebhook(ctx context.Context, w http.ResponseWriter, payoutID string) {
	var reqID, vendorID int64
	if err := s.db.QueryRow(ctx,
		"SELECT id, vendor_id FROM payout_requests WHERE pawapay_payout_id=$1", payoutID).Scan(&reqID, &vendorID); err != nil {
		slog.Error("pawapayWebhook: payoutId inconnu", "payout_id", payoutID)
		kit.JSON(w, 200, map[string]string{"received": "unknown_payout"})
		return
	}
	status, failureCode, err := s.pawapayPayoutStatus(ctx, payoutID)
	if err != nil {
		slog.Error("pawapayWebhook: re-vérification statut payout impossible", "payout_id", payoutID, "err", err)
		kit.Fail(w, 502, "pawapay_verify_failed", err.Error())
		return
	}
	slog.Info("pawapayWebhook payout re-vérifié", "payout_request_id", reqID, "payout_id", payoutID, "authoritative_status", status, "failure_code", failureCode)
	_, _ = s.db.Exec(ctx, "UPDATE payout_requests SET pawapay_status=$2 WHERE id=$1", reqID, status)
	if pawapayIsFinalSuccess(status) {
		// Le wallet a déjà été débité au moment de l'approbation (voir
		// executePayoutViaPawapay) — ici on marque juste la demande 'paid'.
		_, _ = s.db.Exec(ctx, "UPDATE payout_requests SET status='paid', processed_at=now() WHERE id=$1 AND status != 'paid'", reqID)
		kit.Publish(s.producer, "payout_request.paid", fmt.Sprint(reqID), map[string]any{
			"payout_id": reqID, "vendor_id": vendorID, "provider": "pawapay",
			"at": time.Now().UTC().Format(time.RFC3339),
		})
	} else if pawapayIsFinalFailure(status) {
		slog.Warn("pawapayWebhook: payout échoué — relance manuelle requise", "payout_request_id", reqID, "failure_code", failureCode)
		kit.Publish(s.producer, "payout_request.failed", fmt.Sprint(reqID), map[string]any{
			"payout_id": reqID, "vendor_id": vendorID, "provider": "pawapay", "failure_code": failureCode,
			"at": time.Now().UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]string{"received": "true", "status": status})
}

// pawapayHandleRefundWebhook — re-vérifie le statut du refund et met à jour
// la table refunds.
func (s *server) pawapayHandleRefundWebhook(ctx context.Context, w http.ResponseWriter, refundID string) {
	var id int64
	if err := s.db.QueryRow(ctx, "SELECT id FROM refunds WHERE provider_ref=$1", refundID).Scan(&id); err != nil {
		slog.Error("pawapayWebhook: refundId inconnu", "refund_id", refundID)
		kit.JSON(w, 200, map[string]string{"received": "unknown_refund"})
		return
	}
	status, err := s.pawapayRefundStatus(ctx, refundID)
	if err != nil {
		slog.Error("pawapayWebhook: re-vérification statut refund impossible", "refund_id", refundID, "err", err)
		kit.Fail(w, 502, "pawapay_verify_failed", err.Error())
		return
	}
	slog.Info("pawapayWebhook refund re-vérifié", "refund_id", refundID, "authoritative_status", status)
	_, _ = s.db.Exec(ctx, "UPDATE refunds SET status=$2, updated_at=now() WHERE id=$1", id, strings.ToLower(status))
	kit.JSON(w, 200, map[string]string{"received": "true", "status": status})
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

/* ---------- Mutations ---------- */

// confirmPayment — orderID ici est désormais le PARENT_ORDER_ID (voir
// doc-comment du schema payments) : un seul paiement pour tout le groupe.
// Confirme via POST /orders/parent/{id}/confirm (order-svc), qui bascule
// TOUTES les sous-commandes du groupe en 'paid' d'un coup et renvoie leurs
// ids — nécessaire pour créditer chaque vendeur séparément juste après
// (creditVendorWallet reste par sous-commande : montant/commission propres
// à chaque vendeur, inchangé depuis avant ce refactor).
func (s *server) confirmPayment(w http.ResponseWriter, r *http.Request, orderID int64, provider, ref string) {
	res, err := s.db.Exec(r.Context(), `
		UPDATE payments SET status='confirmed', provider_ref=CASE WHEN provider_ref='' THEN $2 ELSE provider_ref END,
		       confirmed_at=now()
		WHERE order_id=$1 AND status IN ('initiated','failed')`, orderID, ref)
	if err != nil {
		slog.Error("confirmPayment: échec UPDATE", "order_id", orderID, "err", err)
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if res.RowsAffected() == 0 {
		slog.Warn("confirmPayment: aucune ligne payments correspondante (order_id invalide, ou déjà confirmé)", "order_id", orderID)
		kit.Fail(w, 409, "not_confirmable", "aucun paiement en attente pour cette commande")
		return
	}
	kit.Publish(s.producer, "payment.confirmed", fmt.Sprint(orderID), map[string]any{
		"order_id": orderID, "provider": provider, "at": time.Now().UTC().Format(time.RFC3339),
	})
	confirmedSubOrderIDs := []int64{}
	if resp, err := http.Post(fmt.Sprintf("%s/orders/parent/%d/confirm", s.orderURL, orderID), "application/json", nil); err == nil {
		var out struct {
			ConfirmedOrderIDs []int64 `json:"confirmed_order_ids"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&out)
		resp.Body.Close()
		confirmedSubOrderIDs = out.ConfirmedOrderIDs
	} else {
		slog.Error("order-svc injoignable — payment.confirmed reste sur Kafka", "err", err)
	}
	for _, subID := range confirmedSubOrderIDs {
		s.creditVendorWallet(r.Context(), subID)
	}
	kit.JSON(w, 200, map[string]string{"received": "true"})
}

// creditVendorWallet — crédite le wallet du vendeur du montant net (après
// commission plateforme) une fois le paiement confirmé. orderID ici est
// l'id d'UNE sous-commande (1 vendeur par order_id, voir le modèle
// parent/sous-commandes d'order-svc) — appelé une fois par sous-commande
// confirmée par confirmPayment ci-dessus, jamais avec le parent_order_id.
// Jamais bloquant pour la confirmation de paiement elle-même : une erreur
// ici est journalisée, pas remontée au client/webhook (le paiement reste
// confirmé même si le crédit wallet échoue, à réconcilier manuellement).
func (s *server) creditVendorWallet(ctx context.Context, orderID int64) {
	order, err := fetchOrder(ctx, s.orderURL, orderID)
	if err != nil {
		slog.Error("crédit wallet: commande injoignable", "order_id", orderID, "err", err)
		return
	}
	if order.VendorID == 0 {
		return // ligne parent/groupe, pas une sous-commande vendeur
	}

	rate := s.defaultCommissionRate()
	if override, err := fetchVendorCommissionRate(ctx, s.vendorURL, order.VendorID); err == nil && override != nil {
		rate = *override
	}
	// Fraction décimale, pas un pourcentage — voir defaultCommissionRate.
	// vendors.commission_rate (override) suit la même convention : c'est
	// déjà ainsi qu'order-svc.resolveCommissionRate l'utilise (lineTotal *
	// rate, sans division).
	commission := order.TotalUSD * rate
	net := order.TotalUSD - commission

	tx, err := s.db.Begin(ctx)
	if err != nil {
		slog.Error("crédit wallet: transaction impossible", "err", err)
		return
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `
		INSERT INTO vendor_wallets (vendor_id, balance_usd, updated_at) VALUES ($1,$2,now())
		ON CONFLICT (vendor_id) DO UPDATE SET balance_usd = vendor_wallets.balance_usd + $2, updated_at = now()`,
		order.VendorID, net); err != nil {
		slog.Error("crédit wallet: upsert solde échoué", "err", err)
		return
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO wallet_transactions (vendor_id, type, amount_usd, order_id, note)
		VALUES ($1,'sale',$2,$3,'')`, order.VendorID, net, orderID); err != nil {
		slog.Error("crédit wallet: insert ledger vente échoué", "err", err)
		return
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO wallet_transactions (vendor_id, type, amount_usd, order_id, note)
		VALUES ($1,'commission',$2,$3,$4)`, order.VendorID, -commission, orderID,
		fmt.Sprintf("commission %.1f%%", rate)); err != nil {
		slog.Error("crédit wallet: insert ledger commission échoué", "err", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		slog.Error("crédit wallet: commit échoué", "err", err)
	}
}

type orderSummary struct {
	VendorID      int64   `json:"vendor_id"`
	TotalUSD      float64 `json:"total_usd"`
	ParentOrderID int64   `json:"parent_order_id"`
}

func fetchOrder(ctx context.Context, orderURL string, orderID int64) (*orderSummary, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/orders/%d", orderURL, orderID), nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("order-svc a répondu %d", resp.StatusCode)
	}
	var out orderSummary
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

// fetchParentOrder — total agrégé (toutes sous-commandes/vendeurs) d'une
// commande groupée, via GET /orders/parent/{id} (order-svc, getParentOrder).
// "total" y est une STRING formatée (strconv.FormatFloat), pas un float64
// natif comme sur GET /orders/{id} — deux endpoints, deux formats,
// vérifiés séparément plutôt que de supposer qu'ils partagent orderSummary.
func fetchParentOrder(ctx context.Context, orderURL string, parentID int64) (*orderSummary, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/orders/parent/%d", orderURL, parentID), nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("order-svc a répondu %d", resp.StatusCode)
	}
	var out struct {
		Total string `json:"total"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	total, err := strconv.ParseFloat(out.Total, 64)
	if err != nil {
		return nil, fmt.Errorf("total agrégé illisible: %q", out.Total)
	}
	return &orderSummary{TotalUSD: total}, nil
}

func fetchVendorCommissionRate(ctx context.Context, vendorURL string, vendorID int64) (*float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/vendors/%d", vendorURL, vendorID), nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("vendor-svc a répondu %d", resp.StatusCode)
	}
	var out struct {
		CommissionRate *float64 `json:"commission_rate"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.CommissionRate, nil
}

func (s *server) markFailed(w http.ResponseWriter, r *http.Request, orderID int64, provider string) {
	_, _ = s.db.Exec(r.Context(), "UPDATE payments SET status='failed' WHERE order_id=$1 AND status='initiated'", orderID)
	kit.Publish(s.producer, "payment.failed", fmt.Sprint(orderID), map[string]any{
		"order_id": orderID, "provider": provider, "at": time.Now().UTC().Format(time.RFC3339),
	})
	kit.JSON(w, 200, map[string]string{"received": "true"})
}

/* ---------- Lectures ---------- */

// initPayment — SYNCHRONE, contrairement au flux Kafka pur historique.
// Le frontend (Stripe Elements) a besoin du client_secret immédiatement
// pour afficher son formulaire de carte ; il ne peut pas attendre le
// consommateur order.created. Idempotent : si le PaymentIntent existe
// déjà (créé par initiateFor ou un appel précédent), le renvoie tel quel
// plutôt que d'en créer un second pour la même commande.
func (s *server) initPayment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OrderID   int64  `json:"order_id"`
		Reference string `json:"reference"`
		// PawaPay uniquement : la Payment Page hébergée a besoin du pays de
		// l'acheteur (devise + return_url) et, en valeur par défaut
		// facultative, de son téléphone. Renseignés par le frontend depuis
		// l'adresse de livraison déjà saisie au checkout. Ignorés pour
		// Stripe/PayDunya.
		BuyerCountry string `json:"buyer_country"` // ISO2 (ex. "sn")
		BuyerPhone   string `json:"buyer_phone"`   // format libre, normalisé côté serveur
		BuyerEmail   string `json:"buyer_email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.OrderID == 0 {
		kit.Fail(w, 400, "invalid_body", "order_id obligatoire")
		return
	}
	ctx := r.Context()

	var id int64
	var provider, status, redirect, ref, clientSecret string
	var amount float64
	err := s.db.QueryRow(ctx, `
		SELECT id, provider, amount_usd, status, redirect_url, provider_ref, client_secret
		FROM payments WHERE order_id=$1 ORDER BY id DESC LIMIT 1`, body.OrderID,
	).Scan(&id, &provider, &amount, &status, &redirect, &ref, &clientSecret)
	if err != nil {
		kit.Fail(w, 404, "payment_not_found",
			fmt.Sprintf("aucun paiement pour la commande %d — order.created a-t-il été consommé ?", body.OrderID))
		return
	}

	if provider == "stripe" && clientSecret == "" && (status == "initiated" || status == "failed") {
		reference := body.Reference
		if reference == "" {
			reference = fmt.Sprintf("MIAD-%d", body.OrderID)
		}
		piID, secret, err := s.createStripePaymentIntent(body.OrderID, reference, amount)
		if err != nil {
			kit.Fail(w, 502, "stripe_error", fmt.Sprintf("création du PaymentIntent impossible: %v", err))
			return
		}
		if _, err := s.db.Exec(ctx,
			"UPDATE payments SET provider_ref=$2, client_secret=$3, status='initiated' WHERE id=$1",
			id, piID, secret); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		ref, clientSecret = piID, secret
	}

	// PayDunya : jusqu'ici la facture n'était créée que par initiateFor
	// (consommateur Kafka order.created), de façon ASYNCHRONE — /api/orders
	// côté frontend appelle POST /payments/init immédiatement après avoir
	// créé la commande, souvent avant que ce consommateur ait eu le temps
	// de tourner. Résultat : réponse 200 OK mais redirect_url="" (pas une
	// erreur HTTP, donc le retry frontend — qui ne retente que sur !res.ok
	// — ne se déclenchait jamais), d'où paydunyaToken/paydunyaUrl vides
	// côté client malgré une commande valide. Symptôme confondu une
	// première fois avec l'instabilité réseau réelle de PayDunya ("Too many
	// connections", cause distincte, vraie mais pas la seule) — les deux
	// se manifestent de la même façon côté client. Fix : créer la facture
	// ici à la demande si elle n'existe pas encore, même principe que
	// Stripe juste au-dessus, élimine la race condition à la racine plutôt
	// que de rallonger un retry côté frontend.
	if provider == "paydunya" && redirect == "" && (status == "initiated" || status == "failed") {
		// Verrou anti-doublon (2026-08-27) : ce chemin ET initiateFor
		// (consommateur Kafka order.created) peuvent tenter de créer la
		// facture PayDunya pour LA MÊME commande quasi simultanément — le
		// frontend appelle POST /payments/init immédiatement après avoir
		// créé la commande, souvent à quelques centaines de ms de l'event
		// Kafka. Sans verrou, les deux font un appel réseau réel vers
		// PayDunya en parallèle pour rien (constaté en logs : un appel via
		// initiateFor échoue "Too many connections" à 00:47:17.311, suivi
		// 400ms après d'un POST /payments/init de 522ms — durée cohérente
		// avec un DEUXIÈME appel réseau vers PayDunya, jamais loggé car
		// kit.Fail ne loggue rien). Ce UPDATE conditionnel fait office de
		// verrou : seule LA requête qui gagne la course passe status à
		// 'creating' et a le droit d'appeler PayDunya ; l'autre voit
		// RowsAffected()=0 et repart sans jamais toucher le réseau.
		locked, err := s.db.Exec(ctx,
			"UPDATE payments SET status='creating' WHERE id=$1 AND status IN ('initiated','failed')", id)
		if err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		if locked.RowsAffected() == 0 {
			kit.Fail(w, 409, "paydunya_creating", "création de la facture PayDunya déjà en cours — réessayez dans un instant")
			return
		}
		reference := body.Reference
		if reference == "" {
			reference = fmt.Sprintf("MIAD-%d", body.OrderID)
		}
		// body.OrderID EST le parent_order_id ici (payments.order_id stocke
		// le parent depuis le 2026-08-26, voir doc-comment du schema) — pas
		// besoin de le résoudre via fetchOrder, il sert directement de
		// ParentOrderID pour que createPayDunyaInvoice construise la bonne
		// return_url (order-received?order_id=<parent>).
		pdRef, pdRedirect, err := s.createPayDunyaInvoice(ctx, orderCreatedEvent{
			OrderID: body.OrderID, ParentOrderID: body.OrderID, Reference: reference, TotalUSD: amount,
		})
		if err != nil {
			_, _ = s.db.Exec(ctx, "UPDATE payments SET status='failed' WHERE id=$1", id)
			slog.Error("initPayment: création de facture PayDunya impossible", "order_id", body.OrderID, "err", err)
			kit.Fail(w, 502, "paydunya_error", fmt.Sprintf("création de la facture PayDunya impossible: %v", err))
			return
		}
		if _, err := s.db.Exec(ctx,
			"UPDATE payments SET provider_ref=$2, redirect_url=$3, status='initiated' WHERE id=$1",
			id, pdRef, pdRedirect); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		ref, redirect = pdRef, pdRedirect
	}

	// PawaPay : même principe que PayDunya juste au-dessus — session de
	// Payment Page hébergée créée à la demande ici (initiateFor ne peut pas
	// la créer, il n'a ni le pays ni le téléphone de l'acheteur). Même
	// verrou anti-doublon 'creating'. depositId (UUID v4) stocké en
	// provider_ref : c'est la clé de corrélation du webhook pawapayWebhook.
	if provider == "pawapay" && redirect == "" && (status == "initiated" || status == "failed") {
		locked, err := s.db.Exec(ctx,
			"UPDATE payments SET status='creating' WHERE id=$1 AND status IN ('initiated','failed')", id)
		if err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		if locked.RowsAffected() == 0 {
			kit.Fail(w, 409, "pawapay_creating", "création de la page de paiement PawaPay déjà en cours — réessayez dans un instant")
			return
		}
		reference := body.Reference
		if reference == "" {
			reference = fmt.Sprintf("MIAD-%d", body.OrderID)
		}
		depositID, ppRedirect, err := s.createPawaPayPaymentPage(ctx,
			orderCreatedEvent{OrderID: body.OrderID, ParentOrderID: body.OrderID, Reference: reference, TotalUSD: amount},
			body.BuyerCountry, body.BuyerPhone, body.BuyerEmail)
		if err != nil {
			_, _ = s.db.Exec(ctx, "UPDATE payments SET status='failed' WHERE id=$1", id)
			slog.Error("initPayment: création de la page PawaPay impossible", "order_id", body.OrderID, "err", err)
			kit.Fail(w, 502, "pawapay_error", fmt.Sprintf("création de la page de paiement PawaPay impossible: %v", err))
			return
		}
		if _, err := s.db.Exec(ctx,
			"UPDATE payments SET provider_ref=$2, redirect_url=$3, status='initiated' WHERE id=$1",
			id, depositID, ppRedirect); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		ref, redirect = depositID, ppRedirect
	}

	kit.JSON(w, 200, map[string]any{
		"payment": map[string]any{
			"order_id": body.OrderID, "provider": provider, "provider_ref": ref,
			"amount_usd": amount, "currency": "USD", "status": status,
		},
		"client_secret": clientSecret, // Stripe Elements (vide pour PayDunya/PawaPay)
		"redirect_url":  redirect,     // PayDunya (facture) ou PawaPay (Payment Page)
	})
}

func (s *server) listPayments(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(kit.EnvOr(r.URL.Query().Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(r.URL.Query().Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}
	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM payments").Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT id, order_id, provider, amount_usd, status, method, created_at FROM payments
		ORDER BY id DESC LIMIT `+strconv.Itoa(pageSize)+` OFFSET `+strconv.Itoa((page-1)*pageSize))
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, orderID int64
		var amount float64
		var provider, status, method string
		var at time.Time
		_ = rows.Scan(&id, &orderID, &provider, &amount, &status, &method, &at)
		items = append(items, map[string]any{
			"id": id, "order_id": orderID, "provider": provider,
			"amount_usd": amount, "currency": "USD", "status": status, "method": method,
			"created_at": at.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

func (s *server) getPayment(w http.ResponseWriter, r *http.Request) {
	var orderID int64
	fmt.Sscanf(r.PathValue("order_id"), "%d", &orderID)
	row := s.db.QueryRow(r.Context(), `
		SELECT id, order_id, provider, provider_ref, amount_usd, currency, status, method, created_at
		FROM payments WHERE order_id=$1 ORDER BY id DESC LIMIT 1`, orderID)
	var id int64
	var amount float64
	var provider, ref, currency, status, method string
	var at time.Time
	if err := row.Scan(&id, &orderID, &provider, &ref, &amount, &currency, &status, &method, &at); err != nil {
		kit.Fail(w, 404, "payment_not_found", fmt.Sprintf("aucun paiement pour la commande %d", orderID))
		return
	}
	kit.JSON(w, 200, map[string]any{
		"id": id, "order_id": orderID, "provider": provider, "provider_ref": ref,
		"amount_usd": amount, "currency": currency, "status": status, "method": method,
		"created_at": at.UTC().Format(time.RFC3339),
	})
}

/* ---------- adaptateur consommateur ---------- */

type consumerFunc func(ctx context.Context, msg *sarama.ConsumerMessage)

func (f consumerFunc) Setup(sarama.ConsumerGroupSession) error   { return nil }
func (f consumerFunc) Cleanup(sarama.ConsumerGroupSession) error { return nil }
func (f consumerFunc) ConsumeClaim(sess sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
	for msg := range claim.Messages() {
		f(sess.Context(), msg)
		sess.MarkMessage(msg, "")
	}
	return nil
}

func atoi(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

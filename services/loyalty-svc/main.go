// ============================================================
// loyalty-svc — coins/fidélité (ledger complet) + représentants pays.
// Remplace le blob meta _miad_coins_history (capé à 60 entrées) par
// une vraie table coin_transactions : ledger complet, jamais tronqué.
// Publie : coins.awarded, message.created
// ============================================================
package main

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/IBM/sarama"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/miadmarket/miad-backend/internal/kit"
)

const schema = `
-- ---------- Coins / fidélité ----------
-- Ledger complet : chaque gain/dépense est une ligne, jamais résumé
-- ni tronqué (contrairement au blob meta _miad_coins_history, capé
-- à 60 entrées, du PHP historique).
CREATE TABLE IF NOT EXISTS coin_transactions (
  id          BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  amount      BIGINT NOT NULL,       -- positif = gain, négatif = dépense
  reason      TEXT NOT NULL,         -- daily_bonus | order_reward | coupon_redeemed | admin_adjustment
  reference   TEXT DEFAULT '',       -- ex. order_id, coupon_code
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coin_tx_customer ON coin_transactions (customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coupons (
  code       TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('percent','fixed')),
  amount     BIGINT NOT NULL,
  coin_cost  BIGINT NOT NULL DEFAULT 0, -- 0 = coupon non échangeable contre des coins
  expires_at TIMESTAMPTZ,
  max_uses   INT NOT NULL DEFAULT 0,
  used_count INT NOT NULL DEFAULT 0
);

-- ---------- Représentants pays ----------
CREATE TABLE IF NOT EXISTS representatives (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  country       TEXT NOT NULL,          -- ISO alpha-2 ; portée globale si is_super_rep
  is_super_rep  BOOLEAN NOT NULL DEFAULT FALSE,
  commission_pct REAL NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Parrainage : fonctionnalité neuve (n'existait pas côté WooCommerce),
-- referral_code généré à la première consultation du dashboard (pas à la
-- création du représentant — évite de générer un code jamais utilisé
-- pour un représentant créé manuellement sans jamais se connecter).
ALTER TABLE representatives ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
-- Import depuis WordPress (2026-08-26, miad_representative/miad_super_rep) :
-- wp_user_id sert à éviter les doublons si le même compte est ré-importé,
-- whatsapp vient de la meta miad_rep_whatsapp (miad-representative.php).
ALTER TABLE representatives ADD COLUMN IF NOT EXISTS wp_user_id BIGINT UNIQUE;
ALTER TABLE representatives ADD COLUMN IF NOT EXISTS whatsapp TEXT;

-- Un client parrainé (via ?ref=<code> au moment de l'inscription, câblé
-- côté auth-svc/registerCustomer) est enregistré UNE fois — pas de
-- double-parrainage. Les totaux (commandes/CA) restent calculés à la
-- volée depuis order-svc (customer_id), pas dupliqués ici : cette table
-- ne fait que la liaison représentant ↔ client parrainé.
CREATE TABLE IF NOT EXISTS referrals (
  representative_id BIGINT NOT NULL REFERENCES representatives(id),
  customer_id        BIGINT NOT NULL UNIQUE, -- un client n'a qu'un seul parrain
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referrals_rep ON referrals (representative_id);

CREATE TABLE IF NOT EXISTS rep_messages (
  id             BIGSERIAL PRIMARY KEY,
  representative_id BIGINT NOT NULL REFERENCES representatives(id),
  customer_id    BIGINT NOT NULL,
  subject        TEXT DEFAULT '',
  body           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open', -- open | answered | closed
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rep_message_replies (
  id         BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES rep_messages(id),
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rep_order_acknowledgements (
  order_id          BIGINT PRIMARY KEY,
  representative_id BIGINT NOT NULL REFERENCES representatives(id),
  acknowledged_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- WhatsApp (Twilio) ----------
-- Reprend le plugin WordPress "MIAD Representative Manager" (notifications
-- représentant/super-rep + admin à la confirmation vendeur, notifications
-- client à chaque étape de livraison), perdu lors de la migration hors
-- WordPress. Chaque envoi (et chaque réception via le webhook entrant) est
-- journalisé ici, succès ou échec — jamais silencieux.
CREATE TABLE IF NOT EXISTS whatsapp_logs (
  id             BIGSERIAL PRIMARY KEY,
  direction      TEXT NOT NULL DEFAULT 'out', -- out | in (webhook Twilio)
  phone          TEXT NOT NULL DEFAULT '',
  recipient_type TEXT NOT NULL DEFAULT '',    -- representative | super_rep | admin | client
  order_id       BIGINT,
  template_sid   TEXT DEFAULT '',
  message_body   TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'queued', -- queued | sent | failed
  error          TEXT DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_order ON whatsapp_logs (order_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_created ON whatsapp_logs (created_at DESC);
`

type server struct {
	db        *pgxpool.Pool
	kafka     sarama.SyncProducer
	vendorURL string
	orderURL  string
	emailURL  string

	settings *kit.SettingsStore
	// Champs pointés par settings (voir NewSettingsStore) — mêmes garanties
	// que payment-svc/notification-svc : jamais lus directement ailleurs
	// que via ces champs après settings.Load()/Save().
	twilioAccountSID            string
	twilioAuthToken             string
	twilioWhatsappFrom          string
	twilioAdminNumbers          string // liste séparée par virgule, ex: "+221771234567,+33612345678"
	twilioEnableRep             string // "yes" / "no" — texte plutôt que bool, SettingsField n'a que des *string
	twilioEnableAdmin           string
	twilioEnableClient          string
	twilioTemplateRepNewOrder   string // Content SID Twilio (HXxxxx...) — vide = repli texte brut
	twilioTemplateClientConfirm string
	twilioTemplateClientShipped string
	twilioTemplateAdminNewOrder string
}

const settingsTable = "loyalty_settings"

func (s *server) settingsFields() []kit.SettingsField {
	return []kit.SettingsField{
		{Key: "twilio_account_sid", Ptr: &s.twilioAccountSID, Secret: true, Description: "Account SID Twilio (notifications WhatsApp)"},
		{Key: "twilio_auth_token", Ptr: &s.twilioAuthToken, Secret: true, Description: "Auth Token Twilio"},
		{Key: "twilio_whatsapp_from", Ptr: &s.twilioWhatsappFrom, Description: "Numéro WhatsApp Business Twilio (ex: whatsapp:+14155238886)"},
		{Key: "twilio_admin_numbers", Ptr: &s.twilioAdminNumbers, Description: "Numéros WhatsApp admin à notifier, séparés par une virgule"},
		{Key: "twilio_enable_rep", Ptr: &s.twilioEnableRep, Description: "Activer les notifications WhatsApp aux représentants (yes/no)"},
		{Key: "twilio_enable_admin", Ptr: &s.twilioEnableAdmin, Description: "Activer les notifications WhatsApp à l'admin (yes/no)"},
		{Key: "twilio_enable_client", Ptr: &s.twilioEnableClient, Description: "Activer les notifications WhatsApp aux clients (yes/no)"},
		{Key: "twilio_template_rep_new_order", Ptr: &s.twilioTemplateRepNewOrder, Description: "Content SID — représentant, nouvelle commande"},
		{Key: "twilio_template_client_confirm", Ptr: &s.twilioTemplateClientConfirm, Description: "Content SID — client, confirmation paiement"},
		{Key: "twilio_template_client_shipped", Ptr: &s.twilioTemplateClientShipped, Description: "Content SID — client, expédition/international"},
		{Key: "twilio_template_admin_new_order", Ptr: &s.twilioTemplateAdminNewOrder, Description: "Content SID — admin, nouvelle commande"},
	}
}

func main() {
	ctx := context.Background()
	log := kit.Logger("loyalty-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_LOYALTY", "postgres://miad:miad@postgres:5432/miad_loyalty?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema+kit.SettingsStoreSchema(settingsTable)); err != nil {
		log.Error("migration impossible", "err", err)
		return
	}

	s := &server{
		db:        db,
		kafka:     kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		vendorURL: kit.Env("VENDOR_SVC_URL", "http://vendor-svc:8082"),
		orderURL:  kit.Env("ORDER_SVC_URL", "http://order-svc:8083"),
		emailURL:  kit.Env("EMAIL_SVC_URL", "http://email-svc:8089"),

		twilioAccountSID:   kit.Env("TWILIO_ACCOUNT_SID", ""),
		twilioAuthToken:    kit.Env("TWILIO_AUTH_TOKEN", ""),
		twilioWhatsappFrom: kit.Env("TWILIO_WHATSAPP_FROM", ""),
		twilioEnableRep:    kit.Env("TWILIO_ENABLE_REP", "yes"),
		twilioEnableAdmin:  kit.Env("TWILIO_ENABLE_ADMIN", "no"),
		twilioEnableClient: kit.Env("TWILIO_ENABLE_CLIENT", "no"),
	}
	s.settings = kit.NewSettingsStore(db, settingsTable, s.settingsFields())
	if err := s.settings.Load(ctx); err != nil {
		log.Error("chargement loyalty_settings impossible", "err", err)
	}

	// Module Parrainage : un client inscrit avec ?ref=<code> est lié à son
	// représentant via cet événement, plutôt qu'un appel HTTP synchrone
	// depuis auth-svc/registerCustomer (couplage dur évité — l'inscription
	// ne doit jamais échouer à cause d'un souci de parrainage).
	go s.consumeCustomerEvents(log)
	// Notifications WhatsApp : commande confirmée (représentant/admin) et
	// changement d'étape de livraison (client) — voir consumeWhatsappEvents.
	go s.consumeWhatsappEvents(log)

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	health.Add("twilio_credentials", func(ctx context.Context) error {
		if s.twilioAccountSID == "" || s.twilioAuthToken == "" {
			return fmt.Errorf("clés Twilio absentes — notifications WhatsApp journalisées sans envoi réel")
		}
		return nil
	})

	kit.Run("loyalty-svc", kit.Env("PORT_LOYALTY", "8091"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("GET /settings", s.getSettings)
		mux.HandleFunc("PUT /settings", s.putSettings)

		// Coins
		mux.HandleFunc("GET /coins/{customer_id}", s.getCoins)
		mux.HandleFunc("POST /coins/daily", s.claimDaily)
		mux.HandleFunc("GET /coins/leaderboard", s.leaderboard)
		mux.HandleFunc("GET /coupons", s.listCoupons)
		mux.HandleFunc("POST /coupons/validate", s.validateCoupon)

		// WhatsApp (Twilio)
		mux.HandleFunc("GET /whatsapp/logs", s.listWhatsappLogs)
		mux.HandleFunc("POST /whatsapp/resend/{order_id}", s.resendWhatsappForOrder)
		mux.HandleFunc("POST /whatsapp/incoming", s.whatsappIncomingWebhook)

		// Représentants
		// "representatives" (pluriel, sans variable) — pas de conflit avec
		// "representative/{id}" (segment littéral différent : les deux
		// premiers segments distinguent déjà les patterns).
		mux.HandleFunc("GET /representatives", s.listRepresentatives)
		mux.HandleFunc("GET /representative/{id}", s.getRepresentative)
		// by-country (pas /representative/country/{country}) : {id} et
		// country/{country} sont tous deux à profondeur 2, {id}/dashboard
		// (profondeur 3) était ambigu avec eux — net/http (Go 1.22+) panique
		// au démarrage sur un conflit de pattern, pas un simple avertissement
		// (confirmé le 2026-08-24, premier déploiement réel).
		// dashboard/{id} (pas /representative/{id}/dashboard) : un segment
		// littéral suivi d'une variable ne peut jamais être ambigu avec
		// by-country/{country} (même forme), contrairement à {id}/dashboard
		// qui inverse variable et littéral et rend les deux patterns
		// indécidables pour net/http (Go 1.22+ panique au démarrage sur ce
		// genre de conflit — confirmé deux fois de suite le 2026-08-24,
		// premier déploiement réel).
		mux.HandleFunc("GET /representative/by-country/{country}", s.getRepresentativeByCountry)
		// by-email/{email} : même forme (littéral + variable) que
		// by-country/{country} — pas de risque de conflit avec dashboard/{id}
		// (voir note ci-dessus). Résout un représentant à partir de l'email
		// porté par le JWT (auth-svc n'a pas de claim representative_id dédié).
		mux.HandleFunc("GET /representative/by-email/{email}", s.getRepresentativeByEmail)
		mux.HandleFunc("GET /representative/dashboard/{id}", s.repDashboard)
		mux.HandleFunc("POST /representative/messages", s.createMessage)
		mux.HandleFunc("GET /representative/messages", s.listMessages)
		mux.HandleFunc("PATCH /representative/messages/{id}", s.updateMessageStatus)
		mux.HandleFunc("POST /representative/messages/{id}/reply", s.replyMessage)
		mux.HandleFunc("POST /representative/orders/{id}/acknowledge", s.acknowledgeOrder)
	})
}

/* ---------- Coins ---------- */

func (s *server) getCoins(w http.ResponseWriter, r *http.Request) {
	customerID, err := strconv.ParseInt(r.PathValue("customer_id"), 10, 64)
	if err != nil {
		kit.Fail(w, 400, "invalid_customer_id", "customer_id invalide")
		return
	}
	var balance int64
	if err := s.db.QueryRow(r.Context(),
		"SELECT COALESCE(SUM(amount),0) FROM coin_transactions WHERE customer_id = $1", customerID,
	).Scan(&balance); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	page, _ := strconv.Atoi(kit.EnvOr(r.URL.Query().Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(r.URL.Query().Get("page_size"), "50"))
	if page < 1 {
		page = 1
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT amount, reason, reference, created_at FROM coin_transactions
		WHERE customer_id = $1 ORDER BY created_at DESC
		LIMIT `+strconv.Itoa(pageSize)+` OFFSET `+strconv.Itoa((page-1)*pageSize), customerID)
	history := []map[string]any{}
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var amount int64
			var reason, ref string
			var at time.Time
			_ = rows.Scan(&amount, &reason, &ref, &at)
			history = append(history, map[string]any{
				"amount": amount, "reason": reason, "reference": ref,
				"created_at": at.UTC().Format(time.RFC3339),
			})
		}
	}
	kit.JSON(w, 200, map[string]any{
		"customer_id": customerID, "balance": balance,
		"history": history, "page": page, "page_size": pageSize,
	})
}

// claimDaily — un seul bonus par jour civil UTC par client, vérifié
// EXPLICITEMENT en base (jamais de confiance dans le client).
func (s *server) claimDaily(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CustomerID int64 `json:"customer_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.CustomerID == 0 {
		kit.Fail(w, 400, "missing_customer_id", "customer_id obligatoire")
		return
	}
	var already bool
	err := s.db.QueryRow(r.Context(), `
		SELECT EXISTS(
			SELECT 1 FROM coin_transactions
			WHERE customer_id = $1 AND reason = 'daily_bonus'
			AND created_at >= date_trunc('day', now())
		)`, body.CustomerID).Scan(&already)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if already {
		kit.Fail(w, 409, "already_claimed", "bonus quotidien déjà réclamé aujourd'hui")
		return
	}
	const dailyAmount = 10
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO coin_transactions (customer_id, amount, reason) VALUES ($1,$2,'daily_bonus')`,
		body.CustomerID, dailyAmount); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.Publish(s.kafka, "coins.awarded", fmt.Sprint(body.CustomerID), map[string]any{
		"customer_id": body.CustomerID, "amount": dailyAmount, "reason": "daily_bonus",
		"at": time.Now().UTC().Format(time.RFC3339),
	})
	kit.JSON(w, 200, map[string]any{"customer_id": body.CustomerID, "awarded": dailyAmount})
}

func (s *server) leaderboard(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(kit.EnvOr(r.URL.Query().Get("limit"), "20"))
	if limit < 1 || limit > 100 {
		limit = 20
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT customer_id, SUM(amount) as balance FROM coin_transactions
		GROUP BY customer_id ORDER BY balance DESC LIMIT `+strconv.Itoa(limit))
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	rank := 1
	for rows.Next() {
		var customerID, balance int64
		_ = rows.Scan(&customerID, &balance)
		items = append(items, map[string]any{"rank": rank, "customer_id": customerID, "balance": balance})
		rank++
	}
	kit.JSON(w, 200, map[string]any{"leaderboard": items})
}

func (s *server) listCoupons(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `
		SELECT code, type, amount, coin_cost, expires_at, max_uses, used_count FROM coupons ORDER BY code`)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var code, cType string
		var amount, coinCost int64
		var maxUses, usedCount int
		var expiresAt *time.Time
		_ = rows.Scan(&code, &cType, &amount, &coinCost, &expiresAt, &maxUses, &usedCount)
		item := map[string]any{
			"code": code, "type": cType, "amount": amount, "coin_cost": coinCost,
			"max_uses": maxUses, "used_count": usedCount,
		}
		if expiresAt != nil {
			item["expires_at"] = expiresAt.UTC().Format(time.RFC3339)
		}
		items = append(items, item)
	}
	kit.JSON(w, 200, map[string]any{"coupons": items})
}

func (s *server) validateCoupon(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	var cType string
	var amount, maxUses, usedCount int64
	var expiresAt *time.Time
	err := s.db.QueryRow(r.Context(), `
		SELECT type, amount, expires_at, max_uses, used_count FROM coupons WHERE code = $1`, body.Code,
	).Scan(&cType, &amount, &expiresAt, &maxUses, &usedCount)
	if err == pgx.ErrNoRows {
		kit.Fail(w, 404, "coupon_not_found", "code promo inconnu")
		return
	} else if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if expiresAt != nil && time.Now().After(*expiresAt) {
		kit.Fail(w, 410, "coupon_expired", "code promo expiré")
		return
	}
	if maxUses > 0 && usedCount >= maxUses {
		kit.Fail(w, 409, "coupon_exhausted", "code promo épuisé")
		return
	}
	kit.JSON(w, 200, map[string]any{"code": body.Code, "type": cType, "amount": amount, "valid": true})
}

/* ---------- Parrainage : consommation customer.registered ---------- */

// consumeCustomerEvents — même pattern que fulfillment-svc.consumeOrderEvents
// (retry/backoff sur Kafka indisponible, jamais fatal pour le service).
func (s *server) consumeCustomerEvents(log *slog.Logger) {
	brokers := kit.Env("KAFKA_BROKERS", "kafka:9092")
	if brokers == "" {
		log.Warn("KAFKA_BROKERS vide — consommation désactivée (mode dev)")
		return
	}
	cfg := sarama.NewConfig()
	cfg.Consumer.Offsets.Initial = sarama.OffsetOldest
	cfg.Version = sarama.V2_8_0_0

	for {
		group, err := sarama.NewConsumerGroup([]string{brokers}, "loyalty-svc", cfg)
		if err != nil {
			log.Error("kafka injoignable — retry 5 s", "err", err)
			time.Sleep(5 * time.Second)
			continue
		}
		handler := loyaltyConsumer{s: s, log: log}
		_ = group.Consume(context.Background(), []string{"customer.registered"}, handler)
		group.Close()
	}
}

type loyaltyConsumer struct {
	s   *server
	log *slog.Logger
}

func (c loyaltyConsumer) Setup(sarama.ConsumerGroupSession) error   { return nil }
func (c loyaltyConsumer) Cleanup(sarama.ConsumerGroupSession) error { return nil }
func (c loyaltyConsumer) ConsumeClaim(sess sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
	for msg := range claim.Messages() {
		var payload struct {
			CustomerID   int64  `json:"customer_id"`
			ReferralCode string `json:"referral_code"`
		}
		if err := json.Unmarshal(msg.Value, &payload); err == nil && payload.ReferralCode != "" && payload.CustomerID > 0 {
			c.s.linkReferral(sess.Context(), c.log, payload.CustomerID, payload.ReferralCode)
		}
		sess.MarkMessage(msg, "")
	}
	return nil
}

// linkReferral — best-effort : un code invalide/inconnu ne doit jamais
// faire échouer l'inscription (déjà actée côté auth-svc, publiée avant
// que ce handler ne s'exécute). ON CONFLICT (customer_id) DO NOTHING :
// un client déjà parrainé garde son premier parrain, jamais réécrasé par
// un second referral_code (ex: reconsommation du même événement Kafka).
func (s *server) linkReferral(ctx context.Context, log *slog.Logger, customerID int64, code string) {
	var repID int64
	if err := s.db.QueryRow(ctx,
		"SELECT id FROM representatives WHERE referral_code = $1", code,
	).Scan(&repID); err != nil {
		log.Info("code de parrainage inconnu, ignoré", "customer_id", customerID, "code", code)
		return
	}
	if _, err := s.db.Exec(ctx,
		"INSERT INTO referrals (representative_id, customer_id) VALUES ($1,$2) ON CONFLICT (customer_id) DO NOTHING",
		repID, customerID,
	); err != nil {
		log.Error("liaison parrainage échouée", "customer_id", customerID, "representative_id", repID, "err", err)
	}
}

// ensureReferralCode — génère le code au premier accès (pas à la création
// du représentant, voir doc-comment du schéma) : 8 caractères
// alphanumériques majuscules, assez court pour être partagé oralement,
// assez d'entropie pour ~des centaines de représentants sans collision
// pratique (36^8). Retry sur collision UNIQUE plutôt que de la prévenir
// (assez rare pour ne jamais boucler plus d'une fois en pratique).
func (s *server) ensureReferralCode(ctx context.Context, repID int64) string {
	var existing *string
	_ = s.db.QueryRow(ctx, "SELECT referral_code FROM representatives WHERE id = $1", repID).Scan(&existing)
	if existing != nil && *existing != "" {
		return *existing
	}
	for attempt := 0; attempt < 5; attempt++ {
		code := randomReferralCode()
		if _, err := s.db.Exec(ctx,
			"UPDATE representatives SET referral_code = $1 WHERE id = $2", code, repID); err == nil {
			return code
		}
	}
	return "" // 5 collisions de suite — statistiquement jamais atteint, dashboard affiche "indisponible" plutôt que planter
}

const referralAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // sans O/0/I/1 (ambiguïté visuelle à l'oral/écrit)

func randomReferralCode() string {
	b := make([]byte, 8)
	for i := range b {
		n, err := crand.Int(crand.Reader, big.NewInt(int64(len(referralAlphabet))))
		if err != nil {
			// crypto/rand indisponible : cas quasi inexistant en pratique — un
			// code prévisible dans ce scénario dégradé reste préférable à un
			// crash du dashboard représentant.
			b[i] = referralAlphabet[i%len(referralAlphabet)]
			continue
		}
		b[i] = referralAlphabet[n.Int64()]
	}
	return string(b)
}

/* ---------- Représentants pays ---------- */

// listRepresentatives — module Utilisateurs (back-office) : nécessaire
// pour croiser par email avec customers/admins et afficher les rôles
// cumulés d'un même compte (voir admin-svc.listUnifiedUsers).
func (s *server) listRepresentatives(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(),
		"SELECT id, name, email, country, is_super_rep, commission_pct, created_at FROM representatives ORDER BY id")
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var name, email, country string
		var isSuper bool
		var commission float32
		var at time.Time
		if err := rows.Scan(&id, &name, &email, &country, &isSuper, &commission, &at); err != nil {
			kit.Fail(w, 500, "db_error", "lecture représentant échouée : "+err.Error())
			return
		}
		items = append(items, map[string]any{
			"id": id, "name": name, "email": email, "country": country,
			"is_super_rep": isSuper, "commission_pct": commission,
			"created_at": at.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{"items": items, "total": len(items)})
}

func (s *server) getRepresentative(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		kit.Fail(w, 400, "invalid_id", "id invalide")
		return
	}
	s.writeRepresentative(w, r, "id", id)
}

func (s *server) getRepresentativeByCountry(w http.ResponseWriter, r *http.Request) {
	country := r.PathValue("country")
	// Résolution : représentant pays exact, sinon repli sur un super-rep
	// (portée globale) — jamais un pays sans réponse silencieuse.
	var id int64
	err := s.db.QueryRow(r.Context(),
		"SELECT id FROM representatives WHERE country = $1 AND is_super_rep = FALSE", country,
	).Scan(&id)
	if err == pgx.ErrNoRows {
		err = s.db.QueryRow(r.Context(),
			"SELECT id FROM representatives WHERE is_super_rep = TRUE ORDER BY id LIMIT 1",
		).Scan(&id)
	}
	if err != nil {
		kit.Fail(w, 404, "no_representative", fmt.Sprintf("aucun représentant pour %q (ni super-rep configuré)", country))
		return
	}
	s.writeRepresentative(w, r, "id", id)
}

func (s *server) getRepresentativeByEmail(w http.ResponseWriter, r *http.Request) {
	email := r.PathValue("email")
	var id int64
	if err := s.db.QueryRow(r.Context(),
		"SELECT id FROM representatives WHERE lower(email) = lower($1)", email,
	).Scan(&id); err != nil {
		kit.Fail(w, 404, "representative_not_found", fmt.Sprintf("aucun représentant pour %q", email))
		return
	}
	s.writeRepresentative(w, r, "id", id)
}

func (s *server) writeRepresentative(w http.ResponseWriter, r *http.Request, col string, val any) {
	row := s.db.QueryRow(r.Context(), `
		SELECT id, name, email, country, is_super_rep, commission_pct
		FROM representatives WHERE `+col+` = $1`, val)
	var id int64
	var name, email, country string
	var isSuper bool
	var commission float32
	if err := row.Scan(&id, &name, &email, &country, &isSuper, &commission); err != nil {
		kit.Fail(w, 404, "representative_not_found", "représentant introuvable")
		return
	}
	kit.JSON(w, 200, map[string]any{
		"id": id, "name": name, "email": email, "country": country,
		"is_super_rep": isSuper, "commission_pct": commission,
	})
}

// repDashboard — agrège vendor-svc (boutiques du pays) et order-svc
// (commandes recentes) par HTTP, comme vendor-svc le fait déjà pour
// catalog-svc/order-svc (en prod : gRPC après codegen).
// COUNTRY_NAMES — même besoin que frontend/lib/shipping-utils.ts
// (ALL_WORLD_COUNTRIES), mais ce backend n'a pas accès à ce fichier
// TypeScript : sous-ensemble minimal (pays où la marketplace a
// effectivement des représentants aujourd'hui), pas la liste complète
// des ~190 pays. Un pays absent retombe sur son code ISO tel quel plutôt
// que d'échouer.
var repCountryNames = map[string]string{
	"SN": "Sénégal", "CI": "Côte d'Ivoire", "CM": "Cameroun", "GN": "Guinée",
	"BJ": "Bénin", "TG": "Togo", "ML": "Mali", "BF": "Burkina Faso",
	"NG": "Nigeria", "GH": "Ghana", "CD": "RDC", "MA": "Maroc",
}

func countryName(code string) string {
	if n, ok := repCountryNames[code]; ok {
		return n
	}
	return code
}

// repDashboard — GET /representative/dashboard/{id} : format EXACT attendu
// par RepresentantPage.tsx (frontend), voir RepData. Contrairement à la
// version précédente (juste vendors/open_messages/acknowledged_orders,
// insuffisant — la page accédait à des champs absents et plantait),
// agrège aussi les commandes/clients/CA de la zone (order-svc) et le
// parrainage (referrals, cette table).
func (s *server) repDashboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		kit.Fail(w, 400, "invalid_id", "id invalide")
		return
	}
	var name, email, country string
	var isSuper bool
	var commissionPct float32
	var referralCode, whatsapp *string
	if err := s.db.QueryRow(ctx,
		"SELECT name, email, country, is_super_rep, commission_pct, referral_code, whatsapp FROM representatives WHERE id = $1", id,
	).Scan(&name, &email, &country, &isSuper, &commissionPct, &referralCode, &whatsapp); err != nil {
		kit.Fail(w, 404, "representative_not_found", "représentant introuvable")
		return
	}
	if referralCode == nil || *referralCode == "" {
		code := s.ensureReferralCode(ctx, id)
		referralCode = &code
	}

	// ---------- Vendeurs de la zone ----------
	vendorsURL := s.vendorURL + "/stores?page_size=200"
	if !isSuper {
		vendorsURL += "&country=" + country
	}
	repVendors := []map[string]any{}
	vendorIDs := []string{}
	if body, err := proxyGetJSON(ctx, vendorsURL); err == nil {
		var parsed struct {
			Items []struct {
				ID            int64   `json:"id"`
				Name          string  `json:"name"`
				LogoURL       string  `json:"logo_url"`
				ProductsCount int     `json:"products_count"`
				RatingAvg     float64 `json:"rating_avg"`
			} `json:"items"`
		}
		if json.Unmarshal(body, &parsed) == nil {
			for _, v := range parsed.Items {
				vendorIDs = append(vendorIDs, strconv.FormatInt(v.ID, 10))
				repVendors = append(repVendors, map[string]any{
					"id": v.ID, "name": v.Name, "email": "", "avatar": v.LogoURL,
					"products": v.ProductsCount, "orders": 0, "total": 0.0, "phone": "",
				})
			}
		}
	}

	// ---------- Commandes de la zone (tous les vendeurs ci-dessus) ----------
	zoneOrders, zoneTotal := 0, 0.0
	zoneClientSet := map[int64]bool{}
	recentOrders := []map[string]any{}
	// Compte par vendeur, pour enrichir repVendors[].orders/.total sans un
	// second passage — construit pendant qu'on parcourt les commandes.
	vendorStats := map[int64]struct {
		orders int
		total  float64
	}{}
	if len(vendorIDs) > 0 {
		ordersURL := s.orderURL + "/orders?page_size=200&vendor_ids=" + strings.Join(vendorIDs, ",")
		if body, err := proxyGetJSON(ctx, ordersURL); err == nil {
			var parsed struct {
				Items []struct {
					ID            int64   `json:"id"`
					Reference     string  `json:"reference"`
					CustomerID    int64   `json:"customer_id"`
					VendorID      int64   `json:"vendor_id"`
					Status        string  `json:"status"`
					TotalUSD      float64 `json:"total_usd"`
					PaymentMethod string  `json:"payment_method"`
					CreatedAt     string  `json:"created_at"`
				} `json:"items"`
				Total int64 `json:"total"`
			}
			if json.Unmarshal(body, &parsed) == nil {
				zoneOrders = int(parsed.Total)
				for _, o := range parsed.Items {
					zoneTotal += o.TotalUSD
					if o.CustomerID > 0 {
						zoneClientSet[o.CustomerID] = true
					}
					st := vendorStats[o.VendorID]
					st.orders++
					st.total += o.TotalUSD
					vendorStats[o.VendorID] = st
				}
				// recent_orders : les 10 plus récentes (déjà triées id DESC côté
				// order-svc), format attendu par RepOrder — vendors/client/email
				// restent minimaux (order-svc ne référence qu'un customer_id, pas
				// de jointure client ici pour ne pas multiplier les appels réseau
				// sur un dashboard déjà lourd).
				for i, o := range parsed.Items {
					if i >= 10 {
						break
					}
					recentOrders = append(recentOrders, map[string]any{
						"id": o.ID, "number": o.Reference, "date": o.CreatedAt, "status": o.Status,
						"client": fmt.Sprintf("Client #%d", o.CustomerID), "email": "", "phone": "",
						"vendors": []string{}, "total": o.TotalUSD, "shipping_method": "",
						"tracking": "",
					})
				}
			}
		}
	}
	for i, v := range repVendors {
		vid, _ := v["id"].(int64)
		if st, ok := vendorStats[vid]; ok {
			repVendors[i]["orders"] = st.orders
			repVendors[i]["total"] = st.total
		}
	}

	// ---------- Parrainage ----------
	referralClients := []map[string]any{}
	referralOrders, referralEarned := 0, 0.0
	rows, err := s.db.Query(ctx,
		"SELECT customer_id, created_at FROM referrals WHERE representative_id = $1 ORDER BY created_at DESC", id)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var customerID int64
			var createdAt time.Time
			if rows.Scan(&customerID, &createdAt) == nil {
				// Commandes/CA de CE client parrainé — appel dédié (peu de clients
				// parrainés en pratique, contrairement aux commandes de zone).
				cOrders, cTotal := 0, 0.0
				if body, err := proxyGetJSON(ctx, fmt.Sprintf("%s/orders?customer_id=%d&page_size=100", s.orderURL, customerID)); err == nil {
					var p struct {
						Items []struct {
							TotalUSD float64 `json:"total_usd"`
						} `json:"items"`
						Total int64 `json:"total"`
					}
					if json.Unmarshal(body, &p) == nil {
						cOrders = int(p.Total)
						for _, o := range p.Items {
							cTotal += o.TotalUSD
						}
					}
				}
				referralOrders += cOrders
				referralEarned += cTotal * float64(commissionPct) / 100
				referralClients = append(referralClients, map[string]any{
					"name": fmt.Sprintf("Client #%d", customerID), "email": "",
					"orders": cOrders, "total": cTotal, "date": createdAt.UTC().Format(time.RFC3339),
				})
			}
		}
	}

	var openMessages int64
	_ = s.db.QueryRow(ctx,
		"SELECT count(*) FROM rep_messages WHERE representative_id = $1 AND status = 'open'", id,
	).Scan(&openMessages)

	kit.JSON(w, 200, map[string]any{
		"success": true, "id": id, "name": name, "email": email, "avatar": "",
		"country_code": country, "country_name": countryNameOrAll(country, isSuper),
		"whatsapp": stringOrEmpty(whatsapp), "referral_code": *referralCode, "commission_rate": commissionPct,
		"referral_earned": round2(referralEarned), "referral_clients": referralClients, "referral_orders": referralOrders,
		"vendors": repVendors, "vendors_count": len(repVendors),
		"recent_orders": recentOrders,
		"zone_orders":   zoneOrders, "zone_total": round2(zoneTotal), "zone_clients": len(zoneClientSet),
		"unread_messages": openMessages,
	})
}

func countryNameOrAll(code string, isSuper bool) string {
	if isSuper {
		return "Tous les pays"
	}
	return countryName(code)
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

func stringOrEmpty(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func proxyGetJSON(ctx context.Context, url string) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(body), nil
}

func (s *server) createMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RepresentativeID int64  `json:"representative_id"`
		CustomerID       int64  `json:"customer_id"`
		Subject          string `json:"subject"`
		Body             string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.RepresentativeID == 0 || body.CustomerID == 0 || body.Body == "" {
		kit.Fail(w, 400, "missing_fields", "representative_id, customer_id et body obligatoires")
		return
	}
	var id int64
	if err := s.db.QueryRow(r.Context(), `
		INSERT INTO rep_messages (representative_id, customer_id, subject, body)
		VALUES ($1,$2,$3,$4) RETURNING id`,
		body.RepresentativeID, body.CustomerID, body.Subject, body.Body).Scan(&id); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.Publish(s.kafka, "message.created", fmt.Sprint(id), map[string]any{
		"message_id": id, "representative_id": body.RepresentativeID, "customer_id": body.CustomerID,
		"at": time.Now().UTC().Format(time.RFC3339),
	})
	kit.JSON(w, 201, map[string]any{"id": id, "status": "open"})
}

func (s *server) listMessages(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	where := "WHERE 1=1"
	args := []any{}
	if repID := q.Get("representative_id"); repID != "" {
		where += " AND representative_id = $1"
		args = append(args, repID)
	}
	if status := q.Get("status"); status != "" {
		where += fmt.Sprintf(" AND status = $%d", len(args)+1)
		args = append(args, status)
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT id, representative_id, customer_id, subject, body, status, created_at
		FROM rep_messages `+where+` ORDER BY created_at DESC LIMIT 100`, args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, repID, custID int64
		var subject, body, status string
		var at time.Time
		_ = rows.Scan(&id, &repID, &custID, &subject, &body, &status, &at)
		items = append(items, map[string]any{
			"id": id, "representative_id": repID, "customer_id": custID,
			"subject": subject, "body": body, "status": status,
			"created_at": at.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{"items": items})
}

func (s *server) updateMessageStatus(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		kit.Fail(w, 400, "invalid_id", "id invalide")
		return
	}
	var body struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Status != "open" && body.Status != "answered" && body.Status != "closed" {
		kit.Fail(w, 400, "invalid_status", "status doit être open, answered ou closed")
		return
	}
	res, err := s.db.Exec(r.Context(), "UPDATE rep_messages SET status = $2 WHERE id = $1", id, body.Status)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if res.RowsAffected() == 0 {
		kit.Fail(w, 404, "message_not_found", fmt.Sprintf("message %d introuvable", id))
		return
	}
	kit.JSON(w, 200, map[string]any{"id": id, "status": body.Status})
}

func (s *server) replyMessage(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		kit.Fail(w, 400, "invalid_id", "id invalide")
		return
	}
	var body struct {
		Body string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Body == "" {
		kit.Fail(w, 400, "missing_body", "body obligatoire")
		return
	}
	var replyID int64
	if err := s.db.QueryRow(r.Context(), `
		INSERT INTO rep_message_replies (message_id, body) VALUES ($1,$2) RETURNING id`,
		id, body.Body).Scan(&replyID); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if _, err := s.db.Exec(r.Context(), "UPDATE rep_messages SET status = 'answered' WHERE id = $1", id); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 201, map[string]any{"id": replyID, "message_id": id, "status": "answered"})
}

func (s *server) acknowledgeOrder(w http.ResponseWriter, r *http.Request) {
	orderID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		kit.Fail(w, 400, "invalid_id", "id de commande invalide")
		return
	}
	var body struct {
		RepresentativeID int64 `json:"representative_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.RepresentativeID == 0 {
		kit.Fail(w, 400, "missing_representative_id", "representative_id obligatoire")
		return
	}
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO rep_order_acknowledgements (order_id, representative_id) VALUES ($1,$2)
		ON CONFLICT (order_id) DO UPDATE SET representative_id = EXCLUDED.representative_id, acknowledged_at = now()`,
		orderID, body.RepresentativeID); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"order_id": orderID, "representative_id": body.RepresentativeID, "acknowledged": true})
}

/* ============================================================
   WhatsApp (Twilio) — reprend le plugin WP "MIAD Representative
   Manager" : notifications représentant/super-rep + admin quand une
   commande est confirmée par le vendeur (processing), notifications
   client à chaque étape de la chaîne de livraison.
   ============================================================ */

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

// sendWhatsApp — POST form-encodé vers l'API Twilio (Basic Auth SID/Token),
// même style que createStripePaymentIntent (payment-svc). ContentSid+
// ContentVariables si un template est configuré, sinon repli sur Body texte
// brut — comme le faisait le PHP (if ($sid) {...} else {...}). Journalise
// TOUJOURS dans whatsapp_logs (succès ou échec) et ne renvoie jamais
// d'erreur bloquante à l'appelant : un envoi WhatsApp raté ne doit jamais
// faire échouer un changement de statut de commande ou d'étape de livraison.
func (s *server) sendWhatsApp(ctx context.Context, to, recipientType string, orderID *int64, contentSid string, vars map[string]string, fallbackBody string) {
	status, errMsg := "queued", ""
	bodyLogged := fallbackBody

	if to == "" {
		return // pas de numéro connu pour ce destinataire — rien à journaliser
	}
	if s.twilioAccountSID == "" || s.twilioAuthToken == "" || s.twilioWhatsappFrom == "" {
		status, errMsg = "failed", "clés Twilio non configurées"
	} else {
		form := url.Values{}
		form.Set("To", "whatsapp:"+strings.TrimPrefix(to, "whatsapp:"))
		form.Set("From", "whatsapp:"+strings.TrimPrefix(s.twilioWhatsappFrom, "whatsapp:"))
		if contentSid != "" {
			varsJSON, _ := json.Marshal(vars)
			form.Set("ContentSid", contentSid)
			form.Set("ContentVariables", string(varsJSON))
			bodyLogged = fmt.Sprintf("[template %s] %s", contentSid, string(varsJSON))
		} else {
			form.Set("Body", fallbackBody)
		}

		endpoint := fmt.Sprintf("https://api.twilio.com/2010-04-01/Accounts/%s/Messages.json", s.twilioAccountSID)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
		req.SetBasicAuth(s.twilioAccountSID, s.twilioAuthToken)
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			status, errMsg = "failed", err.Error()
		} else {
			defer resp.Body.Close()
			raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			if resp.StatusCode >= 300 {
				status, errMsg = "failed", fmt.Sprintf("Twilio a refusé (%d): %s", resp.StatusCode, strings.TrimSpace(string(raw)))
			} else {
				status = "sent"
			}
		}
	}

	if _, err := s.db.Exec(ctx, `
		INSERT INTO whatsapp_logs (direction, phone, recipient_type, order_id, template_sid, message_body, status, error)
		VALUES ('out',$1,$2,$3,$4,$5,$6,$7)`,
		to, recipientType, orderID, contentSid, bodyLogged, status, errMsg); err != nil {
		slog.Default().Error("persistance whatsapp_logs impossible", "err", err)
	}
}

/* ---------- Déclenchement : commande confirmée → représentant(s) + admin ---------- */

// notifyOrderProcessing — reproduit miad_notify_rep_new_order (PHP) :
// résout le pays du vendeur (vendor-svc), notifie le(s) représentant(s) du
// pays + tous les super-représentants, puis les numéros admin configurés.
func (s *server) notifyOrderProcessing(ctx context.Context, log *slog.Logger, orderID int64) {
	var order struct {
		Reference       string          `json:"reference"`
		VendorID        int64           `json:"vendor_id"`
		TotalUSD        float64         `json:"total_usd"`
		Lines           json.RawMessage `json:"lines"`
		ShippingAddress json.RawMessage `json:"shipping_address"`
		BillingAddress  json.RawMessage `json:"billing_address"`
	}
	if err := fetchJSONInto(ctx, fmt.Sprintf("%s/orders/%d", s.orderURL, orderID), &order); err != nil {
		log.Error("whatsapp: commande introuvable", "order_id", orderID, "err", err)
		return
	}

	var vendor struct {
		Name    string `json:"store_name"`
		Country string `json:"country"`
	}
	if err := fetchJSONInto(ctx, fmt.Sprintf("%s/vendors/%d", s.vendorURL, order.VendorID), &vendor); err != nil {
		log.Error("whatsapp: boutique introuvable", "vendor_id", order.VendorID, "err", err)
		return
	}

	addr := parseAddress(order.ShippingAddress)
	if addr.empty() {
		addr = parseAddress(order.BillingAddress)
	}
	productsSummary := summarizeLines(order.Lines)
	totalFmt := fmt.Sprintf("%.2f $", order.TotalUSD)

	// ---------- Représentant(s) du pays + super-représentants ----------
	// Email et WhatsApp partagent la même résolution (même destinataires,
	// mêmes variables déjà calculées ci-dessus) — envoyés indépendamment
	// l'un de l'autre : un échec WhatsApp ne doit jamais bloquer l'email
	// et vice-versa.
	rows, err := s.db.Query(ctx,
		"SELECT whatsapp, email, is_super_rep FROM representatives WHERE (country = $1 AND is_super_rep = FALSE) OR is_super_rep = TRUE",
		vendor.Country)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var wa, email *string
			var isSuper bool
			_ = rows.Scan(&wa, &email, &isSuper)

			if s.twilioEnableRep == "yes" && wa != nil && *wa != "" {
				fallback := fmt.Sprintf("🛒 *Nouvelle commande #%s*\nBoutique : %s\nClient : %s\nMontant : *%s*\nAdresse : %s\nProduits : %s",
					order.Reference, vendor.Name, addr.fullName(), totalFmt, addr.oneLine(), productsSummary)
				s.sendWhatsApp(ctx, *wa, "representative", &orderID, s.twilioTemplateRepNewOrder, map[string]string{
					"1": order.Reference + " — " + productsSummary,
					"2": vendor.Name,
					"3": totalFmt,
					"4": addr.fullName(),
					"5": addr.oneLine(),
					"6": productsSummary,
				}, fallback)
			}

			if email != nil && *email != "" {
				zone := vendor.Country
				if isSuper {
					zone = "toutes zones"
				}
				s.sendRepEmail(ctx, log, *email, order.Reference, zone, map[string]any{
					"order_id":         order.Reference,
					"rep_zone":         zone,
					"vendor_name":      vendor.Name,
					"total_usd":        totalFmt,
					"customer_name":    addr.fullName(),
					"shipping_summary": addr.oneLine(),
				})
			}
		}
	}

	// ---------- Admin ----------
	if s.twilioEnableAdmin == "yes" && s.twilioAdminNumbers != "" {
		for _, phone := range strings.Split(s.twilioAdminNumbers, ",") {
			phone = strings.TrimSpace(phone)
			if phone == "" {
				continue
			}
			fallback := fmt.Sprintf("📦 *Commande #%s* — %s — *%s* — %s", order.Reference, addr.fullName(), totalFmt, addr.oneLine())
			s.sendWhatsApp(ctx, phone, "admin", &orderID, s.twilioTemplateAdminNewOrder, map[string]string{
				"1": order.Reference,
				"2": addr.fullName(),
				"3": totalFmt,
				"4": time.Now().Format("02/01/2006 15:04"),
				"5": addr.oneLine(),
			}, fallback)
		}
	}
}

// sendRepEmail — POST /emails/send sur email-svc (endpoint public générique,
// même pattern qu'auth-svc.sendOTPEmail), template "rep_new_order" déjà
// seedé côté email-svc. Best effort : jamais bloquant pour le reste du
// traitement Kafka — une erreur est journalisée, jamais propagée.
func (s *server) sendRepEmail(ctx context.Context, log *slog.Logger, to, orderRef, zone string, payload map[string]any) {
	body, _ := json.Marshal(map[string]any{
		"to":       to,
		"subject":  fmt.Sprintf("Nouvelle commande #%s — %s", orderRef, zone),
		"template": "rep_new_order",
		"payload":  payload,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.emailURL+"/emails/send", bytes.NewReader(body))
	if err != nil {
		log.Error("email représentant: requête invalide", "err", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Error("email représentant: email-svc injoignable", "err", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Error("email représentant: refusé par email-svc", "status", resp.StatusCode)
	}
}

/* ---------- Déclenchement : étape de livraison → client ---------- */

var deliveryStageClientMessages = map[string]string{
	"rep_received": "📥 Bonjour %s, votre commande #%s a été réceptionnée par notre représentant local.",
	"local_pickup": "🚚 Bonjour %s, votre commande #%s a été prise en charge par le transporteur local.",
	"intl_handoff": "✈️ Bonjour %s, votre commande #%s est remise au transporteur international.",
	"delivered":    "🎉 Bonjour %s, votre commande #%s a été livrée. Merci pour votre confiance !",
}

// notifyDeliveryStage — reproduit miad_process_delivery_stage_update (PHP),
// partie client uniquement (l'écriture de l'étape elle-même reste dans
// fulfillment-svc, seule propriétaire de shipments.delivery_stage).
func (s *server) notifyDeliveryStage(ctx context.Context, log *slog.Logger, orderID int64, stage string) {
	if s.twilioEnableClient != "yes" {
		return
	}
	tmpl, ok := deliveryStageClientMessages[stage]
	if !ok {
		return
	}

	var order struct {
		BillingAddress json.RawMessage `json:"billing_address"`
	}
	if err := fetchJSONInto(ctx, fmt.Sprintf("%s/orders/%d", s.orderURL, orderID), &order); err != nil {
		log.Error("whatsapp: commande introuvable pour notif étape", "order_id", orderID, "err", err)
		return
	}
	addr := parseAddress(order.BillingAddress)
	if addr.phone == "" {
		return // pas de numéro client connu — rien à envoyer
	}

	fallback := fmt.Sprintf(tmpl, addr.firstName(), strconv.FormatInt(orderID, 10))
	if stage == "intl_handoff" {
		s.sendWhatsApp(ctx, addr.phone, "client", &orderID, s.twilioTemplateClientShipped, map[string]string{
			"1": addr.firstName(),
			"2": strconv.FormatInt(orderID, 10),
			"3": "N/A",
		}, fallback)
		return
	}
	s.sendWhatsApp(ctx, addr.phone, "client", &orderID, "", nil, fallback)
}

/* ---------- Consumer Kafka ---------- */

var whatsappWatchedTopics = []string{"order.status_changed", "shipment.delivery_stage_changed"}

// consumeWhatsappEvents — même pattern que notification-svc.consume :
// retry/backoff sur Kafka indisponible, jamais fatal pour le service.
// Groupe de consommateur dédié ("loyalty-svc-whatsapp") pour ne pas
// interférer avec consumeCustomerEvents (groupe "loyalty-svc", topic
// customer.registered) — deux groupes distincts consomment indépendamment.
func (s *server) consumeWhatsappEvents(log *slog.Logger) {
	brokers := kit.Env("KAFKA_BROKERS", "kafka:9092")
	if brokers == "" {
		log.Warn("KAFKA_BROKERS vide — notifications WhatsApp désactivées (mode dev)")
		return
	}
	cfg := sarama.NewConfig()
	cfg.Consumer.Offsets.Initial = sarama.OffsetOldest
	cfg.Version = sarama.V2_8_0_0

	for {
		group, err := sarama.NewConsumerGroup([]string{brokers}, "loyalty-svc-whatsapp", cfg)
		if err != nil {
			log.Error("kafka injoignable (whatsapp) — retry 5 s", "err", err)
			time.Sleep(5 * time.Second)
			continue
		}
		log.Info("consommateur whatsapp connecté", "topics", whatsappWatchedTopics)
		handler := whatsappConsumer{s: s, log: log}
		_ = group.Consume(context.Background(), whatsappWatchedTopics, handler)
		group.Close()
	}
}

type whatsappConsumer struct {
	s   *server
	log *slog.Logger
}

func (c whatsappConsumer) Setup(sarama.ConsumerGroupSession) error   { return nil }
func (c whatsappConsumer) Cleanup(sarama.ConsumerGroupSession) error { return nil }
func (c whatsappConsumer) ConsumeClaim(sess sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
	for msg := range claim.Messages() {
		switch msg.Topic {
		case "order.status_changed":
			var payload struct {
				OrderID int64  `json:"order_id"`
				Status  string `json:"status"`
			}
			if json.Unmarshal(msg.Value, &payload) == nil && payload.Status == "processing" && payload.OrderID > 0 {
				c.s.notifyOrderProcessing(sess.Context(), c.log, payload.OrderID)
			}
		case "shipment.delivery_stage_changed":
			var payload struct {
				OrderID int64  `json:"order_id"`
				Stage   string `json:"stage"`
			}
			if json.Unmarshal(msg.Value, &payload) == nil && payload.OrderID > 0 {
				c.s.notifyDeliveryStage(sess.Context(), c.log, payload.OrderID, payload.Stage)
			}
		}
		sess.MarkMessage(msg, "")
	}
	return nil
}

/* ---------- Endpoints admin : logs, testeur, webhook entrant ---------- */

// listWhatsappLogs — GET /whatsapp/logs?order_id=&recipient_type=&limit=
func (s *server) listWhatsappLogs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	where := "WHERE 1=1"
	args := []any{}
	if orderID := q.Get("order_id"); orderID != "" {
		args = append(args, orderID)
		where += fmt.Sprintf(" AND order_id = $%d", len(args))
	}
	if recipientType := q.Get("recipient_type"); recipientType != "" {
		args = append(args, recipientType)
		where += fmt.Sprintf(" AND recipient_type = $%d", len(args))
	}
	limit, _ := strconv.Atoi(kit.EnvOr(q.Get("limit"), "100"))
	if limit < 1 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT id, direction, phone, recipient_type, order_id, template_sid, message_body, status, error, created_at
		FROM whatsapp_logs `+where+` ORDER BY created_at DESC LIMIT `+strconv.Itoa(limit), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var direction, phone, recipientType, templateSid, messageBody, status, errMsg string
		var orderID *int64
		var at time.Time
		if err := rows.Scan(&id, &direction, &phone, &recipientType, &orderID, &templateSid, &messageBody, &status, &errMsg, &at); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		items = append(items, map[string]any{
			"id": id, "direction": direction, "phone": phone, "recipient_type": recipientType,
			"order_id": orderID, "template_sid": templateSid, "message_body": messageBody,
			"status": status, "error": errMsg, "created_at": at.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{"items": items})
}

// resendWhatsappForOrder — équivalent du testeur PHP ("Renvoyer la
// notification") : rejoue la même logique que le déclencheur Kafka
// "processing", sans changer le statut de la commande.
func (s *server) resendWhatsappForOrder(w http.ResponseWriter, r *http.Request) {
	orderID, err := strconv.ParseInt(r.PathValue("order_id"), 10, 64)
	if err != nil {
		kit.Fail(w, 400, "invalid_order_id", "order_id invalide")
		return
	}
	s.notifyOrderProcessing(r.Context(), slog.Default(), orderID)
	kit.JSON(w, 200, map[string]any{"order_id": orderID, "resent": true})
}

// whatsappIncomingWebhook — POST /whatsapp/incoming, appelé par Twilio à
// chaque message WhatsApp entrant (réponse d'un client/représentant).
// Périmètre minimal (comme dans l'ancien plugin) : journaliser, répondre
// 200 avec un TwiML vide — pas de logique de réponse automatique.
func (s *server) whatsappIncomingWebhook(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	from := strings.TrimPrefix(r.FormValue("From"), "whatsapp:")
	body := r.FormValue("Body")
	if from != "" {
		if _, err := s.db.Exec(r.Context(), `
			INSERT INTO whatsapp_logs (direction, phone, recipient_type, message_body, status)
			VALUES ('in',$1,'unknown',$2,'sent')`, from, body); err != nil {
			slog.Default().Error("persistance whatsapp entrant impossible", "err", err)
		}
	}
	w.Header().Set("Content-Type", "text/xml")
	w.WriteHeader(200)
	_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`))
}

/* ---------- Aides adresse/commande ---------- */

type parsedAddress struct {
	firstNameField string
	lastNameField  string
	phone          string
	line1          string
	city           string
	country        string
}

func (a parsedAddress) fullName() string {
	return strings.TrimSpace(a.firstNameField + " " + a.lastNameField)
}

func (a parsedAddress) firstName() string {
	if a.firstNameField != "" {
		return a.firstNameField
	}
	return "client"
}

func (a parsedAddress) oneLine() string {
	parts := []string{}
	for _, p := range []string{a.line1, a.city, a.country} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return "N/A"
	}
	return strings.Join(parts, ", ")
}

func (a parsedAddress) empty() bool {
	return a.line1 == "" && a.city == "" && a.country == "" && a.phone == ""
}

// parseAddress — les adresses order-svc sont du JSON libre venant du
// checkout frontend (voir destCountryFrom, order-svc/main.go) : décodage
// défensif, clés absentes → chaînes vides plutôt qu'une erreur.
func parseAddress(raw json.RawMessage) parsedAddress {
	var doc struct {
		FirstName string `json:"first_name"`
		LastName  string `json:"last_name"`
		Phone     string `json:"phone"`
		Address1  string `json:"address_1"`
		City      string `json:"city"`
		Country   string `json:"country"`
	}
	_ = json.Unmarshal(raw, &doc)
	return parsedAddress{
		firstNameField: doc.FirstName, lastNameField: doc.LastName,
		phone: doc.Phone, line1: doc.Address1, city: doc.City, country: doc.Country,
	}
}

type orderLine struct {
	Name     string `json:"name"`
	Quantity int    `json:"quantity"`
}

func summarizeLines(raw json.RawMessage) string {
	var lines []orderLine
	_ = json.Unmarshal(raw, &lines)
	if len(lines) == 0 {
		return "N/A"
	}
	parts := make([]string, 0, len(lines))
	for _, l := range lines {
		parts = append(parts, fmt.Sprintf("%s x%d", l.Name, l.Quantity))
	}
	return strings.Join(parts, " | ")
}

func fetchJSONInto(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("statut %d: %s", resp.StatusCode, string(body))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

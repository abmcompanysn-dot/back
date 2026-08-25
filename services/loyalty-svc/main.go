// ============================================================
// loyalty-svc — coins/fidélité (ledger complet) + représentants pays.
// Remplace le blob meta _miad_coins_history (capé à 60 entrées) par
// une vraie table coin_transactions : ledger complet, jamais tronqué.
// Publie : coins.awarded, message.created
// ============================================================
package main

import (
	"context"
	crand "crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/big"
	"net/http"
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
`

type server struct {
	db        *pgxpool.Pool
	kafka     sarama.SyncProducer
	vendorURL string
	orderURL  string
}

func main() {
	ctx := context.Background()
	log := kit.Logger("loyalty-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_LOYALTY", "postgres://miad:miad@postgres:5432/miad_loyalty?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema); err != nil {
		log.Error("migration impossible", "err", err)
		return
	}

	s := &server{
		db:        db,
		kafka:     kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		vendorURL: kit.Env("VENDOR_SVC_URL", "http://vendor-svc:8082"),
		orderURL:  kit.Env("ORDER_SVC_URL", "http://order-svc:8083"),
	}
	// Module Parrainage : un client inscrit avec ?ref=<code> est lié à son
	// représentant via cet événement, plutôt qu'un appel HTTP synchrone
	// depuis auth-svc/registerCustomer (couplage dur évité — l'inscription
	// ne doit jamais échouer à cause d'un souci de parrainage).
	go s.consumeCustomerEvents(log)

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)

	kit.Run("loyalty-svc", kit.Env("PORT_LOYALTY", "8091"), log, health, func(mux *http.ServeMux) {
		// Coins
		mux.HandleFunc("GET /coins/{customer_id}", s.getCoins)
		mux.HandleFunc("POST /coins/daily", s.claimDaily)
		mux.HandleFunc("GET /coins/leaderboard", s.leaderboard)
		mux.HandleFunc("GET /coupons", s.listCoupons)
		mux.HandleFunc("POST /coupons/validate", s.validateCoupon)

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
	var referralCode *string
	if err := s.db.QueryRow(ctx,
		"SELECT name, email, country, is_super_rep, commission_pct, referral_code FROM representatives WHERE id = $1", id,
	).Scan(&name, &email, &country, &isSuper, &commissionPct, &referralCode); err != nil {
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
		"whatsapp": "", "referral_code": *referralCode, "commission_rate": commissionPct,
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

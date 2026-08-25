// ============================================================
// loyalty-svc — coins/fidélité (ledger complet) + représentants pays.
// Remplace le blob meta _miad_coins_history (capé à 60 entrées) par
// une vraie table coin_transactions : ledger complet, jamais tronqué.
// Publie : coins.awarded, message.created
// ============================================================
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
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
func (s *server) repDashboard(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		kit.Fail(w, 400, "invalid_id", "id invalide")
		return
	}
	var country string
	var isSuper bool
	if err := s.db.QueryRow(r.Context(),
		"SELECT country, is_super_rep FROM representatives WHERE id = $1", id,
	).Scan(&country, &isSuper); err != nil {
		kit.Fail(w, 404, "representative_not_found", "représentant introuvable")
		return
	}

	out := map[string]any{"representative_id": id, "country": country, "is_super_rep": isSuper}

	vendorsURL := s.vendorURL + "/stores"
	if !isSuper {
		vendorsURL += "?country=" + country
	}
	if body, err := proxyGetJSON(r.Context(), vendorsURL); err == nil {
		out["vendors"] = body
	} else {
		out["vendors_error"] = fmt.Sprintf("vendor-svc injoignable — erreur EXPLICITE : %v", err)
	}

	var openMessages, ackOrders int64
	_ = s.db.QueryRow(r.Context(),
		"SELECT count(*) FROM rep_messages WHERE representative_id = $1 AND status = 'open'", id,
	).Scan(&openMessages)
	_ = s.db.QueryRow(r.Context(),
		"SELECT count(*) FROM rep_order_acknowledgements WHERE representative_id = $1", id,
	).Scan(&ackOrders)
	out["open_messages"] = openMessages
	out["acknowledged_orders"] = ackOrders

	kit.JSON(w, 200, out)
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

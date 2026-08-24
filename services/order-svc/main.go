// ============================================================
// order-svc — création et cycle de vie des commandes.
// Publie : order.created, order.status_changed
// Une commande acheteur (multi-boutiques) est éclatée en
// sous-commandes par vendeur. Le paiement est délégué :
// payment-svc écoute order.created sur Kafka.
//
// RISQUE SIGNALÉ (cohérence éventuelle) : une commande peut être
// créée sans que payment.confirmed n'arrive jamais. Gestion
// explicite : statut pending_payment + reaper qui passe en
// payment_expired après PAYMENT_TIMEOUT_MINUTES (défaut 30).
// ============================================================
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/IBM/sarama"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/miadmarket/miad-backend/internal/kit"
)

const schema = `
CREATE TABLE IF NOT EXISTS orders (
  id              BIGSERIAL PRIMARY KEY,
  reference       TEXT UNIQUE NOT NULL,
  customer_id     BIGINT NOT NULL,
  vendor_id       BIGINT NOT NULL,          -- 1 sous-commande = 1 boutique
  parent_order_id BIGINT,                    -- regroupement côté acheteur
  status          TEXT NOT NULL DEFAULT 'pending_payment',
  lines           JSONB NOT NULL DEFAULT '[]',
  subtotal_xof    BIGINT NOT NULL DEFAULT 0,
  shipping_xof    BIGINT NOT NULL DEFAULT 0,
  total_xof       BIGINT NOT NULL DEFAULT 0,
  coupon_code     TEXT,
  shipping_address JSONB,
  billing_address  JSONB,
  payment_method  TEXT DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders (status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_vendor ON orders (vendor_id);
CREATE INDEX IF NOT EXISTS idx_orders_parent ON orders (parent_order_id);

CREATE TABLE IF NOT EXISTS coupons (
  code        TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('percent','fixed')),
  amount      BIGINT NOT NULL,
  expires_at  TIMESTAMPTZ,
  max_uses    INT NOT NULL DEFAULT 0,
  used_count  INT NOT NULL DEFAULT 0
);
`

type server struct {
	db      *pgxpool.Pool
	kafka   sarama.SyncProducer
	timeout time.Duration
}

type line struct {
	ProductID   int64  `json:"product_id"`
	VariationID int64  `json:"variation_id"`
	VendorID    int64  `json:"vendor_id"`
	Name        string `json:"name"`
	Quantity    int    `json:"quantity"`
	UnitPrice   int64  `json:"unit_price_xof"`
}

func main() {
	ctx := context.Background()
	log := kit.Logger("order-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_ORDER", "postgres://miad:miad@postgres:5432/miad_order?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema); err != nil {
		log.Error("migration impossible", "err", err)
		return
	}

	mins, _ := strconv.Atoi(kit.Env("PAYMENT_TIMEOUT_MINUTES", "30"))
	s := &server{
		db:      db,
		kafka:   kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		timeout: time.Duration(mins) * time.Minute,
	}

	// Reaper : le cas d'échec partiel est géré, pas tu.
	go s.expireUnpaidLoop(log)

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)

	kit.Run("order-svc", kit.Env("PORT_ORDER", "8083"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("POST /orders", s.createOrder)
		mux.HandleFunc("GET /orders", s.listOrders)
		mux.HandleFunc("GET /orders/{id}", s.getOrder)
		mux.HandleFunc("POST /orders/{id}/confirm", s.confirmPayment)
	})
}

// createOrder — éclate les lignes par boutique dans UNE transaction
// locale (même base), puis publie order.created par sous-commande.
func (s *server) createOrder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CustomerID      int64           `json:"customer_id"`
		Lines           []line          `json:"lines"`
		ShippingAddress json.RawMessage `json:"shipping_address"`
		BillingAddress  json.RawMessage `json:"billing_address"`
		CouponCode      string          `json:"coupon_code"`
		PaymentMethod   string          `json:"payment_method"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.CustomerID == 0 || len(body.Lines) == 0 {
		kit.Fail(w, 400, "missing_fields", "customer_id et au moins une ligne sont obligatoires")
		return
	}
	if body.PaymentMethod != "stripe" && body.PaymentMethod != "paydunya" {
		kit.Fail(w, 400, "invalid_payment_method", "payment_method doit être stripe ou paydunya")
		return
	}

	// Regroupement par boutique.
	byVendor := map[int64][]line{}
	for _, l := range body.Lines {
		if l.VendorID == 0 || l.Quantity < 1 {
			kit.Fail(w, 400, "invalid_line", "chaque ligne doit porter vendor_id et quantity ≥ 1")
			return
		}
		byVendor[l.VendorID] = append(byVendor[l.VendorID], l)
	}

	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	var parentID int64
	ref := fmt.Sprintf("MIAD-%s", time.Now().Format("20060102-150405"))
	if err := tx.QueryRow(ctx, `
		INSERT INTO orders (reference, customer_id, vendor_id, status)
		VALUES ($1, $2, 0, 'group') RETURNING id`, ref, body.CustomerID).Scan(&parentID); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	created := []map[string]any{}
	seq := 1
	for vendorID, lines := range byVendor {
		var subtotal int64
		for _, l := range lines {
			subtotal += l.UnitPrice * int64(l.Quantity)
		}
		linesJSON, _ := json.Marshal(lines)
		var id int64
		orderRef := fmt.Sprintf("%s-%d", ref, seq)
		if err := tx.QueryRow(ctx, `
			INSERT INTO orders (reference, customer_id, vendor_id, parent_order_id, status,
			                    lines, subtotal_xof, total_xof, coupon_code,
			                    shipping_address, billing_address, payment_method)
			VALUES ($1,$2,$3,$4,'pending_payment',$5,$6,$6,$7,$8,$9,$10)
			RETURNING id`,
			orderRef, body.CustomerID, vendorID, parentID,
			linesJSON, subtotal, body.CouponCode,
			body.ShippingAddress, body.BillingAddress, body.PaymentMethod,
		).Scan(&id); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		created = append(created, map[string]any{
			"id": id, "reference": orderRef, "vendor_id": vendorID,
			"status": "pending_payment", "subtotal_xof": subtotal, "total_xof": subtotal,
		})
		seq++
	}

	if err := tx.Commit(ctx); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	// Après commit seulement : payment-svc et notification-svc réagissent.
	for _, o := range created {
		kit.Publish(s.kafka, "order.created", fmt.Sprint(o["id"]), map[string]any{
			"order_id": o["id"], "reference": o["reference"], "vendor_id": o["vendor_id"],
			"customer_id": body.CustomerID, "total_xof": o["total_xof"],
			"payment_method": body.PaymentMethod,
			"at":             time.Now().UTC().Format(time.RFC3339),
		})
	}

	kit.JSON(w, 201, map[string]any{
		"parent_order_id":      parentID,
		"reference":            ref,
		"vendor_orders":        created,
		"payment_initiated_by": "payment-svc (consommateur de order.created)",
	})
}

func (s *server) listOrders(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(kit.EnvOr(q.Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(q.Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}
	args := []any{}
	where := "WHERE vendor_id > 0"
	if v := q.Get("vendor_id"); v != "" {
		where += " AND vendor_id = $1"
		args = append(args, atoi(v))
	}
	if v := q.Get("customer_id"); v != "" {
		where += fmt.Sprintf(" AND customer_id = $%d", len(args)+1)
		args = append(args, atoi(v))
	}

	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM orders "+where, args...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT id, reference, customer_id, vendor_id, status, total_xof, created_at
		FROM orders `+where+` ORDER BY id DESC
		LIMIT `+strconv.Itoa(pageSize)+` OFFSET `+strconv.Itoa((page-1)*pageSize), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, cust, vendor, total int64
		var ref, status string
		var at time.Time
		_ = rows.Scan(&id, &ref, &cust, &vendor, &status, &total, &at)
		items = append(items, map[string]any{
			"id": id, "reference": ref, "customer_id": cust, "vendor_id": vendor,
			"status": status, "total_xof": total, "created_at": at.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

func (s *server) getOrder(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	row := s.db.QueryRow(r.Context(), `
		SELECT id, reference, customer_id, vendor_id, parent_order_id, status, lines,
		       subtotal_xof, shipping_xof, total_xof, coupon_code, created_at, updated_at
		FROM orders WHERE id = $1`, id)
	var oid, cust, vendor, parent, subtotal, shipping, total int64
	var ref, status, coupon string
	var lines []byte
	var createdAt, updatedAt time.Time
	if err := row.Scan(&oid, &ref, &cust, &vendor, &parent, &status, &lines,
		&subtotal, &shipping, &total, &coupon, &createdAt, &updatedAt); err != nil {
		kit.Fail(w, 404, "order_not_found", fmt.Sprintf("commande %d introuvable", id))
		return
	}
	kit.JSON(w, 200, map[string]any{
		"id": oid, "reference": ref, "customer_id": cust, "vendor_id": vendor,
		"parent_order_id": parent, "status": status, "lines": json.RawMessage(lines),
		"subtotal_xof": subtotal, "shipping_xof": shipping, "total_xof": total,
		"coupon_code": coupon,
		"created_at":  createdAt.UTC().Format(time.RFC3339),
		"updated_at":  updatedAt.UTC().Format(time.RFC3339),
	})
}

// confirmPayment — appelé en interne par payment-svc après
// payment.confirmed (en prod : gRPC, pas HTTP).
func (s *server) confirmPayment(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	res, err := s.db.Exec(r.Context(), `
		UPDATE orders SET status = 'paid', updated_at = now()
		WHERE id = $1 AND status = 'pending_payment'`, id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if res.RowsAffected() == 0 {
		kit.Fail(w, 409, "not_pending", "la commande n'est plus en attente de paiement — état actuel à lire via GET /orders/{id}")
		return
	}
	kit.Publish(s.kafka, "order.status_changed", fmt.Sprint(id), map[string]any{
		"order_id": id, "status": "paid", "at": time.Now().UTC().Format(time.RFC3339),
	})
	kit.JSON(w, 200, map[string]any{"id": id, "status": "paid"})
}

// expireUnpaidLoop — gestion explicite du cas "commande créée,
// confirmation de paiement jamais reçue".
func (s *server) expireUnpaidLoop(log interface{ Info(string, ...any) }) {
	tick := time.NewTicker(time.Minute)
	for range tick.C {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		res, err := s.db.Exec(ctx, `
			UPDATE orders SET status = 'payment_expired', updated_at = now()
			WHERE status = 'pending_payment' AND created_at < now() - $1::interval`,
			fmt.Sprintf("%d minutes", int(s.timeout.Minutes())))
		cancel()
		if err != nil {
			log.Info("reaper: erreur", "err", err.Error())
			continue
		}
		if res.RowsAffected() > 0 {
			log.Info("reaper: commandes expirées (paiement jamais confirmé)", "n", res.RowsAffected())
			kit.Publish(s.kafka, "order.status_changed", "reaper", map[string]any{
				"status": "payment_expired", "expired_count": res.RowsAffected(),
			})
		}
	}
}

func atoi(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

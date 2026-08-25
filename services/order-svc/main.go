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
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
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
  subtotal_usd    DOUBLE PRECISION NOT NULL DEFAULT 0, -- USD réel (voir catalog-svc)
  shipping_usd    DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_usd       DOUBLE PRECISION NOT NULL DEFAULT 0,
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

-- Module Commandes (back-office admin) : le champ status ci-dessus mélangeait
-- statut de paiement (paid/refunded/payment_expired) et étape logistique
-- (processing/shipped/delivered) dans un seul enum fourre-tout — le cahier
-- des charges demande explicitement de séparer les deux (une commande peut
-- être "payée" ET "en préparation" en même temps, ce que status seul ne
-- pouvait pas représenter). status reste en base tel quel (compatibilité :
-- le payload Kafka order.status_changed, lu par fulfillment-svc/email-svc/
-- notification-svc, et le marqueur 'group' des commandes parent en
-- dépendent) — payment_status/fulfillment_stage sont désormais la source de
-- vérité pour l'affichage admin, status continue d'être tenu à jour en
-- parallèle à chaque mutation pour ne rien casser côté Kafka.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_stage TEXT NOT NULL DEFAULT 'pending';
-- Backfill unique (idempotent : ne réécrit que les lignes encore à leur
-- valeur par défaut) à partir du status existant au moment de la migration.
UPDATE orders SET
  payment_status = CASE status
    WHEN 'pending_payment' THEN 'pending'
    WHEN 'payment_expired' THEN 'expired'
    WHEN 'paid' THEN 'paid'
    WHEN 'processing' THEN 'paid'
    WHEN 'shipped' THEN 'paid'
    WHEN 'delivered' THEN 'paid'
    WHEN 'cancelled' THEN 'pending'
    WHEN 'refunded' THEN 'refunded'
    ELSE payment_status
  END,
  fulfillment_stage = CASE status
    WHEN 'pending_payment' THEN 'pending'
    WHEN 'payment_expired' THEN 'pending'
    WHEN 'paid' THEN 'pending'
    WHEN 'processing' THEN 'preparing'
    WHEN 'shipped' THEN 'in_transit'
    WHEN 'delivered' THEN 'delivered'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'refunded' THEN 'cancelled'
    ELSE fulfillment_stage
  END
WHERE payment_status = 'pending' AND fulfillment_stage = 'pending'
  AND status IN ('processing', 'shipped', 'delivered', 'refunded', 'payment_expired', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_stage ON orders (fulfillment_stage, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders (payment_status);

-- Import historique WooCommerce (cmd/wc-data-import) : wc_order_id +
-- wc_vendor_id identifient de façon stable UNE sous-commande importée
-- (une commande WooCommerce éclatée par vendeur donne plusieurs lignes
-- orders ici, d'où la clé composite plutôt qu'un simple wc_order_id
-- UNIQUE) — permet de relancer l'import sans dupliquer (ON CONFLICT).
-- orders.id reste un BIGSERIAL natif : rien d'externe ne référence un
-- id de sous-commande WooCommerce (contrairement à customers.id, voir
-- auth-svc), donc pas besoin de forcer sa valeur ici.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS wc_order_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_wc_import ON orders (wc_order_id, vendor_id) WHERE wc_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS coupons (
  code        TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('percent','fixed')),
  amount      BIGINT NOT NULL,
  expires_at  TIMESTAMPTZ,
  max_uses    INT NOT NULL DEFAULT 0,
  used_count  INT NOT NULL DEFAULT 0
);

-- Back-office admin (module Commandes) : historique horodaté des
-- changements d'état (timeline 360°) et retours/litiges — aucun des deux
-- n'existait, seuls created_at/updated_at sur la ligne elle-même.
CREATE TABLE IF NOT EXISTS order_events (
  id          BIGSERIAL PRIMARY KEY,
  order_id    BIGINT NOT NULL,
  event       TEXT NOT NULL,
  description TEXT DEFAULT '',
  actor       TEXT DEFAULT 'system',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events (order_id, occurred_at);

CREATE TABLE IF NOT EXISTS returns (
  id          BIGSERIAL PRIMARY KEY,
  order_id    BIGINT NOT NULL,
  product_id  BIGINT,
  reason      TEXT NOT NULL,
  photos      JSONB NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
  admin_note  TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_returns_status ON returns (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_returns_order ON returns (order_id);
`

type server struct {
	db             *pgxpool.Pool
	kafka          sarama.SyncProducer
	timeout        time.Duration
	shippingURL    string
	catalogURL     string  // restock au moment de l'annulation (module Commandes)
	vendorURL      string  // résolution du taux de commission par vendeur (module Commandes §1.2.A)
	commissionRate float64 // taux plateforme par défaut si le vendeur n'a pas d'override (vendors.commission_rate NULL)
}

// line — commission_rate/commission_usd/net_usd sont calculés ET FIGÉS au
// moment de la création de la commande (pas recalculés à la lecture) :
// pratique comptable standard — un changement de taux vendeur après coup ne
// doit jamais modifier rétroactivement une commission déjà facturée.
type line struct {
	ProductID      int64   `json:"product_id"`
	VariationID    int64   `json:"variation_id"`
	VendorID       int64   `json:"vendor_id"`
	Name           string  `json:"name"`
	Quantity       int     `json:"quantity"`
	UnitPrice      float64 `json:"unit_price_usd"`
	CommissionRate float64 `json:"commission_rate,omitempty"`
	CommissionUSD  float64 `json:"commission_usd,omitempty"`
	NetUSD         float64 `json:"net_usd,omitempty"`
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
	commissionRate, err := strconv.ParseFloat(kit.Env("PLATFORM_COMMISSION_RATE", "0.10"), 64)
	if err != nil {
		commissionRate = 0.10
	}
	s := &server{
		db:             db,
		kafka:          kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		timeout:        time.Duration(mins) * time.Minute,
		shippingURL:    kit.Env("SHIPPING_SVC_URL", "http://shipping-svc:8085"),
		catalogURL:     kit.Env("CATALOG_SVC_URL", "http://catalog-svc:8081"),
		vendorURL:      kit.Env("VENDOR_SVC_URL", "http://vendor-svc:8082"),
		commissionRate: commissionRate,
	}

	// Reaper : le cas d'échec partiel est géré, pas tu.
	go s.expireUnpaidLoop(log)

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)

	kit.Run("order-svc", kit.Env("PORT_ORDER", "8083"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("POST /orders", s.createOrder)
		mux.HandleFunc("GET /orders", s.listOrders)
		mux.HandleFunc("GET /orders/{id}", s.getOrder)
		mux.HandleFunc("GET /orders/parent/{parent_id}", s.getParentOrder)
		mux.HandleFunc("POST /orders/{id}/confirm", s.confirmPayment)
		mux.HandleFunc("PUT /orders/{id}/status", s.updateOrderStatus)
		mux.HandleFunc("PUT /orders/parent/{parent_id}/shipping-address", s.updateShippingAddress)
		mux.HandleFunc("GET /order-events/{id}", s.listOrderEvents)
		mux.HandleFunc("POST /orders/{id}/cancel", s.cancelOrder)
		mux.HandleFunc("POST /returns", s.createReturn)
		mux.HandleFunc("GET /returns", s.listReturns)
		mux.HandleFunc("PATCH /returns/{id}", s.moderateReturn)

		// Documents (module Commandes §1.5) : données structurées seulement —
		// pas de génération PDF serveur (aucune lib PDF dans le dépôt, cohérent
		// avec l'existant DHL où seul le label vient de l'API DHL elle-même).
		// Le frontend admin compose la vue imprimable (window.print()).
		// Renommés order-invoice/order-packing-slip (au lieu de orders/{id}/...) :
		// même conflit net/http que order-events vs orders/parent/{id} déjà
		// rencontré ailleurs — "GET /orders/{id}/invoice" et
		// "GET /orders/parent/{parent_id}" matchent tous deux
		// "/orders/parent/invoice" sans qu'aucun ne soit plus spécifique.
		mux.HandleFunc("GET /order-invoice/{id}", s.getOrderInvoice)
		mux.HandleFunc("GET /order-packing-slip/{id}", s.getOrderPackingSlip)
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

	// Devise de livraison résolue AVANT la transaction : shipping-svc est
	// synchrone au checkout (voir en-tête shipping-svc/main.go), jamais
	// bloquant côté DB si indisponible — la commande passe alors avec
	// shipping_usd=0 plutôt que d'échouer entièrement (frais recalculables
	// après coup, contrairement à un prix produit qui ne doit jamais dériver).
	destCountry := destCountryFrom(body.ShippingAddress)

	created := []map[string]any{}
	seq := 1
	for vendorID, lines := range byVendor {
		// Commission figée au moment de la vente (voir doc-comment de line) —
		// un seul appel vendor-svc par boutique, pas par ligne.
		rate := s.resolveCommissionRate(ctx, vendorID)
		var subtotal, commissionTotal float64
		itemCount := 0
		for i := range lines {
			lineTotal := lines[i].UnitPrice * float64(lines[i].Quantity)
			subtotal += lineTotal
			itemCount += lines[i].Quantity
			lines[i].CommissionRate = rate
			lines[i].CommissionUSD = round2(lineTotal * rate)
			lines[i].NetUSD = round2(lineTotal - lines[i].CommissionUSD)
			commissionTotal += lines[i].CommissionUSD
		}
		shippingUSD := s.quoteShippingUSD(ctx, destCountry, itemCount)
		total := subtotal + shippingUSD

		linesJSON, _ := json.Marshal(lines)
		var id int64
		orderRef := fmt.Sprintf("%s-%d", ref, seq)
		if err := tx.QueryRow(ctx, `
			INSERT INTO orders (reference, customer_id, vendor_id, parent_order_id, status,
			                    payment_status, fulfillment_stage,
			                    lines, subtotal_usd, shipping_usd, total_usd, coupon_code,
			                    shipping_address, billing_address, payment_method)
			VALUES ($1,$2,$3,$4,'pending_payment','pending','pending',$5,$6,$7,$8,$9,$10,$11,$12)
			RETURNING id`,
			orderRef, body.CustomerID, vendorID, parentID,
			linesJSON, subtotal, shippingUSD, total, body.CouponCode,
			body.ShippingAddress, body.BillingAddress, body.PaymentMethod,
		).Scan(&id); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		created = append(created, map[string]any{
			"id": id, "reference": orderRef, "vendor_id": vendorID,
			"status": "pending_payment", "subtotal_usd": subtotal,
			"shipping_usd": shippingUSD, "total_usd": total,
			"commission_usd": round2(commissionTotal), "net_usd": round2(subtotal - commissionTotal),
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
			"customer_id": body.CustomerID, "total_usd": o["total_usd"],
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
		where += fmt.Sprintf(" AND vendor_id = $%d", len(args)+1)
		args = append(args, atoi(v))
	}
	// vendor_ids (CSV) — filtre "zone représentant" (module Utilisateurs) :
	// agréger les commandes de TOUS les vendeurs d'un pays en un seul appel
	// plutôt que N requêtes vendor_id= côté loyalty-svc.
	if v := q.Get("vendor_ids"); v != "" {
		ids := []int64{}
		for _, part := range strings.Split(v, ",") {
			if id := atoi(strings.TrimSpace(part)); id > 0 {
				ids = append(ids, id)
			}
		}
		if len(ids) > 0 {
			where += fmt.Sprintf(" AND vendor_id = ANY($%d)", len(args)+1)
			args = append(args, ids)
		}
	}
	if v := q.Get("customer_id"); v != "" {
		where += fmt.Sprintf(" AND customer_id = $%d", len(args)+1)
		args = append(args, atoi(v))
	}
	if v := q.Get("status"); v != "" {
		where += fmt.Sprintf(" AND status = $%d", len(args)+1)
		args = append(args, v)
	}
	// Filtres combinés module Commandes §1.1 : statut de paiement et étape
	// logistique sont désormais deux critères indépendants (voir
	// statusToStages) — un admin peut par ex. lister "payé + en préparation".
	if v := q.Get("payment_status"); v != "" {
		where += fmt.Sprintf(" AND payment_status = $%d", len(args)+1)
		args = append(args, v)
	}
	if v := q.Get("fulfillment_stage"); v != "" {
		where += fmt.Sprintf(" AND fulfillment_stage = $%d", len(args)+1)
		args = append(args, v)
	}
	if v := q.Get("payment_method"); v != "" {
		where += fmt.Sprintf(" AND payment_method = $%d", len(args)+1)
		args = append(args, v)
	}
	if v := q.Get("q"); v != "" {
		where += fmt.Sprintf(" AND reference ILIKE $%d", len(args)+1)
		args = append(args, "%"+v+"%")
	}

	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM orders "+where, args...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT id, reference, customer_id, vendor_id, status, payment_status, fulfillment_stage,
		       total_usd, payment_method, created_at
		FROM orders `+where+` ORDER BY id DESC
		LIMIT `+strconv.Itoa(pageSize)+` OFFSET `+strconv.Itoa((page-1)*pageSize), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, cust, vendor int64
		var total float64
		var ref, status, paymentStatus, fulfillmentStage, paymentMethod string
		var at time.Time
		_ = rows.Scan(&id, &ref, &cust, &vendor, &status, &paymentStatus, &fulfillmentStage, &total, &paymentMethod, &at)
		items = append(items, map[string]any{
			"id": id, "reference": ref, "customer_id": cust, "vendor_id": vendor,
			"status": status, "payment_status": paymentStatus, "fulfillment_stage": fulfillmentStage,
			"total_usd": total, "payment_method": paymentMethod,
			"created_at": at.UTC().Format(time.RFC3339),
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
		SELECT id, reference, customer_id, vendor_id, parent_order_id, status, payment_status, fulfillment_stage, lines,
		       subtotal_usd, shipping_usd, total_usd, coupon_code, shipping_address, billing_address, created_at, updated_at
		FROM orders WHERE id = $1`, id)
	var oid, cust, vendor, parent int64
	var subtotal, shipping, total float64
	var ref, status, paymentStatus, fulfillmentStage, coupon string
	var lines, shipAddr, billAddr []byte
	var createdAt, updatedAt time.Time
	if err := row.Scan(&oid, &ref, &cust, &vendor, &parent, &status, &paymentStatus, &fulfillmentStage, &lines,
		&subtotal, &shipping, &total, &coupon, &shipAddr, &billAddr, &createdAt, &updatedAt); err != nil {
		kit.Fail(w, 404, "order_not_found", fmt.Sprintf("commande %d introuvable", id))
		return
	}
	out := map[string]any{
		"id": oid, "reference": ref, "customer_id": cust, "vendor_id": vendor,
		"parent_order_id": parent, "status": status,
		"payment_status": paymentStatus, "fulfillment_stage": fulfillmentStage,
		"lines":        json.RawMessage(lines),
		"subtotal_usd": subtotal, "shipping_usd": shipping, "total_usd": total,
		"coupon_code": coupon,
		"created_at":  createdAt.UTC().Format(time.RFC3339),
		"updated_at":  updatedAt.UTC().Format(time.RFC3339),
	}
	if len(shipAddr) > 0 {
		out["shipping_address"] = json.RawMessage(shipAddr)
	}
	if len(billAddr) > 0 {
		out["billing_address"] = json.RawMessage(billAddr)
	}
	kit.JSON(w, 200, out)
}

// getOrderInvoice — facture client (module Commandes §1.5). Données
// structurées uniquement, voir doc-comment de la route pour le pourquoi.
func (s *server) getOrderInvoice(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	row := s.db.QueryRow(r.Context(), `
		SELECT id, reference, customer_id, vendor_id, status, payment_status, lines,
		       subtotal_usd, shipping_usd, total_usd, coupon_code, billing_address, payment_method, created_at
		FROM orders WHERE id = $1`, id)
	var oid, cust, vendor int64
	var subtotal, shipping, total float64
	var ref, status, paymentStatus, coupon, paymentMethod string
	var lines, billAddr []byte
	var createdAt time.Time
	if err := row.Scan(&oid, &ref, &cust, &vendor, &status, &paymentStatus, &lines,
		&subtotal, &shipping, &total, &coupon, &billAddr, &paymentMethod, &createdAt); err != nil {
		kit.Fail(w, 404, "order_not_found", fmt.Sprintf("commande %d introuvable", id))
		return
	}
	var vendorLines []line
	_ = json.Unmarshal(lines, &vendorLines)
	items := []map[string]any{}
	for _, l := range vendorLines {
		items = append(items, map[string]any{
			"name": l.Name, "quantity": l.Quantity,
			"unit_price_usd": strconv.FormatFloat(l.UnitPrice, 'f', 2, 64),
			"line_total_usd": strconv.FormatFloat(l.UnitPrice*float64(l.Quantity), 'f', 2, 64),
		})
	}
	out := map[string]any{
		"order_id": oid, "invoice_number": "INV-" + ref, "reference": ref,
		"vendor_id": vendor, "customer_id": cust,
		"status": status, "payment_status": paymentStatus, "payment_method": paymentMethod,
		"items":        items,
		"subtotal_usd": strconv.FormatFloat(subtotal, 'f', 2, 64),
		"shipping_usd": strconv.FormatFloat(shipping, 'f', 2, 64),
		"total_usd":    strconv.FormatFloat(total, 'f', 2, 64),
		"coupon_code":  coupon,
		"issued_at":    createdAt.UTC().Format(time.RFC3339),
		// TVA : aucun taux/numéro fiscal configuré nulle part dans le backend
		// actuel (pas de champ dédié côté vendor-svc/admin-svc) — signalé
		// explicitement plutôt que d'inventer un taux, la facture reste hors
		// taxe tant que ce n'est pas configuré.
		"tax_note": "aucune TVA appliquée — non configurée côté plateforme",
	}
	if len(billAddr) > 0 {
		out["billing_address"] = json.RawMessage(billAddr)
	}
	kit.JSON(w, 200, out)
}

// getOrderPackingSlip — bordereau d'expédition vendeur (module Commandes
// §1.5) : ce que le vendeur imprime pour préparer le colis, pas de prix ni
// de coordonnées de paiement (contrairement à la facture).
func (s *server) getOrderPackingSlip(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	row := s.db.QueryRow(r.Context(), `
		SELECT id, reference, vendor_id, lines, shipping_address, created_at
		FROM orders WHERE id = $1`, id)
	var oid, vendor int64
	var ref string
	var lines, shipAddr []byte
	var createdAt time.Time
	if err := row.Scan(&oid, &ref, &vendor, &lines, &shipAddr, &createdAt); err != nil {
		kit.Fail(w, 404, "order_not_found", fmt.Sprintf("commande %d introuvable", id))
		return
	}
	var vendorLines []line
	_ = json.Unmarshal(lines, &vendorLines)
	items := []map[string]any{}
	for _, l := range vendorLines {
		items = append(items, map[string]any{
			"product_id": l.ProductID, "variation_id": l.VariationID,
			"name": l.Name, "quantity": l.Quantity,
		})
	}
	out := map[string]any{
		"order_id": oid, "reference": ref, "vendor_id": vendor,
		"items":      items,
		"created_at": createdAt.UTC().Format(time.RFC3339),
	}
	if len(shipAddr) > 0 {
		out["shipping_address"] = json.RawMessage(shipAddr)
	}
	kit.JSON(w, 200, out)
}

// getParentOrder — recompose une vue "commande unique" au format
// WooCommerce (id, number, status, total en STRING décimale, line_items[],
// currency) à partir des vendor_orders éclatés par boutique. Le modèle
// multi-vendeur reste la source de vérité (chaque vendor_order garde son
// propre cycle de vie) ; cet endpoint sert UNIQUEMENT à ce que le
// frontend actuel (qui attend une commande unique après checkout /
// dans l'historique client) puisse la lire sans réécriture.
func (s *server) getParentOrder(w http.ResponseWriter, r *http.Request) {
	parentID := atoi(r.PathValue("parent_id"))

	var reference string
	var createdAt time.Time
	if err := s.db.QueryRow(r.Context(),
		`SELECT reference, created_at FROM orders WHERE id = $1 AND status = 'group'`, parentID,
	).Scan(&reference, &createdAt); err != nil {
		kit.Fail(w, 404, "order_not_found", fmt.Sprintf("commande groupée %d introuvable", parentID))
		return
	}

	rows, err := s.db.Query(r.Context(), `
		SELECT vendor_id, status, lines, shipping_usd, total_usd
		FROM orders WHERE parent_order_id = $1 ORDER BY id`, parentID)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	var totalUSD, shippingUSD float64
	lineItems := []map[string]any{}
	statuses := map[string]bool{}
	found := false

	for rows.Next() {
		var vendorID int64
		var status string
		var lines []byte
		var shipping, total float64
		if err := rows.Scan(&vendorID, &status, &lines, &shipping, &total); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		found = true
		totalUSD += total
		shippingUSD += shipping
		statuses[status] = true

		var vendorLines []line
		_ = json.Unmarshal(lines, &vendorLines)
		for _, l := range vendorLines {
			lineItems = append(lineItems, map[string]any{
				"product_id": l.ProductID, "variation_id": l.VariationID, "vendor_id": vendorID,
				"name": l.Name, "quantity": l.Quantity,
				"price": strconv.FormatFloat(l.UnitPrice, 'f', 2, 64),
				"total": strconv.FormatFloat(l.UnitPrice*float64(l.Quantity), 'f', 2, 64),
				// Répartition par vendeur (module Commandes §1.2.A) : commission
				// figée à la création de la commande, jamais recalculée ici.
				"commission_rate": l.CommissionRate,
				"commission_usd":  strconv.FormatFloat(l.CommissionUSD, 'f', 2, 64),
				"net_usd":         strconv.FormatFloat(l.NetUSD, 'f', 2, 64),
			})
		}
	}
	if !found {
		kit.Fail(w, 404, "order_not_found", fmt.Sprintf("commande groupée %d introuvable", parentID))
		return
	}

	kit.JSON(w, 200, map[string]any{
		"id": parentID, "number": reference, "reference": reference,
		"status": aggregateStatus(statuses),
		"total":  strconv.FormatFloat(totalUSD, 'f', 2, 64), "currency": "USD",
		"shipping_total": strconv.FormatFloat(shippingUSD, 'f', 2, 64),
		"line_items":     lineItems,
		"date_created":   createdAt.UTC().Format(time.RFC3339),
	})
}

// aggregateStatus — un seul statut affichable pour l'acheteur à partir
// des statuts (potentiellement différents) de chaque sous-commande.
// Explicite : "partially_paid" plutôt que de choisir arbitrairement le
// statut d'une seule sous-commande et cacher les autres.
func aggregateStatus(statuses map[string]bool) string {
	if len(statuses) == 1 {
		for s := range statuses {
			return s
		}
	}
	if statuses["paid"] && (statuses["pending_payment"] || statuses["payment_expired"]) {
		return "partially_paid"
	}
	return "mixed"
}

// destCountryFrom — extrait le code pays ISO alpha-2 de l'adresse de
// livraison (JSON libre côté frontend), pour interroger shipping-svc.
func destCountryFrom(shippingAddress json.RawMessage) string {
	var addr struct {
		Country string `json:"country"`
	}
	_ = json.Unmarshal(shippingAddress, &addr)
	return addr.Country
}

// quoteShippingUSD — appel SYNCHRONE à shipping-svc au checkout (voir
// en-tête shipping-svc/main.go). Ne bloque jamais la commande : si le
// pays est inconnu ou shipping-svc injoignable, renvoie 0 plutôt que de
// faire échouer toute la commande — les frais restent ajustables après
// coup (contrairement à un prix produit, qui ne doit jamais dériver).
func (s *server) quoteShippingUSD(ctx context.Context, country string, itemCount int) float64 {
	if country == "" {
		return 0
	}
	url := fmt.Sprintf("%s/shipping-rates/quote?country=%s&items=%d", s.shippingURL, country, itemCount)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0
	}
	var out struct {
		TotalUSD float64 `json:"total_usd"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return 0
	}
	return out.TotalUSD
}

// confirmPayment — appelé en interne par payment-svc après
// payment.confirmed (en prod : gRPC, pas HTTP).
func (s *server) confirmPayment(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	res, err := s.db.Exec(r.Context(), `
		UPDATE orders SET status = 'paid', payment_status = 'paid', fulfillment_stage = 'pending', updated_at = now()
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

// updateOrderStatus — changement de statut manuel (admin/représentant),
// distinct de confirmPayment (déclenché par payment-svc). Pas de contrôle
// de rôle ici : admin-svc filtre déjà par JWT en amont avant de relayer.
var validOrderStatuses = map[string]bool{
	"pending_payment": true, "paid": true, "processing": true,
	"shipped": true, "delivered": true, "cancelled": true, "refunded": true,
	"payment_expired": true,
}

// statusToStages — correspondance status (legacy, fourre-tout) →
// (payment_status, fulfillment_stage) séparés, utilisée partout où status
// est écrit pour que les deux nouveaux champs restent synchronisés. Même
// table que le backfill du schéma (voir const schema) — une seule source
// de vérité pour ce mapping.
func statusToStages(status string) (paymentStatus, fulfillmentStage string) {
	switch status {
	case "pending_payment":
		return "pending", "pending"
	case "payment_expired":
		return "expired", "pending"
	case "paid":
		return "paid", "pending"
	case "processing":
		return "paid", "preparing"
	case "shipped":
		return "paid", "in_transit"
	case "delivered":
		return "paid", "delivered"
	case "cancelled":
		return "pending", "cancelled"
	case "refunded":
		return "refunded", "cancelled"
	default:
		return "pending", "pending"
	}
}

func (s *server) updateOrderStatus(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	var body struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if !validOrderStatuses[body.Status] {
		kit.Fail(w, 400, "invalid_status", fmt.Sprintf("statut %q inconnu", body.Status))
		return
	}
	paymentStatus, fulfillmentStage := statusToStages(body.Status)
	res, err := s.db.Exec(r.Context(),
		"UPDATE orders SET status = $2, payment_status = $3, fulfillment_stage = $4, updated_at = now() WHERE id = $1",
		id, body.Status, paymentStatus, fulfillmentStage)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if res.RowsAffected() == 0 {
		kit.Fail(w, 404, "order_not_found", fmt.Sprintf("commande %d introuvable", id))
		return
	}
	kit.Publish(s.kafka, "order.status_changed", fmt.Sprint(id), map[string]any{
		"order_id": id, "status": body.Status, "at": time.Now().UTC().Format(time.RFC3339),
	})
	s.logOrderEvent(r.Context(), id, "status_changed", fmt.Sprintf("statut changé vers %q", body.Status), "admin")
	kit.JSON(w, 200, map[string]any{"id": id, "status": body.Status})
}

// logOrderEvent — alimente la timeline 360° (module Commandes). Jamais
// bloquant : une erreur d'écriture ici ne doit jamais faire échouer
// l'action métier réelle (changement de statut/annulation), juste être
// journalisée côté serveur.
func (s *server) logOrderEvent(ctx context.Context, orderID int64, event, description, actor string) {
	if _, err := s.db.Exec(ctx,
		"INSERT INTO order_events (order_id, event, description, actor) VALUES ($1,$2,$3,$4)",
		orderID, event, description, actor); err != nil {
		fmt.Printf("order_events insert échoué order_id=%d err=%v\n", orderID, err)
	}
}

func (s *server) listOrderEvents(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	rows, err := s.db.Query(r.Context(),
		"SELECT id, event, description, actor, occurred_at FROM order_events WHERE order_id = $1 ORDER BY occurred_at", id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var eid int64
		var event, description, actor string
		var occurredAt time.Time
		if err := rows.Scan(&eid, &event, &description, &actor, &occurredAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		items = append(items, map[string]any{
			"id": eid, "event": event, "description": description, "actor": actor,
			"occurred_at": occurredAt.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{"items": items})
}

// cancelOrder — annule ET réintègre le stock de chaque ligne dans
// catalog-svc (le champ stock posé par le module Catalogue rend ça
// possible). Le restock n'est JAMAIS bloquant pour l'annulation
// elle-même : la commande passe annulée même si un appel catalog-svc
// échoue pour une ligne — l'écart de stock se réconcilie manuellement,
// mais le client ne doit jamais rester bloqué sur une commande "non
// annulable" à cause d'un service tiers en panne.
func (s *server) cancelOrder(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	var status string
	var linesJSON []byte
	if err := s.db.QueryRow(r.Context(),
		"SELECT status, lines FROM orders WHERE id = $1", id,
	).Scan(&status, &linesJSON); err != nil {
		kit.Fail(w, 404, "order_not_found", fmt.Sprintf("commande %d introuvable", id))
		return
	}
	if status == "cancelled" || status == "delivered" {
		kit.Fail(w, 409, "not_cancellable", fmt.Sprintf("commande déjà %q, non annulable", status))
		return
	}

	if _, err := s.db.Exec(r.Context(),
		"UPDATE orders SET status = 'cancelled', payment_status = 'pending', fulfillment_stage = 'cancelled', updated_at = now() WHERE id = $1", id); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.Publish(s.kafka, "order.status_changed", fmt.Sprint(id), map[string]any{
		"order_id": id, "status": "cancelled", "at": time.Now().UTC().Format(time.RFC3339),
	})

	var lines []line
	_ = json.Unmarshal(linesJSON, &lines)
	restocked := 0
	for _, l := range lines {
		if l.ProductID == 0 || l.Quantity <= 0 {
			continue
		}
		if err := s.restockProduct(r.Context(), l.ProductID, l.Quantity); err != nil {
			s.logOrderEvent(r.Context(), id, "restock_failed",
				fmt.Sprintf("réintégration stock produit %d échouée: %v", l.ProductID, err), "system")
			continue
		}
		restocked++
	}
	s.logOrderEvent(r.Context(), id, "cancelled",
		fmt.Sprintf("commande annulée, %d/%d ligne(s) réintégrée(s) en stock", restocked, len(lines)), "admin")

	kit.JSON(w, 200, map[string]any{"id": id, "status": "cancelled", "lines_restocked": restocked, "lines_total": len(lines)})
}

// restockProduct — incrémente le stock via l'endpoint admin PATCH déjà
// exposé par catalog-svc, pas un accès DB direct (order-svc ne possède
// pas cette donnée). Lit le stock actuel d'abord : pas d'opération
// atomique "increment" côté catalog-svc, donc read-then-write ici — un
// risque de course accepté pour cette première itération (annulations
// concurrentes du même produit sont rares).
func (s *server) restockProduct(ctx context.Context, productID int64, qty int) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/products/%d", s.catalogURL, productID), nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("catalog-svc a répondu %d", resp.StatusCode)
	}
	var product struct {
		Stock int `json:"stock"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&product); err != nil {
		return err
	}

	payload, _ := json.Marshal(map[string]any{"stock": product.Stock + qty})
	patchReq, err := http.NewRequestWithContext(ctx, http.MethodPatch,
		fmt.Sprintf("%s/products/%d", s.catalogURL, productID), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	patchReq.Header.Set("Content-Type", "application/json")
	patchResp, err := http.DefaultClient.Do(patchReq)
	if err != nil {
		return err
	}
	defer patchResp.Body.Close()
	if patchResp.StatusCode != http.StatusOK {
		return fmt.Errorf("catalog-svc PATCH a répondu %d", patchResp.StatusCode)
	}
	return nil
}

// resolveCommissionRate — vendors.commission_rate (posé par le module
// Vendeurs) prioritaire s'il est renseigné, sinon repli sur le taux
// plateforme global (PLATFORM_COMMISSION_RATE). Best-effort : vendor-svc
// injoignable ou vendeur introuvable ne doit jamais bloquer la création
// d'une commande — repli silencieux sur le taux global dans ce cas.
func (s *server) resolveCommissionRate(ctx context.Context, vendorID int64) float64 {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/vendor/%d", s.vendorURL, vendorID), nil)
	if err != nil {
		return s.commissionRate
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return s.commissionRate
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return s.commissionRate
	}
	var vendor struct {
		CommissionRate *float64 `json:"commission_rate"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&vendor); err != nil || vendor.CommissionRate == nil {
		return s.commissionRate
	}
	return *vendor.CommissionRate
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

/* ---------- Retours & litiges (module Commandes) ---------- */

func (s *server) createReturn(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OrderID   int64    `json:"order_id"`
		ProductID int64    `json:"product_id"`
		Reason    string   `json:"reason"`
		Photos    []string `json:"photos"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.OrderID == 0 || body.Reason == "" {
		kit.Fail(w, 400, "missing_fields", "order_id et reason requis")
		return
	}
	photosJSON, _ := json.Marshal(body.Photos)
	var id int64
	err := s.db.QueryRow(r.Context(), `
		INSERT INTO returns (order_id, product_id, reason, photos) VALUES ($1,$2,$3,$4) RETURNING id`,
		body.OrderID, nullIfZero(body.ProductID), body.Reason, photosJSON,
	).Scan(&id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	s.logOrderEvent(r.Context(), body.OrderID, "return_requested", body.Reason, "customer")
	kit.JSON(w, 201, map[string]any{"id": id})
}

func (s *server) listReturns(w http.ResponseWriter, r *http.Request) {
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
	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM returns "+where, args...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(r.Context(), fmt.Sprintf(`
		SELECT id, order_id, product_id, reason, photos, status, admin_note, created_at, processed_at
		FROM returns %s ORDER BY created_at DESC LIMIT $%d OFFSET $%d`, where, len(args)-1, len(args)), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, orderID int64
		var productID *int64
		var reason, status, adminNote string
		var photosJSON []byte
		var createdAt time.Time
		var processedAt *time.Time
		if err := rows.Scan(&id, &orderID, &productID, &reason, &photosJSON, &status, &adminNote, &createdAt, &processedAt); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		var processedStr any
		if processedAt != nil {
			processedStr = processedAt.UTC().Format(time.RFC3339)
		}
		items = append(items, map[string]any{
			"id": id, "order_id": orderID, "product_id": productID, "reason": reason,
			"photos": json.RawMessage(photosJSON), "status": status, "admin_note": adminNote,
			"created_at": createdAt.UTC().Format(time.RFC3339), "processed_at": processedStr,
		})
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

func (s *server) moderateReturn(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	var body struct {
		Status    string `json:"status"`
		AdminNote string `json:"admin_note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Status != "accepted" && body.Status != "rejected" {
		kit.Fail(w, 400, "invalid_status", "status doit être accepted ou rejected")
		return
	}
	var orderID int64
	if err := s.db.QueryRow(r.Context(), `
		UPDATE returns SET status = $2, admin_note = $3, processed_at = now()
		WHERE id = $1 RETURNING order_id`, id, body.Status, body.AdminNote,
	).Scan(&orderID); err != nil {
		kit.Fail(w, 404, "return_not_found", fmt.Sprintf("retour %d introuvable", id))
		return
	}
	s.logOrderEvent(r.Context(), orderID, "return_"+body.Status, body.AdminNote, "admin")
	kit.JSON(w, 200, map[string]any{"id": id, "status": body.Status})
}

// editableShippingStatuses — statuts pour lesquels le client peut encore
// corriger son adresse de livraison, avant que la commande ne soit
// physiquement prise en charge/expédiée.
var editableShippingStatuses = map[string]bool{
	"pending_payment": true, "paid": true, "processing": true,
}

// updateShippingAddress — permet au CLIENT propriétaire d'une commande
// groupée (pas seulement admin/représentant) de corriger son adresse de
// livraison après l'achat, tant qu'aucune sous-commande n'est encore
// expédiée. Met à jour TOUTES les sous-commandes du groupe (même adresse
// dupliquée sur chacune à la création, voir createOrder).
func (s *server) updateShippingAddress(w http.ResponseWriter, r *http.Request) {
	parentID := atoi(r.PathValue("parent_id"))
	var body struct {
		CustomerID      int64           `json:"customer_id"`
		ShippingAddress json.RawMessage `json:"shipping_address"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.CustomerID == 0 || len(body.ShippingAddress) == 0 {
		kit.Fail(w, 400, "missing_fields", "customer_id et shipping_address sont obligatoires")
		return
	}

	rows, err := s.db.Query(r.Context(),
		"SELECT id, customer_id, status FROM orders WHERE parent_order_id = $1", parentID)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	var ids []int64
	for rows.Next() {
		var id, custID int64
		var status string
		if err := rows.Scan(&id, &custID, &status); err != nil {
			rows.Close()
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		if custID != body.CustomerID {
			rows.Close()
			kit.Fail(w, 403, "not_owner", "cette commande ne vous appartient pas")
			return
		}
		if !editableShippingStatuses[status] {
			rows.Close()
			kit.Fail(w, 409, "not_editable", "cette commande est déjà en cours d'expédition et ne peut plus être modifiée")
			return
		}
		ids = append(ids, id)
	}
	rows.Close()
	if len(ids) == 0 {
		kit.Fail(w, 404, "order_not_found", fmt.Sprintf("commande groupée %d introuvable", parentID))
		return
	}

	if _, err := s.db.Exec(r.Context(),
		"UPDATE orders SET shipping_address = $2, updated_at = now() WHERE id = ANY($1)",
		ids, body.ShippingAddress,
	); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.JSON(w, 200, map[string]any{"success": true, "shipping_address": json.RawMessage(body.ShippingAddress)})
}

// expireUnpaidLoop — gestion explicite du cas "commande créée,
// confirmation de paiement jamais reçue".
func (s *server) expireUnpaidLoop(log interface{ Info(string, ...any) }) {
	tick := time.NewTicker(time.Minute)
	for range tick.C {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		res, err := s.db.Exec(ctx, `
			UPDATE orders SET status = 'payment_expired', payment_status = 'expired', fulfillment_stage = 'pending', updated_at = now()
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

func nullIfZero(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}

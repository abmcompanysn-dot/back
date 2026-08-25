// ============================================================
// fulfillment-svc — tracking unifié + expédition internationale DHL.
// Remplace 3 schémas de tracking parallèles historiques (générique,
// DHL, custom-emails) par UNE table shipments + tracking_events.
// Consomme order.status_changed (Kafka) pour créer l'expédition
// dès qu'une commande passe "paid" ET a un mode d'expédition
// international (payment_method / vendor hors zone locale — la
// décision fine reste côté order-svc, ici on réagit à l'événement).
// Publie : shipment.created, shipment.status_changed
// ============================================================
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
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
-- Table UNIQUE pour toute expédition, quel que soit le transporteur.
-- Remplace les 3 schémas parallèles historiques (générique / DHL /
-- custom-emails) qui divergaient silencieusement.
CREATE TABLE IF NOT EXISTS shipments (
  id              BIGSERIAL PRIMARY KEY,
  order_id        BIGINT NOT NULL,
  carrier         TEXT NOT NULL DEFAULT 'dhl',
  tracking_number TEXT UNIQUE,
  dhl_shipment_id TEXT,
  label_url       TEXT DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending_label',
  origin_country  TEXT DEFAULT '',
  origin_city     TEXT DEFAULT '',
  dest_country    TEXT DEFAULT '',
  dest_city       TEXT DEFAULT '',
  rate_quote_json JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments (order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments (tracking_number);

CREATE TABLE IF NOT EXISTS tracking_events (
  id          BIGSERIAL PRIMARY KEY,
  shipment_id BIGINT NOT NULL REFERENCES shipments(id),
  status      TEXT NOT NULL,
  description TEXT DEFAULT '',
  location    TEXT DEFAULT '',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source      TEXT NOT NULL DEFAULT 'dhl_api' -- dhl_api | manual | scan
);
CREATE INDEX IF NOT EXISTS idx_tracking_events_shipment ON tracking_events (shipment_id);
`

// shipmentStages — 5 états de la livraison internationale, DISTINCTS
// des 8 états de la livraison nationale Sénégal (shipping-svc). Ne
// jamais fusionner les deux machines : logiques métier différentes
// (transporteur externe + douane vs ramassage local).
var shipmentStages = map[string]bool{
	"pending_label": true, // commande payée, label DHL pas encore créé
	"label_created": true,
	"in_transit":    true,
	"customs":       true,
	"delivered":     true,
}

type server struct {
	db             *pgxpool.Pool
	kafka          sarama.SyncProducer
	orderURL       string
	vendorURL      string
	catalogURL     string
	dhlBaseURL     string
	dhlUsername    string
	dhlPassword    string
	dhlAccount     string
	dhlIncoterm    string
	shipperZip     string
	shipperCity    string
	shipperCountry string
}

func main() {
	ctx := context.Background()
	log := kit.Logger("fulfillment-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_FULFILLMENT", "postgres://miad:miad@postgres:5432/miad_fulfillment?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema); err != nil {
		log.Error("migration impossible", "err", err)
		return
	}

	s := &server{
		db:             db,
		kafka:          kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		orderURL:       kit.Env("ORDER_SVC_URL", "http://order-svc:8083"),
		vendorURL:      kit.Env("VENDOR_SVC_URL", "http://vendor-svc:8082"),
		catalogURL:     kit.Env("CATALOG_SVC_URL", "http://catalog-svc:8081"),
		dhlBaseURL:     kit.Env("DHL_API_BASE", "https://express.api.dhl.com/mydhlapi"),
		dhlUsername:    kit.Env("DHL_API_USERNAME", ""),
		dhlPassword:    kit.Env("DHL_API_PASSWORD", ""),
		dhlAccount:     kit.Env("DHL_ACCOUNT_NUMBER", ""),
		dhlIncoterm:    kit.Env("DHL_INCOTERM", "DAP"),
		shipperZip:     kit.Env("DHL_SHIPPER_ZIP", ""),
		shipperCity:    kit.Env("DHL_SHIPPER_CITY", "Dakar"),
		shipperCountry: kit.Env("DHL_SHIPPER_COUNTRY", "SN"),
	}
	go s.consumeOrderEvents(log)

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	health.Add("dhl_credentials", func(ctx context.Context) error {
		if s.dhlUsername == "" || s.dhlPassword == "" {
			return fmt.Errorf("DHL_API_USERNAME / DHL_API_PASSWORD absents — /dhl/* échouera explicitement")
		}
		return nil
	})

	kit.Run("fulfillment-svc", kit.Env("PORT_FULFILLMENT", "8090"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("GET /shipments", s.listShipments)
		mux.HandleFunc("POST /shipments", s.createManualShipment)
		mux.HandleFunc("GET /shipments/order/{order_id}", s.getShipmentByOrder)
		mux.HandleFunc("POST /tracking/{shipment_id}/event", s.addManualEvent)
		mux.HandleFunc("GET /tracking/search/{number}", s.trackByNumber)

		mux.HandleFunc("GET /dhl/rate", s.dhlRate)
		mux.HandleFunc("POST /dhl/create-shipment", s.dhlCreateShipment)
		mux.HandleFunc("GET /dhl/tracking/{tracking_number}", s.dhlRefreshTracking)

		// Portage fidèle du dashboard "Logistique DHL" WordPress
		// (miad-dhl.php / register_rest_route miad-products/v1) : liste des
		// commandes candidates à l'expédition, détail enrichi (adresse,
		// articles, tarif estimé), et création "tout-en-un" (construit le
		// payload MyDHL depuis order-svc/vendor-svc/catalog-svc, contrairement
		// à POST /dhl/create-shipment qui exige un dhl_payload déjà prêt).
		mux.HandleFunc("GET /dhl/orders", s.dhlListOrders)
		mux.HandleFunc("GET /dhl/order/{id}", s.dhlOrderDetail)
		mux.HandleFunc("POST /dhl/orders/{id}/create-shipment", s.dhlBuildAndCreateShipment)
	})
}

/* ---------- Kafka : réaction à order.status_changed ---------- */

func (s *server) consumeOrderEvents(log *slog.Logger) {
	brokers := kit.Env("KAFKA_BROKERS", "kafka:9092")
	if brokers == "" {
		log.Warn("KAFKA_BROKERS vide — consommation désactivée (mode dev)")
		return
	}
	cfg := sarama.NewConfig()
	cfg.Consumer.Offsets.Initial = sarama.OffsetOldest
	cfg.Version = sarama.V2_8_0_0

	for {
		group, err := sarama.NewConsumerGroup([]string{brokers}, "fulfillment-svc", cfg)
		if err != nil {
			log.Error("kafka injoignable — retry 5 s", "err", err)
			time.Sleep(5 * time.Second)
			continue
		}
		handler := fulfillmentConsumer{s: s, log: log}
		_ = group.Consume(context.Background(), []string{"order.status_changed"}, handler)
		group.Close()
	}
}

type fulfillmentConsumer struct {
	s   *server
	log *slog.Logger
}

func (f fulfillmentConsumer) Setup(sarama.ConsumerGroupSession) error   { return nil }
func (f fulfillmentConsumer) Cleanup(sarama.ConsumerGroupSession) error { return nil }
func (f fulfillmentConsumer) ConsumeClaim(sess sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
	for msg := range claim.Messages() {
		var payload struct {
			OrderID int64  `json:"order_id"`
			Status  string `json:"status"`
		}
		if err := json.Unmarshal(msg.Value, &payload); err == nil && payload.Status == "paid" && payload.OrderID > 0 {
			f.s.ensureShipment(sess.Context(), f.log, payload.OrderID)
		}
		sess.MarkMessage(msg, "")
	}
	return nil
}

// ensureShipment — crée l'expédition en attente de label si elle
// n'existe pas déjà (idempotent : une commande payée deux fois ne
// duplique pas l'expédition).
func (s *server) ensureShipment(ctx context.Context, log *slog.Logger, orderID int64) {
	var existing int64
	err := s.db.QueryRow(ctx, "SELECT id FROM shipments WHERE order_id = $1", orderID).Scan(&existing)
	if err == nil {
		return // déjà créée
	}
	if err != pgx.ErrNoRows {
		log.Error("vérification expédition existante impossible", "order_id", orderID, "err", err)
		return
	}
	var id int64
	if err := s.db.QueryRow(ctx, `
		INSERT INTO shipments (order_id, status) VALUES ($1, 'pending_label') RETURNING id`,
		orderID).Scan(&id); err != nil {
		log.Error("création expédition impossible", "order_id", orderID, "err", err)
		return
	}
	s.recordEvent(ctx, id, "pending_label", "commande payée — en attente de création du label DHL", "", "manual")
	kit.Publish(s.kafka, "shipment.created", fmt.Sprint(id), map[string]any{
		"shipment_id": id, "order_id": orderID, "at": time.Now().UTC().Format(time.RFC3339),
	})
	log.Info("expédition créée", "shipment_id", id, "order_id", orderID)
}

func (s *server) recordEvent(ctx context.Context, shipmentID int64, status, description, location, source string) {
	_, _ = s.db.Exec(ctx, `
		INSERT INTO tracking_events (shipment_id, status, description, location, source)
		VALUES ($1,$2,$3,$4,$5)`, shipmentID, status, description, location, source)
	_, _ = s.db.Exec(ctx, `UPDATE shipments SET status = $2, updated_at = now() WHERE id = $1`, shipmentID, status)
}

/* ---------- Lecture ---------- */

func (s *server) listShipments(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(kit.EnvOr(q.Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(q.Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}
	where := "WHERE 1=1"
	args := []any{}
	if st := q.Get("status"); st != "" {
		where += " AND status = $1"
		args = append(args, st)
	}
	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM shipments "+where, args...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT id, order_id, carrier, tracking_number, status, dest_country, dest_city, created_at
		FROM shipments `+where+` ORDER BY id DESC
		LIMIT `+strconv.Itoa(pageSize)+` OFFSET `+strconv.Itoa((page-1)*pageSize), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, orderID int64
		var carrier, status, destCountry, destCity string
		var trackingNumber *string
		var at time.Time
		_ = rows.Scan(&id, &orderID, &carrier, &trackingNumber, &status, &destCountry, &destCity, &at)
		items = append(items, map[string]any{
			"id": id, "order_id": orderID, "carrier": carrier, "tracking_number": trackingNumber,
			"status": status, "dest_country": destCountry, "dest_city": destCity,
			"created_at": at.UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

// createManualShipment — saisie manuelle d'un numéro de suivi côté
// admin/représentant (transporteur autre que DHL, ou création a posteriori),
// distincte de dhlCreateShipment qui appelle l'API DHL en direct. Upsert sur
// order_id : un ordre n'a qu'une expédition active à la fois.
func (s *server) createManualShipment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OrderID        int64  `json:"order_id"`
		TrackingNumber string `json:"tracking_number"`
		Carrier        string `json:"carrier"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.OrderID == 0 || body.TrackingNumber == "" {
		kit.Fail(w, 400, "missing_fields", "order_id et tracking_number sont obligatoires")
		return
	}
	if body.Carrier == "" {
		body.Carrier = "dhl"
	}

	var id int64
	err := s.db.QueryRow(r.Context(), `
		INSERT INTO shipments (order_id, carrier, tracking_number, status)
		VALUES ($1, $2, $3, 'in_transit')
		ON CONFLICT (tracking_number) DO UPDATE SET carrier = $2
		RETURNING id`,
		body.OrderID, body.Carrier, body.TrackingNumber,
	).Scan(&id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	s.recordEvent(r.Context(), id, "in_transit", "Numéro de suivi ajouté manuellement", "", "manual")
	kit.JSON(w, 201, map[string]any{"id": id, "order_id": body.OrderID, "tracking_number": body.TrackingNumber})
}

func (s *server) getShipmentByOrder(w http.ResponseWriter, r *http.Request) {
	orderID, err := strconv.ParseInt(r.PathValue("order_id"), 10, 64)
	if err != nil {
		kit.Fail(w, 400, "invalid_order_id", "order_id invalide")
		return
	}
	s.writeShipmentWithEvents(w, r, "order_id", orderID)
}

func (s *server) trackByNumber(w http.ResponseWriter, r *http.Request) {
	s.writeShipmentWithEvents(w, r, "tracking_number", r.PathValue("number"))
}

func (s *server) writeShipmentWithEvents(w http.ResponseWriter, r *http.Request, col string, val any) {
	row := s.db.QueryRow(r.Context(), `
		SELECT id, order_id, carrier, tracking_number, label_url, status,
		       origin_country, origin_city, dest_country, dest_city, created_at, updated_at
		FROM shipments WHERE `+col+` = $1`, val)
	var id, orderID int64
	var carrier, labelURL, status, oCountry, oCity, dCountry, dCity string
	var trackingNumber *string
	var createdAt, updatedAt time.Time
	if err := row.Scan(&id, &orderID, &carrier, &trackingNumber, &labelURL, &status,
		&oCountry, &oCity, &dCountry, &dCity, &createdAt, &updatedAt); err != nil {
		kit.Fail(w, 404, "shipment_not_found", "expédition introuvable")
		return
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT status, description, location, occurred_at, source
		FROM tracking_events WHERE shipment_id = $1 ORDER BY occurred_at ASC`, id)
	events := []map[string]any{}
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var st, desc, loc, src string
			var at time.Time
			_ = rows.Scan(&st, &desc, &loc, &at, &src)
			events = append(events, map[string]any{
				"status": st, "description": desc, "location": loc,
				"occurred_at": at.UTC().Format(time.RFC3339), "source": src,
			})
		}
	}
	kit.JSON(w, 200, map[string]any{
		"id": id, "order_id": orderID, "carrier": carrier, "tracking_number": trackingNumber,
		"label_url": labelURL, "status": status,
		"origin":      map[string]string{"country": oCountry, "city": oCity},
		"destination": map[string]string{"country": dCountry, "city": dCity},
		"created_at":  createdAt.UTC().Format(time.RFC3339),
		"updated_at":  updatedAt.UTC().Format(time.RFC3339),
		"events":      events,
	})
}

func (s *server) addManualEvent(w http.ResponseWriter, r *http.Request) {
	shipmentID, err := strconv.ParseInt(r.PathValue("shipment_id"), 10, 64)
	if err != nil {
		kit.Fail(w, 400, "invalid_shipment_id", "shipment_id invalide")
		return
	}
	var body struct {
		Status      string `json:"status"`
		Description string `json:"description"`
		Location    string `json:"location"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if !shipmentStages[body.Status] {
		kit.Fail(w, 400, "invalid_status", fmt.Sprintf("status %q inconnu — valeurs valides : %v", body.Status, stageNames()))
		return
	}
	s.recordEvent(r.Context(), shipmentID, body.Status, body.Description, body.Location, "manual")
	kit.Publish(s.kafka, "shipment.status_changed", fmt.Sprint(shipmentID), map[string]any{
		"shipment_id": shipmentID, "status": body.Status, "at": time.Now().UTC().Format(time.RFC3339),
	})
	kit.JSON(w, 200, map[string]any{"shipment_id": shipmentID, "status": body.Status})
}

func stageNames() []string {
	names := make([]string, 0, len(shipmentStages))
	for k := range shipmentStages {
		names = append(names, k)
	}
	return names
}

/* ---------- DHL Express (MyDHL API) ----------
   Portée volontairement réduite par rapport aux 5500 lignes du PHP
   legacy (integration-dhl.php) : les 3 opérations essentielles
   (devis, création d'expédition, suivi), avec les règles critiques
   listées dans le brief de migration :
   - retry sur erreur DHL 996 (service temporairement indisponible)
   - priorité d'extraction du prix par devise : BILLC > WEB > BASEC
   Le filtrage des services premium et le regroupement multi-vendeur
   par (pays, ville) d'origine NE SONT PAS encore portés ici — à
   traiter au cas par cas selon les besoins réels du catalogue DHL
   utilisé, pas en spéculant sur des règles non vérifiables sans accès
   au PHP original. */

/* ---------- Dashboard Logistique DHL : liste, détail, création tout-en-un ---------- */

type dhlOrderLine struct {
	ProductID   int64   `json:"product_id"`
	VariationID int64   `json:"variation_id"`
	VendorID    int64   `json:"vendor_id"`
	Name        string  `json:"name"`
	Quantity    int     `json:"quantity"`
	UnitPrice   float64 `json:"unit_price_usd"`
}

type dhlOrderView struct {
	ID              int64          `json:"id"`
	Reference       string         `json:"reference"`
	Status          string         `json:"status"`
	CustomerID      int64          `json:"customer_id"`
	VendorID        int64          `json:"vendor_id"`
	TotalUSD        float64        `json:"total_usd"`
	Lines           []dhlOrderLine `json:"lines"`
	ShippingAddress map[string]any `json:"shipping_address"`
	CreatedAt       string         `json:"created_at"`
}

func (s *server) fetchOrder(ctx context.Context, orderID int64) (*dhlOrderView, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/orders/%d", s.orderURL, orderID), nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("order-svc a répondu %d", resp.StatusCode)
	}
	var raw struct {
		ID              int64           `json:"id"`
		Reference       string          `json:"reference"`
		Status          string          `json:"status"`
		CustomerID      int64           `json:"customer_id"`
		VendorID        int64           `json:"vendor_id"`
		TotalUSD        float64         `json:"total_usd"`
		Lines           json.RawMessage `json:"lines"`
		ShippingAddress json.RawMessage `json:"shipping_address"`
		CreatedAt       string          `json:"created_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	out := &dhlOrderView{
		ID: raw.ID, Reference: raw.Reference, Status: raw.Status,
		CustomerID: raw.CustomerID, VendorID: raw.VendorID, TotalUSD: raw.TotalUSD,
		CreatedAt: raw.CreatedAt,
	}
	_ = json.Unmarshal(raw.Lines, &out.Lines)
	if len(raw.ShippingAddress) > 0 {
		_ = json.Unmarshal(raw.ShippingAddress, &out.ShippingAddress)
	}
	return out, nil
}

// listOrdersForDHL — liste paginée directement depuis order-svc, filtrée
// par statut candidat à l'expédition (équivalent du wc_get_orders(status=
// processing/on-hold/completed/shipped) du plugin WordPress).
func (s *server) listOrdersForDHL(ctx context.Context, limit int, statuses []string) ([]dhlOrderView, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/orders?page_size=%d", s.orderURL, limit), nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("order-svc a répondu %d", resp.StatusCode)
	}
	var body struct {
		Items []struct {
			ID              int64           `json:"id"`
			Reference       string          `json:"reference"`
			Status          string          `json:"status"`
			CustomerID      int64           `json:"customer_id"`
			VendorID        int64           `json:"vendor_id"`
			TotalUSD        float64         `json:"total_usd"`
			ShippingAddress json.RawMessage `json:"shipping_address"`
			CreatedAt       string          `json:"created_at"`
		} `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	wanted := map[string]bool{}
	for _, st := range statuses {
		wanted[st] = true
	}
	out := []dhlOrderView{}
	for _, it := range body.Items {
		if it.VendorID == 0 { // ligne "group" (parent) — pas une vraie sous-commande à expédier
			continue
		}
		if len(wanted) > 0 && !wanted[it.Status] {
			continue
		}
		v := dhlOrderView{
			ID: it.ID, Reference: it.Reference, Status: it.Status,
			CustomerID: it.CustomerID, VendorID: it.VendorID, TotalUSD: it.TotalUSD,
			CreatedAt: it.CreatedAt,
		}
		if len(it.ShippingAddress) > 0 {
			_ = json.Unmarshal(it.ShippingAddress, &v.ShippingAddress)
		}
		out = append(out, v)
	}
	return out, nil
}

func shipAddrStr(addr map[string]any, key string) string {
	if addr == nil {
		return ""
	}
	if v, ok := addr[key].(string); ok {
		return v
	}
	return ""
}

func fullNameFromAddr(addr map[string]any) string {
	first := shipAddrStr(addr, "first_name")
	last := shipAddrStr(addr, "last_name")
	name := strings.TrimSpace(first + " " + last)
	if name == "" {
		return shipAddrStr(addr, "full_name")
	}
	return name
}

// dhlListOrders — GET /dhl/orders?limit=&status=processing,paid
func (s *server) dhlListOrders(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 40
	if v, err := strconv.Atoi(q.Get("limit")); err == nil && v > 0 && v <= 100 {
		limit = v
	}
	statuses := []string{"processing", "paid", "shipped"}
	if v := q.Get("status"); v != "" {
		statuses = strings.Split(v, ",")
	}
	orders, err := s.listOrdersForDHL(r.Context(), limit, statuses)
	if err != nil {
		kit.Fail(w, 502, "order_svc_unreachable", err.Error())
		return
	}

	// Numéro de suivi déjà attribué (une seule requête groupée plutôt qu'un
	// aller-retour par commande).
	trackingByOrder := map[int64]string{}
	rows, err := s.db.Query(r.Context(), "SELECT order_id, tracking_number FROM shipments WHERE order_id = ANY($1)",
		orderIDs(orders))
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var oid int64
			var tn *string
			if rows.Scan(&oid, &tn) == nil && tn != nil {
				trackingByOrder[oid] = *tn
			}
		}
	}

	out := make([]map[string]any, 0, len(orders))
	for _, o := range orders {
		tracking := trackingByOrder[o.ID]
		out = append(out, map[string]any{
			"id":              o.ID,
			"order_number":    o.Reference,
			"date":            o.CreatedAt,
			"client_name":     fullNameFromAddr(o.ShippingAddress),
			"country":         shipAddrStr(o.ShippingAddress, "country"),
			"city":            shipAddrStr(o.ShippingAddress, "city"),
			"total":           strconv.FormatFloat(o.TotalUSD, 'f', 2, 64),
			"status":          o.Status,
			"tracking_number": tracking,
			"has_shipment":    tracking != "",
		})
	}
	kit.JSON(w, 200, map[string]any{"ok": true, "orders": out})
}

func orderIDs(orders []dhlOrderView) []int64 {
	ids := make([]int64, len(orders))
	for i, o := range orders {
		ids[i] = o.ID
	}
	return ids
}

// productInfo — poids/HS/pays d'origine résolus depuis catalog-svc pour
// une ligne de commande (le prix/nom viennent déjà de la ligne elle-même).
type productInfo struct {
	WeightKg      float64
	HSCode        string
	OriginCountry string
}

func (s *server) fetchProductInfo(ctx context.Context, productID int64) productInfo {
	out := productInfo{WeightKg: 0.5, HSCode: "85444290", OriginCountry: "CN"}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/products/%d", s.catalogURL, productID), nil)
	if err != nil {
		return out
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return out
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return out
	}
	var p struct {
		WeightKg      *float64 `json:"weight_kg"`
		HSCode        string   `json:"hs_code"`
		OriginCountry string   `json:"origin_country"`
	}
	if json.NewDecoder(resp.Body).Decode(&p) != nil {
		return out
	}
	if p.WeightKg != nil && *p.WeightKg > 0 {
		out.WeightKg = *p.WeightKg
	}
	if p.HSCode != "" {
		out.HSCode = p.HSCode
	}
	if p.OriginCountry != "" {
		out.OriginCountry = p.OriginCountry
	}
	return out
}

type vendorInfo struct {
	Name    string
	Country string
	City    string
	Address string
	Phone   string
}

func (s *server) fetchVendor(ctx context.Context, vendorID int64) *vendorInfo {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/vendor/%d", s.vendorURL, vendorID), nil)
	if err != nil {
		return nil
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil
	}
	var v struct {
		Name    string `json:"name"`
		Country string `json:"country"`
		City    string `json:"city"`
		Address string `json:"address"`
		Phone   string `json:"phone"`
	}
	if json.NewDecoder(resp.Body).Decode(&v) != nil {
		return nil
	}
	return &vendorInfo{Name: v.Name, Country: v.Country, City: v.City, Address: v.Address, Phone: v.Phone}
}

// dhlOrderDetail — GET /dhl/order/{id} : adresse, articles, poids total,
// code HS, expédition existante, tracking live, tarif estimé (best-effort).
func (s *server) dhlOrderDetail(w http.ResponseWriter, r *http.Request) {
	orderID := atoi64(r.PathValue("id"))
	order, err := s.fetchOrder(r.Context(), orderID)
	if err != nil {
		kit.Fail(w, 404, "order_not_found", "commande introuvable : "+err.Error())
		return
	}

	items := []map[string]any{}
	totalWeight := 0.0
	hsCode := ""
	for _, l := range order.Lines {
		info := s.fetchProductInfo(r.Context(), l.ProductID)
		weight := info.WeightKg * float64(l.Quantity)
		totalWeight += weight
		if hsCode == "" {
			hsCode = info.HSCode
		}
		items = append(items, map[string]any{
			"name": l.Name, "quantity": l.Quantity, "weight": weight, "price": l.UnitPrice,
		})
	}
	if hsCode == "" {
		hsCode = "85444290"
	}
	if totalWeight <= 0 {
		totalWeight = 1
	}

	var trackingNumber, labelURL string
	var shipmentID int64
	_ = s.db.QueryRow(r.Context(),
		"SELECT id, tracking_number, label_url FROM shipments WHERE order_id = $1", orderID,
	).Scan(&shipmentID, &trackingNumber, &labelURL)

	var dhlStatus string
	dhlEvents := []map[string]any{}
	if trackingNumber != "" {
		rows, err := s.db.Query(r.Context(),
			"SELECT status, description, location, occurred_at FROM tracking_events WHERE shipment_id = $1 ORDER BY occurred_at", shipmentID)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var st, desc, loc string
				var at time.Time
				if rows.Scan(&st, &desc, &loc, &at) == nil {
					dhlStatus = st
					dhlEvents = append(dhlEvents, map[string]any{
						"timestamp": at.UTC().Format(time.RFC3339), "description": desc, "location": loc,
					})
				}
			}
		}
	}

	// Tarif estimé best-effort — uniquement si pas encore expédié, jamais
	// bloquant pour le reste de la réponse (voir dhlRate : peut échouer si
	// la ville de destination manque, credentials absents, DHL indisponible).
	var estimatedRate map[string]any
	if trackingNumber == "" && s.dhlUsername != "" && s.dhlPassword != "" {
		destCountry := shipAddrStr(order.ShippingAddress, "country")
		destCity := shipAddrStr(order.ShippingAddress, "city")
		if destCountry != "" && destCity != "" {
			if body, err := s.dhlRequestWithRetry(r.Context(), http.MethodGet, "/rates?"+
				fmt.Sprintf("accountNumber=%s&originCountryCode=%s&originCityName=%s&destinationCountryCode=%s&destinationCityName=%s&weight=%s&length=20&width=20&height=20&plannedShippingDate=%s&isCustomsDeclarable=true&unitOfMeasurement=metric",
					s.dhlAccount, s.shipperCountry, s.shipperCity, destCountry, destCity,
					strconv.FormatFloat(totalWeight, 'f', -1, 64), nextShippingDate()), nil); err == nil {
				var parsed map[string]any
				if json.Unmarshal(body, &parsed) == nil {
					price, currency := extractDHLPrice(parsed)
					if price > 0 {
						estimatedRate = map[string]any{"cost": price, "currency": currency}
					}
				}
			}
		}
	}

	kit.JSON(w, 200, map[string]any{
		"ok": true, "id": order.ID, "order_number": order.Reference, "status": order.Status,
		"date":        order.CreatedAt,
		"client_name": fullNameFromAddr(order.ShippingAddress), "client_email": shipAddrStr(order.ShippingAddress, "email"),
		"client_phone": shipAddrStr(order.ShippingAddress, "phone"),
		"address": map[string]any{
			"address_1": shipAddrStr(order.ShippingAddress, "address_1"),
			"city":      shipAddrStr(order.ShippingAddress, "city"),
			"postcode":  shipAddrStr(order.ShippingAddress, "postcode"),
			"country":   shipAddrStr(order.ShippingAddress, "country"),
		},
		"total": strconv.FormatFloat(order.TotalUSD, 'f', 2, 64),
		"items": items, "total_weight": totalWeight, "hs_code": hsCode,
		"tracking_number": trackingNumber, "label_url": labelURL,
		"dhl_status": dhlStatus, "dhl_events": dhlEvents,
		"estimated_rate": estimatedRate,
	})
}

// nextShippingDate — reproduit la règle du plugin WordPress : le lendemain,
// sauf weekend (décalé au lundi) ou vendredi après 17h (décalé au lundi+2j
// pour laisser une vraie marge). Fuseau UTC (le VPS tourne en UTC).
func nextShippingDate() string {
	now := time.Now().UTC()
	switch now.Weekday() {
	case time.Saturday:
		now = now.AddDate(0, 0, 2)
	case time.Sunday:
		now = now.AddDate(0, 0, 1)
	case time.Friday:
		if now.Hour() >= 17 {
			now = now.AddDate(0, 0, 3)
		} else {
			now = now.AddDate(0, 0, 1)
		}
	default:
		now = now.AddDate(0, 0, 1)
	}
	return now.Format("2006-01-02")
}

func atoi64(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

// dhlBuildAndCreateShipment — POST /dhl/orders/{id}/create-shipment
// Construit le payload MyDHL complet (expéditeur = boutique vendeur si
// connue sinon expéditeur par défaut, destinataire = adresse de livraison
// de la commande, articles avec code HS/poids/pays d'origine) puis appelle
// DHL — équivalent Go de miad_dhl_create_shipment_api() (plugin WordPress).
// body optionnel : { weight, length, width, height, hs_code } pour corriger
// manuellement avant envoi (même logique "override" que le PHP).
func (s *server) dhlBuildAndCreateShipment(w http.ResponseWriter, r *http.Request) {
	if s.dhlUsername == "" || s.dhlPassword == "" {
		kit.Fail(w, 503, "dhl_not_configured", "DHL_API_USERNAME / DHL_API_PASSWORD absents")
		return
	}
	orderID := atoi64(r.PathValue("id"))
	var override struct {
		Weight *float64 `json:"weight"`
		Length *float64 `json:"length"`
		Width  *float64 `json:"width"`
		Height *float64 `json:"height"`
		HSCode string   `json:"hs_code"`
	}
	_ = json.NewDecoder(r.Body).Decode(&override) // corps optionnel

	order, err := s.fetchOrder(r.Context(), orderID)
	if err != nil {
		kit.Fail(w, 404, "order_not_found", "commande introuvable : "+err.Error())
		return
	}
	if len(order.Lines) == 0 {
		kit.Fail(w, 400, "empty_order", "commande sans article — impossible de construire l'expédition")
		return
	}

	// --- Expéditeur : boutique du vendeur si connue, sinon config par défaut ---
	shipperCountry, shipperCity, shipperAddr, shipperName, shipperPhone :=
		s.shipperCountry, s.shipperCity, "Adresse par défaut", "MIAD Market", "123456789"
	if vendor := s.fetchVendor(r.Context(), order.VendorID); vendor != nil {
		if vendor.Country != "" {
			shipperCountry = vendor.Country
		}
		if vendor.City != "" {
			shipperCity = vendor.City
		}
		if vendor.Address != "" {
			shipperAddr = vendor.Address
		}
		if vendor.Name != "" {
			shipperName = vendor.Name
		}
		if vendor.Phone != "" {
			shipperPhone = vendor.Phone
		}
	}

	// --- Destinataire : adresse de livraison de la commande ---
	destCountry := shipAddrStr(order.ShippingAddress, "country")
	destCity := shipAddrStr(order.ShippingAddress, "city")
	if destCountry == "" || destCity == "" {
		kit.Fail(w, 400, "missing_address", "adresse de livraison incomplète (pays/ville) sur cette commande")
		return
	}

	// --- Articles : poids/HS/origine résolus depuis catalog-svc ---
	totalWeight, totalValue := 0.0, 0.0
	lineItems := []map[string]any{}
	firstHSCode := ""
	for i, l := range order.Lines {
		info := s.fetchProductInfo(r.Context(), l.ProductID)
		weight := info.WeightKg * float64(l.Quantity)
		totalWeight += weight
		totalValue += l.UnitPrice * float64(l.Quantity)
		hsCode := info.HSCode
		if override.HSCode != "" {
			hsCode = override.HSCode
		}
		if firstHSCode == "" {
			firstHSCode = hsCode
		}
		desc := l.Name
		if len(desc) > 35 {
			desc = desc[:35]
		}
		lineItems = append(lineItems, map[string]any{
			"number": i + 1, "description": desc, "price": round2(l.UnitPrice),
			"quantity":            map[string]any{"value": l.Quantity, "unitOfMeasurement": "PCS"},
			"commodityCodes":      []map[string]any{{"typeCode": "outbound", "value": hsCode}},
			"exportReasonType":    "permanent",
			"manufacturerCountry": info.OriginCountry,
			"weight":              map[string]any{"netValue": round3(info.WeightKg), "grossValue": round3(info.WeightKg)},
		})
	}
	if totalWeight <= 0 {
		totalWeight = 1
	}
	pkgLength, pkgWidth, pkgHeight := 20.0, 20.0, 20.0
	if override.Weight != nil && *override.Weight > 0 {
		totalWeight = *override.Weight
	}
	if override.Length != nil && *override.Length > 0 {
		pkgLength = *override.Length
	}
	if override.Width != nil && *override.Width > 0 {
		pkgWidth = *override.Width
	}
	if override.Height != nil && *override.Height > 0 {
		pkgHeight = *override.Height
	}

	accounts := []map[string]any{
		{"typeCode": "shipper", "number": s.dhlAccount},
		{"typeCode": "payer", "number": s.dhlAccount},
	}
	if s.dhlIncoterm == "DDP" {
		accounts = append(accounts, map[string]any{"typeCode": "duties-taxes", "number": s.dhlAccount})
	}

	contentsDesc := []string{}
	for _, l := range order.Lines {
		contentsDesc = append(contentsDesc, fmt.Sprintf("%s (x%d)", l.Name, l.Quantity))
	}
	description := strings.Join(contentsDesc, ", ")
	if len(description) > 70 {
		description = description[:70]
	}

	payload := map[string]any{
		"plannedShippingDateAndTime": nextShippingDate() + "T10:00:00 GMT+00:00",
		"pickup":                     map[string]any{"isRequested": false},
		"productCode":                "P",
		"accounts":                   accounts,
		"customerDetails": map[string]any{
			"shipperDetails": map[string]any{
				"postalAddress": map[string]any{
					"postalCode": s.shipperZip, "cityName": shipperCity,
					"countryCode": shipperCountry, "addressLine1": shipperAddr,
				},
				"contactInformation": map[string]any{
					"companyName": shipperName, "fullName": shipperName, "phone": onlyDigits(shipperPhone),
				},
			},
			"receiverDetails": map[string]any{
				"postalAddress": map[string]any{
					"postalCode": shipAddrStr(order.ShippingAddress, "postcode"), "cityName": destCity,
					"countryCode": destCountry, "addressLine1": shipAddrStr(order.ShippingAddress, "address_1"),
				},
				"contactInformation": map[string]any{
					"companyName": fullNameFromAddr(order.ShippingAddress), "fullName": fullNameFromAddr(order.ShippingAddress),
					"phone": onlyDigits(shipAddrStr(order.ShippingAddress, "phone")), "email": shipAddrStr(order.ShippingAddress, "email"),
				},
			},
		},
		"content": map[string]any{
			"packages": []map[string]any{
				{"weight": totalWeight, "dimensions": map[string]any{"length": pkgLength, "width": pkgWidth, "height": pkgHeight}},
			},
			"isCustomsDeclarable":   true,
			"declaredValue":         round2(totalValue),
			"declaredValueCurrency": "USD",
			"exportDeclaration":     map[string]any{"lineItems": lineItems},
			"description":           description,
			"incoterm":              s.dhlIncoterm,
			"unitOfMeasurement":     "metric",
		},
		"outputImageProperties": map[string]any{
			"imageOptions": []map[string]any{
				{"typeCode": "label", "templateName": "ECOM26_84_001"},
				{"typeCode": "waybillDoc", "isRequested": true},
				{"typeCode": "invoice", "templateName": "COMMERCIAL_INVOICE_P_10", "invoiceType": "commercial"},
			},
		},
	}
	payloadJSON, _ := json.Marshal(payload)

	body, err := s.dhlRequestWithRetry(r.Context(), http.MethodPost, "/shipments", payloadJSON)
	if err != nil {
		s.recordShipmentFailure(r.Context(), orderID, err.Error())
		kit.Fail(w, 502, "dhl_unreachable", err.Error())
		return
	}
	var parsed struct {
		ShipmentTrackingNumber string `json:"shipmentTrackingNumber"`
		Documents              []struct {
			Content  string `json:"content"`
			TypeCode string `json:"typeCode"`
		} `json:"documents"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.ShipmentTrackingNumber == "" {
		msg := fmt.Sprintf("réponse DHL inattendue : %s", string(body))
		s.recordShipmentFailure(r.Context(), orderID, msg)
		kit.Fail(w, 502, "dhl_response_unparseable", msg)
		return
	}

	// label/waybill/invoice restent en base64 tel que reçu de DHL — l'upload
	// vers MinIO (équivalent du wp_upload_dir() PHP) est un chantier séparé,
	// signalé explicitement plutôt que silencieusement omis.
	var labelB64, waybillB64, invoiceB64 string
	for _, doc := range parsed.Documents {
		switch doc.TypeCode {
		case "label":
			labelB64 = doc.Content
		case "waybillDoc":
			waybillB64 = doc.Content
		case "invoice":
			invoiceB64 = doc.Content
		}
	}

	var shipmentID int64
	err = s.db.QueryRow(r.Context(), `
		INSERT INTO shipments (order_id, carrier, tracking_number, status, origin_country, origin_city, dest_country, dest_city)
		VALUES ($1,'dhl',$2,'label_created',$3,$4,$5,$6)
		ON CONFLICT (tracking_number) DO UPDATE SET status = 'label_created'
		RETURNING id`,
		orderID, parsed.ShipmentTrackingNumber, shipperCountry, shipperCity, destCountry, destCity,
	).Scan(&shipmentID)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	s.recordEvent(r.Context(), shipmentID, "label_created",
		"Expédition DHL créée. Tracking: "+parsed.ShipmentTrackingNumber, "", "dhl_api")
	kit.Publish(s.kafka, "shipment.status_changed", fmt.Sprint(shipmentID), map[string]any{
		"shipment_id": shipmentID, "order_id": orderID, "status": "label_created",
		"tracking_number": parsed.ShipmentTrackingNumber, "at": time.Now().UTC().Format(time.RFC3339),
	})

	kit.JSON(w, 200, map[string]any{
		"success": true, "shipment_id": shipmentID,
		"tracking_number":     parsed.ShipmentTrackingNumber,
		"message":             "Expédition créée avec succès ! Tracking: " + parsed.ShipmentTrackingNumber,
		"label_data_base64":   labelB64,
		"waybill_data_base64": waybillB64,
		"invoice_data_base64": invoiceB64,
	})
}

func (s *server) recordShipmentFailure(ctx context.Context, orderID int64, reason string) {
	var shipmentID int64
	err := s.db.QueryRow(ctx, "SELECT id FROM shipments WHERE order_id = $1", orderID).Scan(&shipmentID)
	if err != nil {
		return // pas d'expédition en cours pour cette commande — rien à journaliser
	}
	s.recordEvent(ctx, shipmentID, "pending_label", "Échec de la création d'expédition DHL : "+reason, "", "manual")
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }
func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

func onlyDigits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "123456789"
	}
	return b.String()
}

func (s *server) dhlAuthHeader(req *http.Request) {
	token := base64.StdEncoding.EncodeToString([]byte(s.dhlUsername + ":" + s.dhlPassword))
	req.Header.Set("Authorization", "Basic "+token)
}

// dhlRate — GET /dhl/rate?origin_country=SN&origin_city=Dakar&dest_country=FR&dest_city=Paris&weight_kg=2
func (s *server) dhlRate(w http.ResponseWriter, r *http.Request) {
	if s.dhlUsername == "" || s.dhlPassword == "" {
		kit.Fail(w, 503, "dhl_not_configured", "DHL_API_USERNAME / DHL_API_PASSWORD absents")
		return
	}
	q := r.URL.Query()
	required := []string{"origin_country", "origin_city", "dest_country", "dest_city", "weight_kg"}
	for _, k := range required {
		if q.Get(k) == "" {
			kit.Fail(w, 400, "missing_param", fmt.Sprintf("paramètre %s obligatoire", k))
			return
		}
	}
	body, err := s.dhlRequestWithRetry(r.Context(), http.MethodGet, "/rates?"+
		fmt.Sprintf("accountNumber=%s&originCountryCode=%s&originCityName=%s&destinationCountryCode=%s&destinationCityName=%s&weight=%s&length=10&width=10&height=10&plannedShippingDate=%s&isCustomsDeclarable=true&unitOfMeasurement=metric",
			kit.Env("DHL_ACCOUNT_NUMBER", ""), q.Get("origin_country"), q.Get("origin_city"),
			q.Get("dest_country"), q.Get("dest_city"), q.Get("weight_kg"),
			time.Now().Format("2006-01-02")), nil)
	if err != nil {
		kit.Fail(w, 502, "dhl_unreachable", err.Error())
		return
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		kit.Fail(w, 502, "dhl_response_unparseable", err.Error())
		return
	}
	price, currency := extractDHLPrice(parsed)
	kit.JSON(w, 200, map[string]any{
		"price": price, "currency": currency, "raw": json.RawMessage(body),
	})
}

// extractDHLPrice — priorité BILLC > WEB > BASEC (règle du brief de
// migration : la même expédition DHL peut renvoyer plusieurs types de
// prix selon le contrat, celui-ci est l'ordre de confiance attendu).
func extractDHLPrice(resp map[string]any) (float64, string) {
	products, _ := resp["products"].([]any)
	priority := []string{"BILLC", "WEB", "BASEC"}
	for _, want := range priority {
		for _, p := range products {
			prod, _ := p.(map[string]any)
			details, _ := prod["totalPrice"].([]any)
			for _, d := range details {
				dm, _ := d.(map[string]any)
				if dm["priceType"] == want {
					price, _ := dm["price"].(float64)
					currency, _ := dm["priceCurrency"].(string)
					return price, currency
				}
			}
		}
	}
	return 0, ""
}

func (s *server) dhlCreateShipment(w http.ResponseWriter, r *http.Request) {
	if s.dhlUsername == "" || s.dhlPassword == "" {
		kit.Fail(w, 503, "dhl_not_configured", "DHL_API_USERNAME / DHL_API_PASSWORD absents")
		return
	}
	var reqBody struct {
		ShipmentID int64           `json:"shipment_id"`
		Payload    json.RawMessage `json:"dhl_payload"` // corps MyDHL API tel quel — trop de champs pour les typer un par un ici
	}
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if reqBody.ShipmentID == 0 || len(reqBody.Payload) == 0 {
		kit.Fail(w, 400, "missing_fields", "shipment_id et dhl_payload obligatoires")
		return
	}
	body, err := s.dhlRequestWithRetry(r.Context(), http.MethodPost, "/shipments", reqBody.Payload)
	if err != nil {
		kit.Fail(w, 502, "dhl_unreachable", err.Error())
		return
	}
	var parsed struct {
		ShipmentTrackingNumber string `json:"shipmentTrackingNumber"`
		Documents              []struct {
			Content  string `json:"content"` // label PDF en base64 — upload R2/MinIO à câbler séparément
			TypeCode string `json:"typeCode"`
		} `json:"documents"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.ShipmentTrackingNumber == "" {
		kit.Fail(w, 502, "dhl_response_unparseable", fmt.Sprintf("réponse DHL inattendue : %s", string(body)))
		return
	}
	if _, err := s.db.Exec(r.Context(), `
		UPDATE shipments SET tracking_number = $2, status = 'label_created', updated_at = now()
		WHERE id = $1`, reqBody.ShipmentID, parsed.ShipmentTrackingNumber); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	s.recordEvent(r.Context(), reqBody.ShipmentID, "label_created",
		"label DHL créé, numéro de suivi "+parsed.ShipmentTrackingNumber, "", "dhl_api")
	kit.Publish(s.kafka, "shipment.status_changed", fmt.Sprint(reqBody.ShipmentID), map[string]any{
		"shipment_id": reqBody.ShipmentID, "status": "label_created",
		"tracking_number": parsed.ShipmentTrackingNumber, "at": time.Now().UTC().Format(time.RFC3339),
	})
	kit.JSON(w, 200, map[string]any{
		"shipment_id": reqBody.ShipmentID, "tracking_number": parsed.ShipmentTrackingNumber,
	})
}

func (s *server) dhlRefreshTracking(w http.ResponseWriter, r *http.Request) {
	if s.dhlUsername == "" || s.dhlPassword == "" {
		kit.Fail(w, 503, "dhl_not_configured", "DHL_API_USERNAME / DHL_API_PASSWORD absents")
		return
	}
	trackingNumber := r.PathValue("tracking_number")
	body, err := s.dhlRequestWithRetry(r.Context(), http.MethodGet, "/tracking?shipmentTrackingNumber="+trackingNumber, nil)
	if err != nil {
		kit.Fail(w, 502, "dhl_unreachable", err.Error())
		return
	}
	var parsed struct {
		Shipments []struct {
			Events []struct {
				Date        string `json:"date"`
				Time        string `json:"time"`
				StatusCode  string `json:"statusCode"` // "delivered" | "transit" | ...
				Description string `json:"description"`
				Location    struct {
					Address struct {
						AddressLocality string `json:"addressLocality"`
					} `json:"address"`
				} `json:"location"`
			} `json:"events"`
		} `json:"shipments"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || len(parsed.Shipments) == 0 {
		kit.Fail(w, 502, "dhl_response_unparseable", fmt.Sprintf("réponse DHL inattendue : %s", string(body)))
		return
	}
	var shipmentID int64
	if err := s.db.QueryRow(r.Context(), "SELECT id FROM shipments WHERE tracking_number = $1", trackingNumber).Scan(&shipmentID); err != nil {
		kit.Fail(w, 404, "shipment_not_found", "aucune expédition locale pour ce numéro de suivi")
		return
	}
	inserted := 0
	for _, ev := range parsed.Shipments[0].Events {
		status := mapDHLStatusCode(ev.StatusCode)
		occurredAt, _ := time.Parse("2006-01-02T15:04:05", ev.Date+"T"+ev.Time)
		if occurredAt.IsZero() {
			occurredAt = time.Now().UTC()
		}
		res, err := s.db.Exec(r.Context(), `
			INSERT INTO tracking_events (shipment_id, status, description, location, occurred_at, source)
			SELECT $1,$2,$3,$4,$5,'dhl_api'
			WHERE NOT EXISTS (
				SELECT 1 FROM tracking_events
				WHERE shipment_id=$1 AND status=$2 AND occurred_at=$5
			)`, shipmentID, status, ev.Description, ev.Location.Address.AddressLocality, occurredAt)
		if err == nil && res.RowsAffected() > 0 {
			inserted++
		}
	}
	if inserted > 0 {
		last := parsed.Shipments[0].Events[len(parsed.Shipments[0].Events)-1]
		newStatus := mapDHLStatusCode(last.StatusCode)
		_, _ = s.db.Exec(r.Context(), `UPDATE shipments SET status = $2, updated_at = now() WHERE id = $1`, shipmentID, newStatus)
		kit.Publish(s.kafka, "shipment.status_changed", fmt.Sprint(shipmentID), map[string]any{
			"shipment_id": shipmentID, "status": newStatus, "at": time.Now().UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{"shipment_id": shipmentID, "new_events": inserted})
}

func mapDHLStatusCode(code string) string {
	switch strings.ToLower(code) {
	case "delivered":
		return "delivered"
	case "customs", "customs hold", "clearance":
		return "customs"
	case "transit", "in transit", "departed", "arrived":
		return "in_transit"
	default:
		return "in_transit"
	}
}

// dhlRequestWithRetry — retry sur l'erreur 996 DHL (service temporairement
// indisponible, règle explicite du brief de migration), 3 tentatives.
func (s *server) dhlRequestWithRetry(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		var reqBody io.Reader
		if body != nil {
			reqBody = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, s.dhlBaseURL+path, reqBody)
		if err != nil {
			return nil, err
		}
		s.dhlAuthHeader(req)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Message-Reference", randomMessageRef())

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			lastErr = err
			time.Sleep(time.Duration(attempt) * time.Second)
			continue
		}
		respBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode == 200 || resp.StatusCode == 201 {
			return respBody, nil
		}
		if bytes.Contains(respBody, []byte("996")) {
			lastErr = fmt.Errorf("DHL erreur 996 (service temporairement indisponible) — tentative %d/3", attempt)
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
			continue
		}
		return nil, fmt.Errorf("DHL a répondu %d: %s", resp.StatusCode, string(respBody))
	}
	return nil, fmt.Errorf("DHL injoignable après 3 tentatives: %w", lastErr)
}

func randomMessageRef() string {
	return "miad-" + strconv.FormatInt(time.Now().UnixNano(), 36)
}

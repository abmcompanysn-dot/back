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
	db          *pgxpool.Pool
	kafka       sarama.SyncProducer
	orderURL    string
	dhlBaseURL  string
	dhlUsername string
	dhlPassword string
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
		db:          db,
		kafka:       kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		orderURL:    kit.Env("ORDER_SVC_URL", "http://order-svc:8083"),
		dhlBaseURL:  kit.Env("DHL_API_BASE", "https://express.api.dhl.com/mydhlapi"),
		dhlUsername: kit.Env("DHL_API_USERNAME", ""),
		dhlPassword: kit.Env("DHL_API_PASSWORD", ""),
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
		mux.HandleFunc("GET /shipments/order/{order_id}", s.getShipmentByOrder)
		mux.HandleFunc("POST /tracking/{shipment_id}/event", s.addManualEvent)
		mux.HandleFunc("GET /tracking/search/{number}", s.trackByNumber)

		mux.HandleFunc("GET /dhl/rate", s.dhlRate)
		mux.HandleFunc("POST /dhl/create-shipment", s.dhlCreateShipment)
		mux.HandleFunc("GET /dhl/tracking/{tracking_number}", s.dhlRefreshTracking)
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

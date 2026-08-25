// ============================================================
// Import ponctuel WooCommerce → clients (auth-svc) + commandes
// (order-svc), historique jamais migré par cmd/wc-import (qui ne couvre
// que vendeurs/catégories/produits — voir son TODO explicite).
//
// Ordre : clients d'abord (order.customer_id doit pouvoir référencer un
// client déjà importé), puis commandes.
//
// Usage : go run ./cmd/wc-data-import --wc-url=... --wc-key=... --wc-secret=...
// Variables d'env attendues : DATABASE_URL_AUTH, DATABASE_URL_ORDER,
// DATABASE_URL_VENDOR, DATABASE_URL_CATALOG (résolution vendor_id/product_id).
//
// Idempotent : rejouable sans dupliquer — customers.id est FORCÉ à l'id
// WooCommerce (ON CONFLICT (id) DO UPDATE), orders utilise
// (wc_order_id, vendor_id) comme clé d'unicité (voir order-svc schema).
//
// Décisions validées (2026-08-25, voir conversation) :
//   - Mot de passe : jamais exposé par l'API REST WooCommerce → chaque
//     client importé a customers.must_reset_password = TRUE, aucun accès
//     par mot de passe tant qu'il n'est pas passé par "mot de passe oublié".
//   - Email en double dans wc/v3/customers : le plus ancien (date_created)
//     gagne, les suivants sont journalisés et ignorés (customers.email
//     est UNIQUE côté auth-svc — un doublon planterait l'import sinon).
//   - Commission par ligne : PAS recalculée rétroactivement sur
//     l'historique importé — laissée à zéro (absente côté WooCommerce,
//     mieux vaut un vide explicite qu'un taux inventé après coup).
//   - payment_status/fulfillment_stage : dérivés du statut WooCommerce
//     natif uniquement (pending/processing/on-hold/completed/cancelled/
//     refunded/failed) — PAS des metas _miad_delivery_stage/
//     _miad_domestic_stage (non lues ici : elles vivent dans des tables
//     séparées déjà unifiées côté fulfillment-svc/shipping-svc, hors
//     périmètre de ce script ; la timeline reconstruite reste donc moins
//     précise que celle des commandes créées nativement après le switch).
//
// ============================================================
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/miadmarket/miad-backend/internal/kit"
)

const (
	pageDelay  = 1500 * time.Millisecond // même protection anti-blocage SiteGround que cmd/wc-import
	maxRetries = 4
)

var httpClient = &http.Client{Timeout: 30 * time.Second}

// fetchJSONPaginated — identique à cmd/wc-import (retry/backoff, jamais
// sur 401/403, détection réponse non-JSON = probable blocage WAF).
func fetchJSONPaginated(url string, out any) error {
	defer time.Sleep(pageDelay)

	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt*attempt) * time.Second)
		}
		req, err := http.NewRequest(http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", "MIAD-Go-Migration-Import")
		req.Header.Set("Accept", "application/json")

		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			resp.Body.Close()
			return fmt.Errorf("authentification refusée (%d) — vérifier les clés ou un verrou anti-bot actif, ne pas relancer immédiatement", resp.StatusCode)
		}
		if resp.StatusCode >= 500 {
			resp.Body.Close()
			lastErr = fmt.Errorf("erreur serveur %d", resp.StatusCode)
			continue
		}
		if resp.StatusCode != 200 {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			return fmt.Errorf("statut inattendu %d: %s", resp.StatusCode, string(body))
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		if err := json.Unmarshal(body, out); err != nil {
			lastErr = fmt.Errorf("réponse non-JSON (probable blocage WAF/HTML) : %w", err)
			continue
		}
		return nil
	}
	return fmt.Errorf("échec après %d tentatives: %w", maxRetries, lastErr)
}

var (
	wcURL    = flag.String("wc-url", "", "https://api.miadmarket.com")
	wcKey    = flag.String("wc-key", "", "ck_…")
	wcSecret = flag.String("wc-secret", "", "cs_…")
	dryRun   = flag.Bool("dry-run", false, "n'écrit rien en base, affiche seulement ce qui serait fait")
)

/* ---------- Types WooCommerce ---------- */

type wcCustomer struct {
	ID          int64  `json:"id"`
	Email       string `json:"email"`
	FirstName   string `json:"first_name"`
	LastName    string `json:"last_name"`
	DateCreated string `json:"date_created"`
	Billing     struct {
		Phone    string `json:"phone"`
		Address1 string `json:"address_1"`
		City     string `json:"city"`
		Country  string `json:"country"`
	} `json:"billing"`
	Shipping struct {
		Address1 string `json:"address_1"`
		City     string `json:"city"`
		Country  string `json:"country"`
	} `json:"shipping"`
}

// flexString — WooCommerce sérialise ses montants décimaux en string dans
// la doc officielle et la plupart des réponses observées, mais certaines
// installations (plugins de calcul de taxes/devises tiers, versions REST
// différentes) renvoient un vrai nombre JSON pour le même champ — constaté
// en dry-run réel le 2026-08-25 sur wc/v3/orders.total (panne "réponse
// non-JSON" trompeuse : la vraie cause était un json.Unmarshal strict sur
// string alors que la valeur était un number). Accepte les deux formats.
type flexString string

func (f *flexString) UnmarshalJSON(data []byte) error {
	if len(data) == 0 || string(data) == "null" {
		*f = ""
		return nil
	}
	if data[0] == '"' {
		var s string
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
		*f = flexString(s)
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(data, &n); err != nil {
		return err
	}
	*f = flexString(n.String())
	return nil
}

type wcOrderLineItem struct {
	ProductID   int64      `json:"product_id"`
	VariationID int64      `json:"variation_id"`
	Name        string     `json:"name"`
	Quantity    int        `json:"quantity"`
	Total       flexString `json:"total"` // sous-total HT de la ligne — voir flexString (string ou number selon l'installation)
	MetaData    []struct {
		Key   string `json:"key"`
		Value any    `json:"value"`
	} `json:"meta_data"`
}

// vendorID — lit meta_data._vendor_id (posé par Dokan sur chaque ligne de
// commande), seule source fiable du vendeur pour une ligne donnée (voir
// correspondance de champs fournie).
func (l wcOrderLineItem) vendorWcID() int64 {
	for _, m := range l.MetaData {
		if m.Key == "_vendor_id" {
			switch v := m.Value.(type) {
			case float64:
				return int64(v)
			case string:
				n, _ := strconv.ParseInt(v, 10, 64)
				return n
			}
		}
	}
	return 0
}

type wcOrder struct {
	ID            int64             `json:"id"`
	CustomerID    int64             `json:"customer_id"` // 0 = commande invité (jamais rencontré en pratique, géré quand même)
	Status        string            `json:"status"`
	DateCreated   string            `json:"date_created"`
	DatePaid      string            `json:"date_paid"`
	DateCompleted string            `json:"date_completed"`
	PaymentMethod string            `json:"payment_method"`
	Total         flexString        `json:"total"`
	ShippingTotal flexString        `json:"shipping_total"`
	LineItems     []wcOrderLineItem `json:"line_items"`
	Billing       struct {
		FirstName string `json:"first_name"`
		LastName  string `json:"last_name"`
		Phone     string `json:"phone"`
		Email     string `json:"email"`
		Address1  string `json:"address_1"`
		City      string `json:"city"`
		Country   string `json:"country"`
	} `json:"billing"`
	Shipping struct {
		Address1 string `json:"address_1"`
		City     string `json:"city"`
		Country  string `json:"country"`
		Postcode string `json:"postcode"`
	} `json:"shipping"`
}

/* ---------- payment_status / fulfillment_stage (module Commandes) ---------- */

// wcStatusToStages — même esprit que order-svc.statusToStages (module
// Commandes déjà déployé), mais adapté à l'enum natif WooCommerce
// (pending/processing/on-hold/completed/cancelled/refunded/failed),
// PAS à l'enum interne order-svc (pending_payment/paid/...). On écrit
// directement payment_status/fulfillment_stage, jamais status="pending_payment"
// (qui n'a pas de sens pour une commande déjà soldée depuis longtemps).
func wcStatusToStages(status string) (paymentStatus, fulfillmentStage, legacyStatus string) {
	switch status {
	case "pending":
		return "pending", "pending", "pending_payment"
	case "on-hold":
		return "pending", "pending", "pending_payment"
	case "failed":
		return "failed", "cancelled", "payment_expired"
	case "processing":
		return "paid", "preparing", "processing"
	case "completed":
		return "paid", "delivered", "delivered"
	case "cancelled":
		return "pending", "cancelled", "cancelled"
	case "refunded":
		return "refunded", "cancelled", "refunded"
	default:
		return "pending", "pending", "pending_payment"
	}
}

func parseTime(s string) time.Time {
	if s == "" {
		return time.Now().UTC()
	}
	t, err := time.Parse("2006-01-02T15:04:05", s)
	if err != nil {
		return time.Now().UTC()
	}
	return t
}

func parseFloat(s flexString) float64 {
	f, _ := strconv.ParseFloat(strings.TrimSpace(string(s)), 64)
	return f
}

func main() {
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	if *wcURL == "" || *wcKey == "" || *wcSecret == "" {
		log.Error("flags --wc-url, --wc-key et --wc-secret obligatoires")
		os.Exit(1)
	}
	ctx := context.Background()

	authDB, err := kit.NewPG(ctx, log, os.Getenv("DATABASE_URL_AUTH"))
	if err != nil {
		log.Error("auth db", "err", err)
		os.Exit(1)
	}
	defer authDB.Close()

	orderDB, err := kit.NewPG(ctx, log, os.Getenv("DATABASE_URL_ORDER"))
	if err != nil {
		log.Error("order db", "err", err)
		os.Exit(1)
	}
	defer orderDB.Close()

	vendorDB, err := kit.NewPG(ctx, log, os.Getenv("DATABASE_URL_VENDOR"))
	if err != nil {
		log.Error("vendor db", "err", err)
		os.Exit(1)
	}
	defer vendorDB.Close()

	catalogDB, err := kit.NewPG(ctx, log, os.Getenv("DATABASE_URL_CATALOG"))
	if err != nil {
		log.Error("catalog db", "err", err)
		os.Exit(1)
	}
	defer catalogDB.Close()

	// ---------- Mappings de résolution (lus une fois, en mémoire) ----------
	wcVendorToVendorID, err := loadVendorMap(ctx, vendorDB)
	if err != nil {
		log.Error("chargement mapping vendeurs", "err", err)
		os.Exit(1)
	}
	log.Info("mapping vendeurs chargé", "n", len(wcVendorToVendorID))

	wcProductToWeight, err := loadProductMap(ctx, catalogDB)
	if err != nil {
		log.Error("chargement mapping produits", "err", err)
		os.Exit(1)
	}
	log.Info("mapping produits chargé", "n", len(wcProductToWeight))

	// ---------- 1. Clients (wc/v3/customers) ----------
	log.Info("import des clients…")
	imported, skipped, err := importCustomers(ctx, log, authDB)
	if err != nil {
		log.Error("import clients", "err", err)
		os.Exit(1)
	}
	log.Info("clients importés", "n", imported, "doublons_email_ignorés", skipped)

	// ---------- 2. Commandes (wc/v3/orders, TOUS statuts) ----------
	log.Info("import des commandes…")
	orders, subOrders, unresolvedVendor, err := importOrders(ctx, log, orderDB, wcVendorToVendorID, wcProductToWeight)
	if err != nil {
		log.Error("import commandes", "err", err)
		os.Exit(1)
	}
	log.Info("import terminé",
		"commandes_wc", orders, "sous_commandes_créées", subOrders,
		"lignes_vendor_non_résolu", unresolvedVendor)
}

/* ---------- Clients ---------- */

func fetchCustomers(page int) ([]wcCustomer, error) {
	url := fmt.Sprintf("%s/wp-json/wc/v3/customers?per_page=100&page=%d&orderby=id&order=asc&consumer_key=%s&consumer_secret=%s",
		*wcURL, page, *wcKey, *wcSecret)
	var out []wcCustomer
	return out, fetchJSONPaginated(url, &out)
}

func importCustomers(ctx context.Context, log *slog.Logger, authDB *pgxpool.Pool) (imported, skipped int, err error) {
	seenEmails := map[string]bool{} // doublon email (WooCommerce autorise, auth-svc.customers.email est UNIQUE)
	page := 1
	for {
		batch, err := fetchCustomers(page)
		if err != nil {
			return imported, skipped, fmt.Errorf("page %d: %w", page, err)
		}
		if len(batch) == 0 {
			break
		}
		// Le plus ancien gagne en cas de doublon email — trier par
		// date_created avant de traiter, même si l'API renvoie déjà
		// orderby=id asc (id croissant = date croissante en pratique chez
		// WooCommerce, mais on ne s'y fie pas aveuglément).
		sort.Slice(batch, func(i, j int) bool { return batch[i].DateCreated < batch[j].DateCreated })

		for _, c := range batch {
			email := strings.ToLower(strings.TrimSpace(c.Email))
			if email == "" {
				log.Error("client sans email ignoré", "wc_customer_id", c.ID)
				continue
			}
			if seenEmails[email] {
				log.Info("doublon email ignoré (le plus ancien a déjà été importé)", "wc_customer_id", c.ID, "email", email)
				skipped++
				continue
			}

			fullName := strings.TrimSpace(c.FirstName + " " + c.LastName)
			phone := c.Billing.Phone
			addresses := []map[string]any{}
			if c.Billing.Address1 != "" || c.Billing.City != "" {
				addresses = append(addresses, map[string]any{
					"type": "billing", "address_1": c.Billing.Address1, "city": c.Billing.City, "country": c.Billing.Country,
				})
			}
			if c.Shipping.Address1 != "" || c.Shipping.City != "" {
				addresses = append(addresses, map[string]any{
					"type": "shipping", "address_1": c.Shipping.Address1, "city": c.Shipping.City, "country": c.Shipping.Country,
				})
			}
			addressesJSON, _ := json.Marshal(addresses)

			if *dryRun {
				log.Info("[dry-run] client à importer", "wc_customer_id", c.ID, "email", email)
				seenEmails[email] = true
				imported++
				continue
			}

			// customers.id est FORCÉ à l'id WooCommerce (voir doc-comment en
			// tête de fichier) — nécessaire pour que orders.customer_id
			// importé plus bas reste directement exploitable, sans table de
			// correspondance séparée.
			var phoneArg any
			if phone != "" {
				phoneArg = phone
			}
			_, err := authDB.Exec(ctx, `
				INSERT INTO customers (id, email, phone, full_name, addresses, must_reset_password)
				VALUES ($1,$2,$3,$4,$5,TRUE)
				ON CONFLICT (id) DO UPDATE SET
					email=excluded.email, full_name=excluded.full_name, addresses=excluded.addresses`,
				c.ID, email, phoneArg, fullName, addressesJSON,
			)
			if err != nil {
				// phone est UNIQUE côté auth-svc : deux clients WooCommerce
				// avec le même téléphone (arrive avec les commandes invité
				// partageant un numéro famille) échoueraient ici — journalisé,
				// pas fatal pour le reste de l'import.
				log.Error("insert client échoué", "wc_customer_id", c.ID, "email", email, "err", err)
				continue
			}
			seenEmails[email] = true
			imported++
		}

		if len(batch) < 100 {
			break
		}
		page++
	}

	if !*dryRun && imported > 0 {
		// customers.id vient d'être forcé à des valeurs explicites — la
		// séquence Postgres du BIGSERIAL ne le sait pas et redonnerait un id
		// déjà pris au prochain vrai client inscrit nativement. Resynchronise
		// sur le plus grand id réellement présent en base (pas juste celui
		// importé ici, au cas où des clients natifs existent déjà en //).
		if _, err := authDB.Exec(ctx,
			"SELECT setval(pg_get_serial_sequence('customers','id'), COALESCE((SELECT MAX(id) FROM customers), 1))"); err != nil {
			log.Error("resynchronisation séquence customers.id échouée — À CORRIGER MANUELLEMENT avant toute nouvelle inscription", "err", err)
		}
	}

	return imported, skipped, nil
}

/* ---------- Commandes ---------- */

// fetchOrders — status=completed uniquement (décision validée le
// 2026-08-25) : le dry-run initial (status=any) a révélé qu'environ 40%
// des commandes (created_via=dokan, essentiellement des sous-commandes
// pending/processing jamais finalisées) ont line_items=[] dans la
// réponse wc/v3/orders standard, même avec _fields explicite — le vrai
// contenu semble stocké côté Dokan hors de portée de l'API REST publique.
// Les commandes completed testées ont toutes leurs line_items correctement
// peuplés (avec meta_data._vendor_id par ligne, confirmé en dry-run réel).
func fetchOrders(page int) ([]wcOrder, error) {
	url := fmt.Sprintf("%s/wp-json/wc/v3/orders?status=completed&per_page=50&page=%d&orderby=id&order=asc&consumer_key=%s&consumer_secret=%s",
		*wcURL, page, *wcKey, *wcSecret)
	var out []wcOrder
	return out, fetchJSONPaginated(url, &out)
}

// loadVendorMap — vendors.wc_store_id → vendors.id, déjà peuplé par
// cmd/wc-import (import produits/vendeurs, exécuté séparément avant
// celui-ci).
func loadVendorMap(ctx context.Context, vendorDB *pgxpool.Pool) (map[int64]int64, error) {
	rows, err := vendorDB.Query(ctx, "SELECT wc_store_id, id FROM vendors WHERE wc_store_id IS NOT NULL")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]int64{}
	for rows.Next() {
		var wcID, id int64
		if err := rows.Scan(&wcID, &id); err == nil {
			out[wcID] = id
		}
	}
	return out, nil
}

// loadProductMap — products.wc_id → id interne catalog-svc (lang=fr
// uniquement : les lignes fr/en partagent le même wc_id, un seul id
// interne suffit pour les besoins de cet import qui n'affiche jamais le
// nom du produit dans une langue donnée, seulement la référence).
func loadProductMap(ctx context.Context, catalogDB *pgxpool.Pool) (map[int64]int64, error) {
	rows, err := catalogDB.Query(ctx, "SELECT wc_id, id FROM products WHERE wc_id IS NOT NULL AND lang = 'fr'")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]int64{}
	for rows.Next() {
		var wcID, id int64
		if err := rows.Scan(&wcID, &id); err == nil {
			out[wcID] = id
		}
	}
	return out, nil
}

type orderLine struct {
	ProductID   int64   `json:"product_id"`
	VariationID int64   `json:"variation_id"`
	VendorID    int64   `json:"vendor_id"`
	Name        string  `json:"name"`
	Quantity    int     `json:"quantity"`
	UnitPrice   float64 `json:"unit_price_usd"`
	// Commission jamais recalculée rétroactivement sur l'historique importé
	// (décision validée) — omise du JSON plutôt que forcée à 0, cohérent
	// avec `omitempty` côté order-svc pour les commandes créées nativement
	// (une commission à 0 explicite laisserait croire à un taux réel de 0%).
}

func importOrders(
	ctx context.Context, log *slog.Logger, orderDB *pgxpool.Pool,
	wcVendorToVendorID, wcProductToInternalID map[int64]int64,
) (ordersProcessed, subOrdersCreated, unresolvedVendorLines int, err error) {
	page := 1
	for {
		batch, err := fetchOrders(page)
		if err != nil {
			return ordersProcessed, subOrdersCreated, unresolvedVendorLines, fmt.Errorf("page %d: %w", page, err)
		}
		if len(batch) == 0 {
			break
		}

		for _, o := range batch {
			ordersProcessed++
			paymentStatus, fulfillmentStage, legacyStatus := wcStatusToStages(o.Status)

			// Éclatement par vendeur (module multi-vendeur, même modèle que
			// createOrder dans order-svc) — une commande WooCommerce devient
			// une ou plusieurs sous-commandes selon le nombre de boutiques
			// distinctes dans line_items.
			byVendor := map[int64][]wcOrderLineItem{}
			for _, li := range o.LineItems {
				wcVendorID := li.vendorWcID()
				byVendor[wcVendorID] = append(byVendor[wcVendorID], li)
			}
			if len(byVendor) == 0 {
				// Commande sans ligne exploitable (ex: entièrement composée de
				// frais/coupons sans produit réel) — journalisée, pas
				// silencieusement perdue, mais rien à insérer.
				log.Info("commande sans line_items exploitable, ignorée", "wc_order_id", o.ID)
				continue
			}

			shippingAddrJSON, _ := json.Marshal(map[string]any{
				"first_name": o.Billing.FirstName, "last_name": o.Billing.LastName,
				"phone": o.Billing.Phone, "email": o.Billing.Email,
				"address_1": o.Shipping.Address1, "city": o.Shipping.City,
				"country": o.Shipping.Country, "postcode": o.Shipping.Postcode,
			})
			billingAddrJSON, _ := json.Marshal(map[string]any{
				"first_name": o.Billing.FirstName, "last_name": o.Billing.LastName,
				"phone": o.Billing.Phone, "email": o.Billing.Email,
				"address_1": o.Billing.Address1, "city": o.Billing.City, "country": o.Billing.Country,
			})

			createdAt := parseTime(o.DateCreated)
			seq := 1
			var parentID int64
			hasParent := false

			for wcVendorID, lines := range byVendor {
				vendorID, ok := wcVendorToVendorID[wcVendorID]
				if !ok {
					unresolvedVendorLines += len(lines)
					log.Error("vendeur non résolu pour ces lignes — importées quand même avec vendor_id=0 (à réconcilier manuellement)",
						"wc_order_id", o.ID, "wc_vendor_id", wcVendorID)
					vendorID = 0
				}

				var subtotal float64
				internalLines := make([]orderLine, 0, len(lines))
				for _, li := range lines {
					unitPrice := 0.0
					if li.Quantity > 0 {
						unitPrice = parseFloat(li.Total) / float64(li.Quantity)
					}
					subtotal += parseFloat(li.Total)
					internalLines = append(internalLines, orderLine{
						ProductID:   wcProductToInternalID[li.ProductID], // 0 si produit jamais importé/supprimé — accepté, ligne garde son nom/prix
						VariationID: wcProductToInternalID[li.VariationID],
						VendorID:    vendorID,
						Name:        li.Name,
						Quantity:    li.Quantity,
						UnitPrice:   unitPrice,
					})
				}
				linesJSON, _ := json.Marshal(internalLines)

				if *dryRun {
					log.Info("[dry-run] sous-commande à importer", "wc_order_id", o.ID, "vendor_id", vendorID, "lignes", len(internalLines))
					subOrdersCreated++
					seq++
					continue
				}

				ref := fmt.Sprintf("WC-%d-%d", o.ID, seq)
				var subOrderID int64
				err := orderDB.QueryRow(ctx, `
					INSERT INTO orders (reference, customer_id, vendor_id, wc_order_id, status,
					                    payment_status, fulfillment_stage,
					                    lines, subtotal_usd, shipping_usd, total_usd,
					                    shipping_address, billing_address, payment_method, created_at, updated_at)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
					ON CONFLICT (wc_order_id, vendor_id) DO UPDATE SET
						status=excluded.status, payment_status=excluded.payment_status,
						fulfillment_stage=excluded.fulfillment_stage, lines=excluded.lines,
						updated_at=now()
					RETURNING id`,
					// orders.customer_id est NOT NULL — 0 est la convention
					// WooCommerce native pour une commande invité (customer_id
					// absent), conservée telle quelle plutôt que transformée en
					// NULL (contrainte de schéma order-svc, voir orders.customer_id).
					ref, o.CustomerID, vendorID, o.ID, legacyStatus,
					paymentStatus, fulfillmentStage,
					linesJSON, subtotal, parseFloat(o.ShippingTotal), subtotal+parseFloat(o.ShippingTotal),
					shippingAddrJSON, billingAddrJSON, o.PaymentMethod, createdAt,
				).Scan(&subOrderID)
				if err != nil {
					log.Error("insert sous-commande échoué", "wc_order_id", o.ID, "vendor_id", vendorID, "err", err)
					seq++
					continue
				}

				// La première sous-commande créée pour cette commande WooCommerce
				// sert de "parent" logique (même rôle que orders.status='group'
				// dans createOrder) — regroupe l'affichage acheteur sans dupliquer
				// les coordonnées. Créé une fois, référencé par les suivantes.
				if !hasParent {
					if err := orderDB.QueryRow(ctx, `
						INSERT INTO orders (reference, customer_id, vendor_id, wc_order_id, status, created_at, updated_at)
						VALUES ($1,$2,0,$3,'group',$4,$4)
						ON CONFLICT (wc_order_id, vendor_id) DO UPDATE SET updated_at=now()
						RETURNING id`,
						fmt.Sprintf("WC-%d", o.ID), o.CustomerID, o.ID, createdAt,
					).Scan(&parentID); err != nil {
						log.Error("insert commande parent échoué", "wc_order_id", o.ID, "err", err)
					} else {
						hasParent = true
						if _, err := orderDB.Exec(ctx, "UPDATE orders SET parent_order_id = $1 WHERE id = $2", parentID, subOrderID); err != nil {
							log.Error("liaison parent_order_id échouée", "sub_order_id", subOrderID, "err", err)
						}
					}
				} else {
					if _, err := orderDB.Exec(ctx, "UPDATE orders SET parent_order_id = $1 WHERE id = $2", parentID, subOrderID); err != nil {
						log.Error("liaison parent_order_id échouée", "sub_order_id", subOrderID, "err", err)
					}
				}

				subOrdersCreated++

				// Timeline reconstruite (best-effort, voir doc-comment en tête
				// de fichier) — seulement les jalons réellement disponibles
				// dans l'export WooCommerce, pas d'invention d'événements
				// intermédiaires.
				logImportedEvent(ctx, orderDB, subOrderID, "imported", fmt.Sprintf("commande importée depuis WooCommerce #%d", o.ID), createdAt)
				if o.DatePaid != "" {
					logImportedEvent(ctx, orderDB, subOrderID, "paid", "paiement confirmé (WooCommerce)", parseTime(o.DatePaid))
				}
				if o.DateCompleted != "" {
					logImportedEvent(ctx, orderDB, subOrderID, "delivered", "commande complétée (WooCommerce)", parseTime(o.DateCompleted))
				}

				seq++
			}
		}

		if len(batch) < 50 {
			break
		}
		page++
	}
	return ordersProcessed, subOrdersCreated, unresolvedVendorLines, nil
}

func logImportedEvent(ctx context.Context, orderDB *pgxpool.Pool, orderID int64, event, description string, occurredAt time.Time) {
	if _, err := orderDB.Exec(ctx,
		"INSERT INTO order_events (order_id, event, description, actor, occurred_at) VALUES ($1,$2,$3,'wc-import',$4)",
		orderID, event, description, occurredAt); err != nil {
		fmt.Printf("order_events insert échoué order_id=%d err=%v\n", orderID, err)
	}
}

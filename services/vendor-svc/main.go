// ============================================================
// vendor-svc — boutiques (ex-Dokan) : profils, tableau de bord.
// Publie : vendor.registered, vendor.updated
// Les données des AUTRES services se demandent, ne se lisent pas :
// GET /vendor/{id}/products → appel HTTP à catalog-svc (en prod : gRPC).
// ============================================================
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/IBM/sarama"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/miadmarket/miad-backend/internal/kit"
)

const schema = `
CREATE TABLE IF NOT EXISTS vendors (
  id            BIGSERIAL PRIMARY KEY,
  wc_store_id   BIGINT UNIQUE,
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE,
  logo_url      TEXT DEFAULT '',   -- R2, aucune migration d'assets
  banner_url    TEXT DEFAULT '',
  country       TEXT DEFAULT '',
  city          TEXT DEFAULT '',
  phone         TEXT DEFAULT '',
  email         TEXT DEFAULT '',
  verified      BOOLEAN NOT NULL DEFAULT FALSE,
  rating_avg    REAL NOT NULL DEFAULT 0,
  product_count INT NOT NULL DEFAULT 0, -- dénormalisé sur événement catalog
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Back-office admin (module Vendeurs) : KYC, commission personnalisée,
-- modération produit, badges, suspension temporaire — rien de tout ça
-- n'existait, verified était le seul état possible.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'pending'; -- pending/approved/rejected
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS kyc_documents JSONB NOT NULL DEFAULT '[]'; -- [{type, url}]
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS kyc_rejection_reason TEXT DEFAULT '';
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS commission_rate DOUBLE PRECISION; -- NULL = taux global plateforme
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS require_moderation BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS badges JSONB NOT NULL DEFAULT '[]'; -- ["verified","top_vendor","official"]
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS suspension_message TEXT DEFAULT '';
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '';
-- Formulaire "Paramètres de la boutique" (dashboard vendeur) : proposait
-- déjà email/adresse/description côté UI mais updateProfile n'écrivait ni
-- l'un ni l'autre — le vrai appel réseau se faisait en dur vers l'ancien
-- WordPress mort (wp-json/dokan/v1/settings), silencieusement avalé par un
-- toast "enregistré localement" même en cas d'échec. email/address
-- existaient déjà en base mais jamais exposés en écriture ; description
-- n'existait pas du tout.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
`

type server struct {
	db         *pgxpool.Pool
	kafka      sarama.SyncProducer
	catalogURL string
	orderURL   string
}

func main() {
	ctx := context.Background()
	log := kit.Logger("vendor-svc")

	db, err := kit.NewPG(ctx, log, kit.Env("DATABASE_URL_VENDOR", "postgres://miad:miad@postgres:5432/miad_vendor?sslmode=disable"))
	if err != nil {
		log.Error("démarrage impossible sans Postgres", "err", err)
		return
	}
	if err := kit.Migrate(ctx, db, schema); err != nil {
		log.Error("migration impossible", "err", err)
		return
	}

	s := &server{
		db:         db,
		kafka:      kit.NewProducer(kit.Env("KAFKA_BROKERS", "kafka:9092")),
		catalogURL: kit.Env("CATALOG_SVC_URL", "http://catalog-svc:8081"),
		orderURL:   kit.Env("ORDER_SVC_URL", "http://order-svc:8083"),
	}

	health := kit.NewHealth()
	health.Add("postgres", db.Ping)
	health.Add("catalog-svc", func(ctx context.Context) error {
		return ping(ctx, s.catalogURL+"/healthz")
	})

	// vendors.product_count était dénormalisé "sur événement catalog" en
	// commentaire depuis toujours, sans qu'aucun consumer n'existe jamais
	// (0 pour les 74 vendeurs en prod, corrigé manuellement le 2026-08-26).
	// Plutôt que d'incrémenter/décrémenter à l'aveugle (fragile — un seul
	// événement manqué désynchronise à nouveau, sans rattrapage possible),
	// chaque événement pertinent déclenche un recalcul complet via
	// countProducts (déjà utilisé par vendorDashboard) — plus coûteux par
	// événement mais élimine toute dérive.
	go s.consumeProductEvents(log)

	kit.Run("vendor-svc", kit.Env("PORT_VENDOR", "8082"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("GET /stores", s.listStores)
		mux.HandleFunc("GET /vendor/{id}/products", s.vendorProducts)
		mux.HandleFunc("PUT /vendor/profile", s.updateProfile)
		mux.HandleFunc("GET /vendor/{id}/orders", s.vendorOrders)
		mux.HandleFunc("GET /vendor/{id}/dashboard", s.vendorDashboard)
		mux.HandleFunc("GET /vendors", s.listVendorsAdmin)
		mux.HandleFunc("GET /vendors/{id}", s.getVendor)
		mux.HandleFunc("POST /vendors", s.createVendor)
		mux.HandleFunc("PATCH /vendors/{id}", s.updateVendorAdmin)
		mux.HandleFunc("POST /vendors/{id}/kyc/approve", s.approveKYC)
		mux.HandleFunc("POST /vendors/{id}/kyc/reject", s.rejectKYC)
	})
}

func (s *server) listStores(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(kit.EnvOr(q.Get("page"), "1"))
	pageSize, _ := strconv.Atoi(kit.EnvOr(q.Get("page_size"), "20"))
	if page < 1 {
		page = 1
	}

	where := "WHERE verified = TRUE"
	args := []any{}
	if c := q.Get("country"); c != "" {
		where += " AND country = $1"
		args = append(args, c)
	}
	// slug — ajouté le 2026-08-28 : le frontend (MiadMarketClient.tsx,
	// v=vendor&slug=X) ne cherchait une boutique QUE dans les 100 déjà
	// chargées en mémoire, sans aucun secours réseau au-delà — un lien
	// vers une boutique hors de ce lot n'affichait rien (retombait
	// silencieusement sur l'accueil). Permet un fetch ciblé par slug.
	if slug := q.Get("slug"); slug != "" {
		where += fmt.Sprintf(" AND slug = $%d", len(args)+1)
		args = append(args, slug)
	}

	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM vendors "+where, args...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT id, name, slug, logo_url, banner_url, country, city, rating_avg, product_count
		FROM vendors `+where+` ORDER BY rating_avg DESC, id
		LIMIT `+strconv.Itoa(pageSize)+` OFFSET `+strconv.Itoa((page-1)*pageSize), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var name, slug, logo, banner, country, city string
		var rating float64
		var count int
		_ = rows.Scan(&id, &name, &slug, &logo, &banner, &country, &city, &rating, &count)
		items = append(items, vendorToDokanShape(id, name, slug, logo, banner, country, city, rating, count, true))
	}
	kit.JSON(w, 200, map[string]any{
		// items/page/page_size/total/has_more : forme native du service.
		// stores : alias attendu par app/api/stores/route.ts (frontend
		// actuel, qui lit aussi bien {stores:[...]} que le tableau brut).
		"items": items, "stores": items,
		"page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

// vendorToDokanShape — même forme de champs que dokan/v1/stores que le
// frontend attend aujourd'hui (app/api/stores/route.ts) : gravatar/banner
// à plat, rating en objet imbriqué {rating}, enabled au lieu de verified,
// address.country, products_count. Objectif : que la route Next.js
// puisse lire cette réponse sans réécriture, une fois pointée sur
// vendor-svc au lieu de dokan/v1/stores.
func vendorToDokanShape(id int64, name, slug, logo, banner, country, city string, rating float64, productCount int, verified bool) map[string]any {
	return map[string]any{
		"id": id, "store_name": name, "name": name, "slug": slug,
		"gravatar": logo, "logo_url": logo, "banner": banner, "banner_url": banner,
		"country": country, "city": city,
		"address":        map[string]any{"country": country, "city": city},
		"enabled":        verified,
		"verified":       verified,
		"rating":         map[string]any{"rating": rating, "count": 0},
		"rating_avg":     rating,
		"products_count": productCount,
		"product_count":  productCount,
	}
}

// listVendorsAdmin — liste TOUS les vendeurs (contrairement à listStores
// qui ne montre que verified=TRUE au storefront public), avec les champs
// admin (kyc_status, commission, solde à agréger côté payment-svc plus
// tard). Utilisé par admin-svc pour "Tous les Vendeurs".
func (s *server) listVendorsAdmin(w http.ResponseWriter, r *http.Request) {
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
	if v := q.Get("kyc_status"); v != "" {
		args = append(args, v)
		where += fmt.Sprintf(" AND kyc_status = $%d", len(args))
	}
	if v := q.Get("q"); v != "" {
		args = append(args, "%"+v+"%")
		where += fmt.Sprintf(" AND (name ILIKE $%d OR email ILIKE $%d)", len(args), len(args))
	}

	var total int64
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) FROM vendors "+where, args...).Scan(&total); err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}

	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(r.Context(), fmt.Sprintf(`
		SELECT id, name, slug, logo_url, banner_url, country, city, phone, email,
		       verified, rating_avg, product_count, kyc_status, kyc_documents,
		       commission_rate, badges, suspended_until
		FROM vendors %s ORDER BY id DESC LIMIT $%d OFFSET $%d`, where, len(args)-1, len(args)), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var name, slug, logo, banner, country, city, phone, email, kycStatus string
		var verified bool
		var rating float64
		var count int
		var kycDocsJSON []byte
		var commissionRate *float64
		var badgesJSON []byte
		var suspendedUntil *time.Time
		if err := rows.Scan(&id, &name, &slug, &logo, &banner, &country, &city, &phone, &email,
			&verified, &rating, &count, &kycStatus, &kycDocsJSON, &commissionRate, &badgesJSON, &suspendedUntil); err != nil {
			kit.Fail(w, 500, "db_error", err.Error())
			return
		}
		item := vendorToDokanShape(id, name, slug, logo, banner, country, city, rating, count, verified)
		item["phone"] = phone
		item["email"] = email
		item["kyc_status"] = kycStatus
		item["kyc_documents"] = json.RawMessage(kycDocsJSON)
		item["commission_rate"] = commissionRate
		item["badges"] = json.RawMessage(badgesJSON)
		item["suspended"] = suspendedUntil != nil && suspendedUntil.After(time.Now())
		items = append(items, item)
	}
	kit.JSON(w, 200, map[string]any{
		"items": items, "page": page, "page_size": pageSize,
		"total": total, "has_more": int64(page*pageSize) < total,
	})
}

// getVendor — fiche complète, un seul vendeur, tous les champs admin.
func (s *server) getVendor(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	row := s.db.QueryRow(r.Context(), `
		SELECT id, name, slug, logo_url, banner_url, country, city, phone, email,
		       verified, rating_avg, product_count, kyc_status, kyc_documents,
		       kyc_rejection_reason, commission_rate, require_moderation, badges,
		       suspended_until, suspension_message, address, created_at
		FROM vendors WHERE id = $1`, id)

	var vID int64
	var name, slug, logo, banner, country, city, phone, email, kycStatus, kycRejection, address, suspensionMsg string
	var verified, requireModeration bool
	var rating float64
	var count int
	var commissionRate *float64
	var kycDocsJSON, badgesJSON []byte
	var suspendedUntil *time.Time
	var createdAt time.Time
	if err := row.Scan(&vID, &name, &slug, &logo, &banner, &country, &city, &phone, &email,
		&verified, &rating, &count, &kycStatus, &kycDocsJSON, &kycRejection, &commissionRate,
		&requireModeration, &badgesJSON, &suspendedUntil, &suspensionMsg, &address, &createdAt,
	); err != nil {
		kit.Fail(w, 404, "vendor_not_found", fmt.Sprintf("boutique %s introuvable", id))
		return
	}

	out := vendorToDokanShape(vID, name, slug, logo, banner, country, city, rating, count, verified)
	out["phone"] = phone
	out["email"] = email
	out["kyc_status"] = kycStatus
	out["kyc_documents"] = json.RawMessage(kycDocsJSON)
	out["kyc_rejection_reason"] = kycRejection
	out["commission_rate"] = commissionRate
	out["require_moderation"] = requireModeration
	out["badges"] = json.RawMessage(badgesJSON)
	out["suspended_until"] = suspendedUntil
	out["suspension_message"] = suspensionMsg
	out["address"] = address
	out["created_at"] = createdAt.UTC().Format(time.RFC3339)
	kit.JSON(w, 200, out)
}

// createVendor — création manuelle par l'admin (pas d'auto-inscription
// vendeur, désactivée côté frontend — voir CLAUDE.md). Statut activé
// immédiatement (verified=TRUE), l'admin garde la main sur le KYC après
// coup s'il le souhaite plutôt que de bloquer la création elle-même.
func (s *server) createVendor(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name    string `json:"name"`
		Email   string `json:"email"`
		Phone   string `json:"phone"`
		Country string `json:"country"`
		City    string `json:"city"`
		LogoURL string `json:"logo_url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.Name == "" {
		kit.Fail(w, 400, "missing_name", "name requis")
		return
	}
	var id int64
	err := s.db.QueryRow(r.Context(), `
		INSERT INTO vendors (name, slug, email, phone, country, city, logo_url, verified, kyc_status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,'approved') RETURNING id`,
		body.Name, slugify(body.Name), body.Email, body.Phone, body.Country, body.City, body.LogoURL,
	).Scan(&id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	kit.Publish(s.kafka, "vendor.registered", fmt.Sprint(id), map[string]any{
		"vendor_id": id, "email": body.Email, "name": body.Name, "at": time.Now().UTC().Format(time.RFC3339),
	})
	kit.JSON(w, 201, map[string]any{"id": id})
}

// updateVendorAdmin — édition admin complète (contrairement à
// updateProfile qui est le self-service vendeur limité à 5 champs).
func (s *server) updateVendorAdmin(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	var body struct {
		Name              *string   `json:"name"`
		Email             *string   `json:"email"`
		Phone             *string   `json:"phone"`
		Country           *string   `json:"country"`
		City              *string   `json:"city"`
		Address           *string   `json:"address"`
		LogoURL           *string   `json:"logo_url"`
		BannerURL         *string   `json:"banner_url"`
		Verified          *bool     `json:"verified"`
		CommissionRate    *float64  `json:"commission_rate"`
		ClearCommission   bool      `json:"clear_commission"`
		RequireModeration *bool     `json:"require_moderation"`
		Badges            *[]string `json:"badges"`
		SuspendedUntil    *string   `json:"suspended_until"` // RFC3339, "" = lever la suspension
		SuspensionMessage *string   `json:"suspension_message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	set := []string{}
	args := []any{}
	add := func(col string, v any) {
		args = append(args, v)
		set = append(set, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	if body.Name != nil {
		add("name", *body.Name)
	}
	if body.Email != nil {
		add("email", *body.Email)
	}
	if body.Phone != nil {
		add("phone", *body.Phone)
	}
	if body.Country != nil {
		add("country", *body.Country)
	}
	if body.City != nil {
		add("city", *body.City)
	}
	if body.Address != nil {
		add("address", *body.Address)
	}
	if body.LogoURL != nil {
		add("logo_url", *body.LogoURL)
	}
	if body.BannerURL != nil {
		add("banner_url", *body.BannerURL)
	}
	if body.Verified != nil {
		add("verified", *body.Verified)
	}
	if body.ClearCommission {
		add("commission_rate", nil)
	} else if body.CommissionRate != nil {
		add("commission_rate", *body.CommissionRate)
	}
	if body.RequireModeration != nil {
		add("require_moderation", *body.RequireModeration)
	}
	if body.Badges != nil {
		badgesJSON, _ := json.Marshal(*body.Badges)
		add("badges", badgesJSON)
	}
	if body.SuspendedUntil != nil {
		if *body.SuspendedUntil == "" {
			add("suspended_until", nil)
		} else {
			t, err := time.Parse(time.RFC3339, *body.SuspendedUntil)
			if err != nil {
				kit.Fail(w, 400, "invalid_date", "suspended_until doit être RFC3339")
				return
			}
			add("suspended_until", t)
		}
	}
	if body.SuspensionMessage != nil {
		add("suspension_message", *body.SuspensionMessage)
	}
	if len(set) == 0 {
		kit.Fail(w, 400, "empty_update", "aucun champ à modifier fourni")
		return
	}
	args = append(args, id)
	tag, err := s.db.Exec(r.Context(),
		fmt.Sprintf("UPDATE vendors SET %s WHERE id = $%d", strings.Join(set, ", "), len(args)), args...)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "vendor_not_found", fmt.Sprintf("boutique %d introuvable", id))
		return
	}
	kit.Publish(s.kafka, "vendor.updated", fmt.Sprint(id), map[string]any{
		"vendor_id": id, "at": time.Now().UTC().Format(time.RFC3339),
	})
	// Event dédié pour suspended_until — équivalent de "Vendor Enable"/
	// "Vendor Disable" côté Dokan. vendor.updated générique ne précise
	// jamais QUEL champ a changé, donc email-svc ne peut pas en déduire
	// une notification vendeur pertinente sans ce signal explicite.
	if body.SuspendedUntil != nil {
		suspended := *body.SuspendedUntil != ""
		kit.Publish(s.kafka, "vendor.suspension_changed", fmt.Sprint(id), map[string]any{
			"vendor_id": id, "suspended": suspended, "message": stringOrEmptyPtr(body.SuspensionMessage),
			"at": time.Now().UTC().Format(time.RFC3339),
		})
	}
	kit.JSON(w, 200, map[string]any{"id": id, "updated": true})
}

func stringOrEmptyPtr(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func (s *server) approveKYC(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	tag, err := s.db.Exec(r.Context(),
		"UPDATE vendors SET kyc_status = 'approved', kyc_rejection_reason = '', verified = TRUE WHERE id = $1", id)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "vendor_not_found", fmt.Sprintf("boutique %d introuvable", id))
		return
	}
	kit.JSON(w, 200, map[string]any{"id": id, "kyc_status": "approved"})
}

func (s *server) rejectKYC(w http.ResponseWriter, r *http.Request) {
	id := atoi(r.PathValue("id"))
	var body struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	tag, err := s.db.Exec(r.Context(),
		"UPDATE vendors SET kyc_status = 'rejected', kyc_rejection_reason = $2 WHERE id = $1", id, body.Reason)
	if err != nil {
		kit.Fail(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		kit.Fail(w, 404, "vendor_not_found", fmt.Sprintf("boutique %d introuvable", id))
		return
	}
	kit.JSON(w, 200, map[string]any{"id": id, "kyc_status": "rejected"})
}

// vendorProducts — délégation à catalog-svc : vendor-svc ne possède pas
// les produits. En local : HTTP ; après codegen : appel gRPC typé.
func (s *server) vendorProducts(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	lang := r.URL.Query().Get("lang")
	page := r.URL.Query().Get("page")
	upstream := fmt.Sprintf("%s/products?vendor_id=%s&lang=%s&page=%s", s.catalogURL, id, lang, page)
	resp, err := http.Get(upstream)
	if err != nil {
		kit.Fail(w, 502, "catalog_unreachable",
			"catalog-svc injoignable — erreur EXPLICITE (sous WordPress, ce cas renvoyait une liste vide silencieuse)")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		kit.Fail(w, 502, "catalog_error", fmt.Sprintf("catalog-svc a répondu %d: %s", resp.StatusCode, body))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_, _ = io.Copy(w, resp.Body)
}

func (s *server) updateProfile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		VendorID    int64  `json:"vendor_id"`
		Name        string `json:"name"`
		LogoURL     string `json:"logo_url"`
		BannerURL   string `json:"banner_url"`
		Phone       string `json:"phone"`
		City        string `json:"city"`
		Email       string `json:"email"`
		Address     string `json:"address"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		kit.Fail(w, 400, "invalid_body", err.Error())
		return
	}
	if body.VendorID == 0 {
		kit.Fail(w, 400, "missing_fields", "vendor_id obligatoire")
		return
	}
	row := s.db.QueryRow(r.Context(), `
		UPDATE vendors SET
			name = COALESCE(NULLIF($2,''), name),
			logo_url = COALESCE(NULLIF($3,''), logo_url),
			banner_url = COALESCE(NULLIF($4,''), banner_url),
			phone = COALESCE(NULLIF($5,''), phone),
			city = COALESCE(NULLIF($6,''), city),
			email = COALESCE(NULLIF($7,''), email),
			address = COALESCE(NULLIF($8,''), address),
			description = COALESCE(NULLIF($9,''), description)
		WHERE id = $1
		RETURNING id, name, slug, logo_url, banner_url, country, city, phone, email, verified, address, description`,
		body.VendorID, body.Name, body.LogoURL, body.BannerURL, body.Phone, body.City, body.Email, body.Address, body.Description)

	var id int64
	var name, slug, logo, banner, country, city, phone, email, address, description string
	var verified bool
	if err := row.Scan(&id, &name, &slug, &logo, &banner, &country, &city, &phone, &email, &verified, &address, &description); err != nil {
		kit.Fail(w, 404, "vendor_not_found", fmt.Sprintf("boutique %d introuvable", body.VendorID))
		return
	}
	kit.Publish(s.kafka, "vendor.updated", fmt.Sprint(id), map[string]any{
		"vendor_id": id, "at": time.Now().UTC().Format(time.RFC3339),
	})
	out := vendorToDokanShape(id, name, slug, logo, banner, country, city, 0, 0, verified)
	out["phone"] = phone
	out["email"] = email
	out["address"] = address
	out["description"] = description
	kit.JSON(w, 200, out)
}

// vendorOrders — même principe : les commandes appartiennent à order-svc.
func (s *server) vendorOrders(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	upstream := fmt.Sprintf("%s/orders?vendor_id=%s&page=%s", s.orderURL, id, r.URL.Query().Get("page"))
	resp, err := http.Get(upstream)
	if err != nil {
		kit.Fail(w, 502, "order_unreachable", "order-svc injoignable — réessayez, la donnée n'est pas perdue")
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// vendorDashboard — agrège produits (catalog-svc) + commandes (order-svc)
// pour le tableau de bord vendeur, même pattern HTTP simple que
// vendorProducts/vendorOrders (pas de gRPC, un relais direct). Remplace
// les anciennes routes WordPress dokan/v1/vendor/dashboard.
func (s *server) vendorDashboard(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ctx := r.Context()

	productsTotal, err := s.countProducts(ctx, id)
	if err != nil {
		kit.Fail(w, 502, "catalog_unreachable", "catalog-svc injoignable — erreur EXPLICITE")
		return
	}

	orders, err := s.fetchVendorOrders(ctx, id)
	if err != nil {
		kit.Fail(w, 502, "order_unreachable", "order-svc injoignable — erreur EXPLICITE")
		return
	}

	var revenueUSD float64
	ordersByStatus := map[string]int{}
	for _, o := range orders {
		revenueUSD += o.TotalUSD
		ordersByStatus[o.Status]++
	}

	vendorIDNum, _ := strconv.Atoi(id)
	kit.JSON(w, 200, map[string]any{
		"vendor_id":        vendorIDNum,
		"products_total":   productsTotal,
		"orders_total":     len(orders),
		"revenue_usd":      revenueUSD,
		"orders_by_status": ordersByStatus,
	})
}

func (s *server) countProducts(ctx context.Context, vendorID string) (int64, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/products?vendor_id=%s&page_size=1", s.catalogURL, vendorID), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("catalog-svc a répondu %d", resp.StatusCode)
	}
	var out struct {
		Total int64 `json:"total"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, err
	}
	return out.Total, nil
}

/* ---------- vendors.product_count : consumer Kafka ---------- */

// consumeProductEvents — même pattern retry/backoff que
// loyalty-svc.consumeCustomerEvents. Écoute product.created et
// product.status_changed (catalog-svc) : les deux payloads portent déjà
// vendor_id, donc pas besoin de les distinguer, juste de recalculer.
func (s *server) consumeProductEvents(log *slog.Logger) {
	brokers := kit.Env("KAFKA_BROKERS", "kafka:9092")
	if brokers == "" {
		log.Warn("KAFKA_BROKERS vide — resynchronisation product_count désactivée (mode dev)")
		return
	}
	cfg := sarama.NewConfig()
	cfg.Consumer.Offsets.Initial = sarama.OffsetOldest
	cfg.Version = sarama.V2_8_0_0

	for {
		group, err := sarama.NewConsumerGroup([]string{brokers}, "vendor-svc", cfg)
		if err != nil {
			log.Error("kafka injoignable — retry 5 s", "err", err)
			time.Sleep(5 * time.Second)
			continue
		}
		handler := productCountConsumer{s: s, log: log}
		_ = group.Consume(context.Background(), []string{"product.created", "product.status_changed"}, handler)
		group.Close()
	}
}

type productCountConsumer struct {
	s   *server
	log *slog.Logger
}

func (c productCountConsumer) Setup(sarama.ConsumerGroupSession) error   { return nil }
func (c productCountConsumer) Cleanup(sarama.ConsumerGroupSession) error { return nil }
func (c productCountConsumer) ConsumeClaim(sess sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
	for msg := range claim.Messages() {
		var payload struct {
			VendorID int64 `json:"vendor_id"`
		}
		if err := json.Unmarshal(msg.Value, &payload); err == nil && payload.VendorID > 0 {
			c.s.resyncProductCount(sess.Context(), c.log, payload.VendorID)
		}
		sess.MarkMessage(msg, "")
	}
	return nil
}

// resyncProductCount — recalcul complet (pas d'incrément/décrément) :
// best-effort, une erreur catalog-svc ne doit jamais faire planter le
// consumer, juste laisser product_count tel quel jusqu'au prochain
// événement ou à une resynchronisation manuelle.
func (s *server) resyncProductCount(ctx context.Context, log *slog.Logger, vendorID int64) {
	count, err := s.countProducts(ctx, strconv.FormatInt(vendorID, 10))
	if err != nil {
		log.Warn("resync product_count échouée", "vendor_id", vendorID, "err", err)
		return
	}
	if _, err := s.db.Exec(ctx, "UPDATE vendors SET product_count = $1 WHERE id = $2", count, vendorID); err != nil {
		log.Warn("resync product_count : échec UPDATE", "vendor_id", vendorID, "err", err)
	}
}

type vendorOrderSummary struct {
	Status   string  `json:"status"`
	TotalUSD float64 `json:"total_usd"`
}

func (s *server) fetchVendorOrders(ctx context.Context, vendorID string) ([]vendorOrderSummary, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/orders?vendor_id=%s&page_size=100", s.orderURL, vendorID), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("order-svc a répondu %d", resp.StatusCode)
	}
	var out struct {
		Items []vendorOrderSummary `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Items, nil
}

func ping(ctx context.Context, url string) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func atoi(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	lastDash := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash {
				b.WriteRune('-')
				lastDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

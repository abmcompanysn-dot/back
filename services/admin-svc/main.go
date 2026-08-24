// ============================================================
// admin-svc — console d'administration + API agrégée.
// L'interface (dashboard.html) est EMBARQUÉE dans le binaire Go
// (go:embed), vanilla JS, zéro build frontend. Toute route
// /admin/api/* exige un JWT role=admin (émis par auth-svc).
// admin-svc ne possède aucune donnée : il interroge les autres
// services par HTTP (gRPC après codegen) et agrège la réponse.
// ============================================================
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/miadmarket/miad-backend/internal/kit"
)

//go:embed dashboard.html
var dashboardFS embed.FS

type server struct {
	jwtSec          []byte
	catalogURL      string
	vendorURL       string
	orderURL        string
	paymentURL      string
	shippingURL     string
	authURL         string
	notificationURL string
	emailURL        string
	fulfillmentURL  string
	loyaltyURL      string
}

func main() {
	log := kit.Logger("admin-svc")

	s := &server{
		jwtSec:          []byte(kit.Env("JWT_SECRET", "change-me")),
		catalogURL:      kit.Env("CATALOG_SVC_URL", "http://catalog-svc:8081"),
		vendorURL:       kit.Env("VENDOR_SVC_URL", "http://vendor-svc:8082"),
		orderURL:        kit.Env("ORDER_SVC_URL", "http://order-svc:8083"),
		paymentURL:      kit.Env("PAYMENT_SVC_URL", "http://payment-svc:8084"),
		shippingURL:     kit.Env("SHIPPING_SVC_URL", "http://shipping-svc:8085"),
		authURL:         kit.Env("AUTH_SVC_URL", "http://auth-svc:8086"),
		notificationURL: kit.Env("NOTIFICATION_SVC_URL", "http://notification-svc:8087"),
		emailURL:        kit.Env("EMAIL_SVC_URL", "http://email-svc:8089"),
		fulfillmentURL:  kit.Env("FULFILLMENT_SVC_URL", "http://fulfillment-svc:8090"),
		loyaltyURL:      kit.Env("LOYALTY_SVC_URL", "http://loyalty-svc:8091"),
	}

	health := kit.NewHealth()
	for name, url := range s.allServiceURLs() {
		u := url
		health.Add(name, func(ctx context.Context) error { return ping(ctx, u+"/healthz") })
	}

	kit.Run("admin-svc", kit.Env("PORT_ADMIN", "8088"), log, health, func(mux *http.ServeMux) {
		mux.HandleFunc("GET /admin", s.serveDashboard)
		mux.HandleFunc("GET /admin/api/overview", s.requireAdmin(s.overview))
		mux.HandleFunc("GET /admin/api/orders", s.requireAdmin(s.proxy(func() string { return s.orderURL + "/orders" })))
		mux.HandleFunc("GET /admin/api/orders/{id}", s.requireAdmin(s.proxyPath(func(id string) string {
			return s.orderURL + "/orders/" + id
		})))
		mux.HandleFunc("GET /admin/api/products", s.requireAdmin(s.proxy(func() string { return s.catalogURL + "/products" })))
		mux.HandleFunc("GET /admin/api/categories", s.requireAdmin(s.proxy(func() string { return s.catalogURL + "/categories" })))
		mux.HandleFunc("GET /admin/api/vendors", s.requireAdmin(s.proxy(func() string { return s.vendorURL + "/stores" })))
		mux.HandleFunc("GET /admin/api/customers", s.requireAdmin(s.proxyAuth(func() string { return s.authURL + "/customers" })))
		mux.HandleFunc("GET /admin/api/payments", s.requireAdmin(s.proxy(func() string { return s.paymentURL + "/payments" })))
		mux.HandleFunc("GET /admin/api/shipping-quote", s.requireAdmin(s.proxy(func() string { return s.shippingURL + "/shipping-rates/quote" })))
		mux.HandleFunc("GET /admin/api/shipments", s.requireAdmin(s.proxy(func() string { return s.fulfillmentURL + "/shipments" })))
		mux.HandleFunc("GET /admin/api/coins/leaderboard", s.requireAdmin(s.proxy(func() string { return s.loyaltyURL + "/coins/leaderboard" })))
		mux.HandleFunc("GET /admin/api/representative/messages", s.requireAdmin(s.proxy(func() string { return s.loyaltyURL + "/representative/messages" })))
		mux.HandleFunc("GET /admin/api/system", s.requireAdmin(s.systemCheck))
	})
}

func (s *server) allServiceURLs() map[string]string {
	return map[string]string{
		"catalog-svc": s.catalogURL, "vendor-svc": s.vendorURL, "order-svc": s.orderURL,
		"payment-svc": s.paymentURL, "shipping-svc": s.shippingURL, "auth-svc": s.authURL,
		"notification-svc": s.notificationURL, "email-svc": s.emailURL,
		"fulfillment-svc": s.fulfillmentURL, "loyalty-svc": s.loyaltyURL,
	}
}

func (s *server) serveDashboard(w http.ResponseWriter, r *http.Request) {
	body, err := dashboardFS.ReadFile("dashboard.html")
	if err != nil {
		kit.Fail(w, 500, "dashboard_missing", err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(body)
}

// ---------- overview : compteurs + CA + état des services ----------

func (s *server) overview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	out := map[string]any{}

	if body, err := getJSON(ctx, s.orderURL+"/orders?page_size=1"); err == nil {
		out["orders_total"] = body["total"]
	} else {
		out["orders_error"] = err.Error()
	}
	if body, err := getJSON(ctx, s.catalogURL+"/products?page_size=1"); err == nil {
		out["products_total"] = body["total"]
	} else {
		out["products_error"] = err.Error()
	}
	if body, err := getJSON(ctx, s.vendorURL+"/stores?page_size=1"); err == nil {
		out["vendors_total"] = body["total"]
	} else {
		out["vendors_error"] = err.Error()
	}
	if body, err := getJSON(ctx, s.paymentURL+"/payments?page_size=1"); err == nil {
		out["payments_total"] = body["total"]
	} else {
		out["payments_error"] = err.Error()
	}

	statuses := map[string]string{}
	for name, url := range s.allServiceURLs() {
		if err := ping(ctx, url+"/healthz"); err != nil {
			statuses[name] = "down"
		} else {
			statuses[name] = "ok"
		}
	}
	out["services"] = statuses
	out["generated_at"] = time.Now().UTC().Format(time.RFC3339)
	kit.JSON(w, 200, out)
}

func (s *server) systemCheck(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	out := map[string]any{}
	overall := "ok"
	for name, url := range s.allServiceURLs() {
		body, err := getJSON(ctx, url+"/system-check")
		if err != nil {
			out[name] = map[string]string{"status": "down", "error": err.Error()}
			overall = "degraded"
			continue
		}
		out[name] = body
		if st, _ := body["status"].(string); st != "ok" {
			overall = "degraded"
		}
	}
	kit.JSON(w, 200, map[string]any{"status": overall, "services": out})
}

// ---------- proxies génériques ----------

func (s *server) proxy(target func() string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		upstream := target()
		if r.URL.RawQuery != "" {
			upstream += "?" + r.URL.RawQuery
		}
		forward(w, r, upstream)
	}
}

func (s *server) proxyPath(target func(id string) string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		forward(w, r, target(r.PathValue("id")))
	}
}

// proxyAuth — même principe, mais vers auth-svc qui applique lui-même
// sa propre vérification role=admin ; ici on relaie aussi l'en-tête
// Authorization pour que ce contrôle redondant passe.
func (s *server) proxyAuth(target func() string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		upstream := target()
		if r.URL.RawQuery != "" {
			upstream += "?" + r.URL.RawQuery
		}
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstream, nil)
		if err != nil {
			kit.Fail(w, 500, "upstream_request_error", err.Error())
			return
		}
		req.Header.Set("Authorization", r.Header.Get("Authorization"))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			kit.Fail(w, 502, "upstream_unreachable", err.Error())
			return
		}
		defer resp.Body.Close()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}
}

func forward(w http.ResponseWriter, r *http.Request, upstream string) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstream, nil)
	if err != nil {
		kit.Fail(w, 500, "upstream_request_error", err.Error())
		return
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		kit.Fail(w, 502, "upstream_unreachable", fmt.Sprintf("%s injoignable — erreur EXPLICITE", upstream))
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func getJSON(ctx context.Context, url string) (map[string]any, error) {
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
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body, nil
}

func ping(ctx context.Context, url string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
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

// ---------- JWT role=admin (même schéma HS256 que auth-svc) ----------

func (s *server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := s.verifyAdminJWT(r); err != nil {
			kit.Fail(w, 403, "admin_required", err.Error())
			return
		}
		next(w, r)
	}
}

func (s *server) verifyAdminJWT(r *http.Request) error {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return fmt.Errorf("Authorization: Bearer <jwt> attendu")
	}
	parts := strings.Split(h[len(prefix):], ".")
	if len(parts) != 3 {
		return fmt.Errorf("JWT malformé")
	}
	mac := hmac.New(sha256.New, s.jwtSec)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	wantSig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(mac.Sum(nil), wantSig) {
		return fmt.Errorf("signature invalide")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return fmt.Errorf("payload illisible")
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return fmt.Errorf("payload JSON invalide")
	}
	if exp, ok := claims["exp"].(float64); ok && time.Now().Unix() > int64(exp) {
		return fmt.Errorf("session expirée")
	}
	if claims["role"] != "admin" {
		return fmt.Errorf("rôle admin requis")
	}
	return nil
}

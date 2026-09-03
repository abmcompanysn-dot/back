// ============================================================
// exchange-rates-refresh.go — rafraîchissement automatique des taux
// de change (2026-09-03, demande fondateur : "le devis c'est en dur,
// tu peux l'enlever et faire par backend").
//
// Avant ce fichier, exchange_rates était seedée une seule fois au
// premier démarrage (defaultExchangeRates, main.go) puis plus jamais
// mise à jour automatiquement — un taux qui dérive fait sous/sur-
// facturer le client (XOF réel ~566 mi-2026, la valeur seedée restait
// à 600, ~6% d'écart). exchange_rates reste la source unique lue par
// payment-svc (PawaPay/PayDunya) et le frontend — corriger ici suffit
// à corriger toute la chaîne, aucun autre service à toucher.
//
// Source : exchangerate-api.com (déjà citée comme référence dans
// payment-svc/pawapay.go pour la table de secours manuelle) — API
// publique gratuite, sans clé, rafraîchie ~1×/jour côté fournisseur ;
// interroger plus souvent n'apporterait aucune précision
// supplémentaire, d'où le ticker quotidien ci-dessous.
package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// trackedCurrencies — devises réellement utilisées par le catalogue/
// paiement (CAD : Canada : voir CAD_TO_USD_RATE frontend ; les autres :
// pawapayFallbackRates dans payment-svc/pawapay.go — tenir les deux
// listes synchronisées si un nouveau pays PawaPay est ajouté).
var trackedCurrencies = []string{
	"CAD",
	"XOF", "XAF", "GHS", "KES", "NGN", "TZS",
	"UGX", "RWF", "ZMW", "MWK", "MZN", "CDF", "SLE",
}

type erAPIResponse struct {
	Result string             `json:"result"`
	Rates  map[string]float64 `json:"rates"`
}

// fetchLiveRates — GET https://open.er-api.com/v6/latest/USD, ne garde
// que trackedCurrencies. Best-effort : une erreur réseau ne doit jamais
// faire planter le service, juste laisser les taux existants tels
// quels jusqu'au prochain tick (voir refreshExchangeRatesOnce).
func fetchLiveRates(ctx context.Context) (map[string]float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://open.er-api.com/v6/latest/USD", nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var doc erAPIResponse
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, err
	}
	out := map[string]float64{}
	for _, cur := range trackedCurrencies {
		if v, ok := doc.Rates[cur]; ok && v > 0 {
			out[cur] = v
		}
	}
	return out, nil
}

// refreshExchangeRatesOnce — interroge la source live puis upsert
// exchange_rates (même requête que setExchangeRate, endpoint admin
// manuel resté intact — un taux réglé à la main y sera simplement
// écrasé au prochain tick automatique, comportement voulu : la source
// vivante prime, l'admin reste libre de re-régler entre deux ticks
// pour un besoin ponctuel).
func (s *server) refreshExchangeRatesOnce(ctx context.Context, log *slog.Logger) {
	rates, err := fetchLiveRates(ctx)
	if err != nil {
		log.Warn("rafraîchissement taux de change impossible — anciennes valeurs conservées", "err", err)
		return
	}
	if len(rates) == 0 {
		log.Warn("rafraîchissement taux de change : réponse sans taux exploitable")
		return
	}
	for currency, rate := range rates {
		if _, err := s.db.Exec(ctx, `
			INSERT INTO exchange_rates (currency, rate_per_usd, updated_at) VALUES ($1,$2,now())
			ON CONFLICT (currency) DO UPDATE SET rate_per_usd = EXCLUDED.rate_per_usd, updated_at = now()`,
			currency, rate); err != nil {
			log.Warn("upsert taux de change échoué", "currency", currency, "err", err)
		}
	}
	log.Info("taux de change rafraîchis", "count", len(rates), "source", "open.er-api.com")
}

// startExchangeRateRefreshLoop — un tick immédiat au démarrage (ne
// bloque pas main() : lancé dans sa propre goroutine, seedExchangeRates
// garantit déjà des valeurs figées disponibles pendant ce premier
// appel réseau), puis un tick toutes les 24h.
func (s *server) startExchangeRateRefreshLoop(log *slog.Logger) {
	go func() {
		ctx := context.Background()
		s.refreshExchangeRatesOnce(ctx, log)
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			s.refreshExchangeRatesOnce(ctx, log)
		}
	}()
}

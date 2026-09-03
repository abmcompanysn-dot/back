// ============================================================
// Package kit — guard.go : détection + blocage automatique des
// comportements suspects (audit sécurité 2026-09-03).
//
// Principe (choix validés avec le fondateur) :
//   - Compteur en MÉMOIRE par pod : fenêtre glissante par clé
//     (ip / ip+route / email / msisdn…). Pas de Redis dans le
//     cluster — 1 réplica par service aujourd'hui, un attaquant
//     réparti sur plusieurs pods serait compté séparément, limite
//     assumée. Le compteur est borné en mémoire (map purgée).
//   - HISTORIQUE centralisé dans miad_admin : admin-svc porte les
//     tables security_events + blocked_ips (GuardSchema) et sa
//     console les lit directement. Les AUTRES services n'ont pas ces
//     tables : leur guard reçoit un SinkFn / BlocklistFn / BlockPushFn
//     qui POSTent vers admin-svc (/internal/security-*). Ainsi un
//     blocage décidé par n'importe quel service est visible et
//     respecté par tous, et il n'y a qu'un journal à consulter.
//   - BLOCAGE appliqué par ce middleware Go : au début de chaque
//     requête, si l'IP est dans la liste noire (cache RAM court, 30 s,
//     rechargé depuis miad_admin) → 429 immédiat, la requête
//     n'atteint jamais le handler.
//   - ALERTE : callback fourni par le service (email-svc/loyalty-svc
//     via admin-svc). Jamais bloquant pour la requête.
//
// Rappel CLAUDE.md : kit.Fail ne loge rien. Ici on loge
// explicitement (slog.Warn) chaque déclenchement ET chaque blocage,
// pour que `kubectl logs` montre l'activité du guard en direct.
// ============================================================
package kit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ---------- Schéma SQL (idempotent, à ajouter au Migrate du service) ----------

// GuardSchema — tables du guard. Un service qui active le guard
// (via NewGuard) doit inclure ce schéma dans son appel à kit.Migrate.
const GuardSchema = `
CREATE TABLE IF NOT EXISTS security_events (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  svc         TEXT        NOT NULL,
  rule        TEXT        NOT NULL,          -- identifiant de la règle (ex: "order_id_scan")
  severity    TEXT        NOT NULL,          -- "info" | "warn" | "critical"
  action      TEXT        NOT NULL,          -- "alert" | "throttle" | "block"
  ip          TEXT        NOT NULL DEFAULT '',
  subject     TEXT        NOT NULL DEFAULT '', -- email / msisdn / vendor_id concerné, si pertinent
  method      TEXT        NOT NULL DEFAULT '',
  path        TEXT        NOT NULL DEFAULT '',
  count       INT         NOT NULL DEFAULT 0, -- valeur du compteur au déclenchement
  window_sec  INT         NOT NULL DEFAULT 0,
  detail      TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events (created_at DESC);
CREATE INDEX IF NOT EXISTS security_events_ip_idx      ON security_events (ip);

CREATE TABLE IF NOT EXISTS blocked_ips (
  ip          TEXT        PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  rule        TEXT        NOT NULL DEFAULT '',
  reason      TEXT        NOT NULL DEFAULT '',
  hits        INT         NOT NULL DEFAULT 0,  -- nb de requêtes refusées depuis le blocage
  manual      BOOLEAN     NOT NULL DEFAULT false -- true = ajouté à la main par un admin
);
CREATE INDEX IF NOT EXISTS blocked_ips_expires_idx ON blocked_ips (expires_at);
`

// ---------- Types publics ----------

// Severity — niveau d'une alerte, sert à router les canaux (WhatsApp
// seulement pour "critical", email pour "warn"+, journal toujours).
type Severity string

const (
	SevInfo     Severity = "info"
	SevWarn     Severity = "warn"
	SevCritical Severity = "critical"
)

// Action — ce que le guard fait quand une règle se déclenche.
type Action string

const (
	// ActAlert — journal + callback d'alerte, la requête passe.
	ActAlert Action = "alert"
	// ActThrottle — 429 sur CETTE requête, mais pas de blocage
	// persistant de l'IP (utilisé pour le scraping : on ralentit
	// sans exclure un utilisateur peut-être légitime).
	ActThrottle Action = "throttle"
	// ActBlock — l'IP entre dans blocked_ips pour BlockFor, toutes
	// ses requêtes suivantes (tous services partageant la base)
	// sont refusées en 429 jusqu'à expiration.
	ActBlock Action = "block"
)

// Rule — une règle de détection. Le compteur est incrémenté à chaque
// appel de Guard.Note(key, rule) ; quand il dépasse Threshold sur
// Window, Action est appliquée.
//
// KeyFn extrait la clé de comptage depuis la requête (souvent l'IP,
// parfois IP+path, parfois une valeur métier passée via Note). Si
// KeyFn est nil, l'IP du client est utilisée.
//
// Match, s'il est non nil, restreint la règle aux requêtes qui le
// satisfont (méthode + préfixe de chemin) — pour les règles câblées
// sur le trafic HTTP brut (1, 6, 8). Les règles métier (2, 3, 4, 10)
// n'ont pas de Match : elles ne se déclenchent que sur un Note()
// explicite depuis un handler.
type Rule struct {
	Name      string
	Severity  Severity
	Action    Action
	Threshold int
	Window    time.Duration
	BlockFor  time.Duration // utilisé seulement si Action == ActBlock
	Detail    string        // texte lisible pour l'alerte / le journal

	// FailOnly — si true, seuls les Note(..., failed=true) comptent
	// (bourrage d'identifiants : un login réussi ne doit pas compter).
	FailOnly bool

	// httpMatch — rempli par les helpers MatchHTTP*, nil pour les
	// règles purement métier.
	httpMatch *httpMatcher
}

type httpMatcher struct {
	methods     map[string]bool // vide = toutes
	pathPrefix  string
	pathExact   string
	minStatus   int  // ne compte que si le status de réponse >= minStatus (0 = ignore)
	statusIs404 bool // ne compte que les 404 (balayage d'ID)
}

// MatchHTTP — restreint une règle à des requêtes HTTP (méthode +
// chemin). methods vide = toutes les méthodes.
func MatchHTTP(r Rule, pathPrefix string, methods ...string) Rule {
	m := &httpMatcher{pathPrefix: pathPrefix, methods: map[string]bool{}}
	for _, x := range methods {
		m.methods[strings.ToUpper(x)] = true
	}
	r.httpMatch = m
	return r
}

// OnStatus — la règle ne compte la requête que si la réponse a un
// status >= min (ex. 400 pour "explosion de 4xx/5xx").
func OnStatus(r Rule, min int) Rule {
	if r.httpMatch == nil {
		r.httpMatch = &httpMatcher{methods: map[string]bool{}}
	}
	r.httpMatch.minStatus = min
	return r
}

// On404 — la règle ne compte que les réponses 404 (balayage d'IDs).
func On404(r Rule) Rule {
	if r.httpMatch == nil {
		r.httpMatch = &httpMatcher{methods: map[string]bool{}}
	}
	r.httpMatch.statusIs404 = true
	return r
}

// AlertFn — callback appelé (dans une goroutine, jamais bloquant)
// quand une règle se déclenche. Le service fournit l'implémentation
// (admin-svc : pousse email + WhatsApp selon ev.Severity).
type AlertFn func(ev Event)

// SinkFn — persistance de l'événement, déléguée. Si fourni à NewGuard,
// le guard N'ÉCRIT PAS lui-même dans security_events : il appelle
// SinkFn (utilisé par les services SANS table locale — ils POSTent
// l'Event à admin-svc, qui centralise le journal dans miad_admin).
// Si nil, le guard écrit dans sa propre base (cas d'admin-svc).
type SinkFn func(ev Event)

// BlocklistFn — renvoie la liste noire partagée (ip -> expiration).
// Fourni par les services qui n'ont pas la table blocked_ips en local
// (GET admin-svc /internal/security-blocks). Si nil, le guard lit sa
// propre table blocked_ips (cas d'admin-svc). Un blocage décidé par
// n'importe quel service est ainsi respecté par tous.
type BlocklistFn func(ctx context.Context) (map[string]time.Time, error)

// BlockPushFn — enregistre un blocage décidé localement dans le store
// partagé (POST admin-svc /internal/security-block). Fourni avec
// BlocklistFn. Si nil, le guard écrit dans sa propre table.
type BlockPushFn func(ctx context.Context, ip, rule, reason string, until time.Time) error

// Event — passé à AlertFn et écrit dans security_events.
type Event struct {
	Svc       string
	Rule      string
	Severity  Severity
	Action    Action
	IP        string
	Subject   string
	Method    string
	Path      string
	Count     int
	WindowSec int
	Detail    string
}

// ---------- Guard ----------

type Guard struct {
	svc       string
	db        *pgxpool.Pool
	log       *slog.Logger
	alert     AlertFn
	sink      SinkFn
	blockList BlocklistFn
	blockPush BlockPushFn
	rules     []Rule

	mu      sync.Mutex
	buckets map[string]*bucket // clé = rule.Name + "|" + countKey

	// cache court de la liste noire pour ne pas taper Postgres à
	// chaque requête.
	blkMu      sync.RWMutex
	blocked    map[string]time.Time // ip -> expires_at
	blockedExp time.Time            // date de rafraîchissement du cache

	// trustProxy — si true, l'IP client est lue depuis
	// X-Forwarded-For / CF-Connecting-IP (on est derrière Cloudflare
	// puis Caddy en prod, donc oui). Le dernier hop de confiance est
	// Caddy ; Cloudflare renseigne CF-Connecting-IP avec l'IP réelle.
	trustProxy bool
}

type bucket struct {
	hits  []time.Time // timestamps dans la fenêtre (purgés au fil de l'eau)
	fails []time.Time // sous-ensemble : occurrences "échec" (pour FailOnly)
}

// GuardConfig — passé à NewGuard.
type GuardConfig struct {
	Svc        string
	DB         *pgxpool.Pool // base du service — utilisée pour blocked_ips (partagée) et, si Sink==nil, security_events
	Log        *slog.Logger
	Alert      AlertFn     // peut être nil (journal seul)
	Sink       SinkFn      // si fourni, remplace l'écriture locale de security_events (POST vers admin-svc)
	Blocklist  BlocklistFn // si fourni, liste noire partagée lue via admin-svc au lieu de la table locale
	BlockPush  BlockPushFn // si fourni, un blocage local est aussi poussé vers le store partagé
	Rules      []Rule
	TrustProxy bool // true en prod (derrière Cloudflare + Caddy)
}

// activeGuard — un seul guard par process, câblé dans kit.Run via
// UseGuard(). nil = middleware no-op (services qui ne l'activent pas).
var activeGuard *Guard

// UseGuard — enregistre le guard qui sera monté par le prochain
// kit.Run de ce process. À appeler dans main() AVANT kit.Run.
func UseGuard(g *Guard) { activeGuard = g }

func NewGuard(cfg GuardConfig) *Guard {
	g := &Guard{
		svc:        cfg.Svc,
		db:         cfg.DB,
		log:        cfg.Log,
		alert:      cfg.Alert,
		sink:       cfg.Sink,
		blockList:  cfg.Blocklist,
		blockPush:  cfg.BlockPush,
		rules:      cfg.Rules,
		buckets:    map[string]*bucket{},
		blocked:    map[string]time.Time{},
		trustProxy: cfg.TrustProxy,
	}
	// Purge périodique des buckets vides et du cache liste noire.
	go g.janitor()
	return g
}

// DefaultRules — le jeu de règles de l'audit 2026-09-03. Un service
// peut partir de là et retirer/ajuster. Les seuils sont volontairement
// prudents (plutôt alerter que bloquer un client réel).
func DefaultRules() []Rule {
	return []Rule{
		// 1. Balayage d'IDs de commande — GET /orders/* qui renvoie
		//    beaucoup de 404 depuis une même IP.
		On404(MatchHTTP(Rule{
			Name: "order_id_scan", Severity: SevWarn, Action: ActBlock,
			Threshold: 20, Window: time.Minute, BlockFor: 15 * time.Minute,
			Detail: "Balayage d'identifiants de commande (GET /orders/{id} en boucle, majorité de 404)",
		}, "/orders/", http.MethodGet)),

		// 5. Devinette de codes promo — POST /coupons/validate en
		//    rafale. On ne peut pas voir le taux d'échec ici (pas de
		//    status filtré) donc seuil volumétrique simple.
		MatchHTTP(Rule{
			Name: "coupon_bruteforce", Severity: SevWarn, Action: ActBlock,
			Threshold: 30, Window: 5 * time.Minute, BlockFor: 20 * time.Minute,
			Detail: "Devinette de codes promo (POST /coupons/validate en rafale)",
		}, "/coupons/validate", http.MethodPost),

		// 6. Scraping catalogue — throttle, pas blocage dur.
		MatchHTTP(Rule{
			Name: "catalog_scrape", Severity: SevInfo, Action: ActThrottle,
			Threshold: 300, Window: 5 * time.Minute,
			Detail: "Débit anormal sur le catalogue (possible scraping)",
		}, "/products", http.MethodGet),

		// 8. Explosion de 4xx/5xx — une IP qui génère massivement des
		//    erreurs, tous chemins confondus.
		OnStatus(Rule{
			Name: "error_flood", Severity: SevWarn, Action: ActBlock,
			Threshold: 100, Window: 2 * time.Minute, BlockFor: 10 * time.Minute,
			Detail: "Volume anormal de réponses d'erreur depuis une IP",
		}, 400),

		// --- Règles métier : déclenchées par Note() depuis un handler,
		//     pas par le trafic HTTP brut. ---

		// 2. Bourrage d'identifiants — auth-svc appelle
		//    kit.NoteFail(r, "login_bruteforce", email) sur chaque
		//    échec de login (clé = email ; une 2e Note avec l'IP est
		//    faite côté handler pour couvrir les deux axes).
		{
			Name: "login_bruteforce", Severity: SevWarn, Action: ActBlock,
			Threshold: 10, Window: 5 * time.Minute, BlockFor: 30 * time.Minute,
			FailOnly: true,
			Detail:   "Tentatives de connexion répétées en échec (bourrage d'identifiants)",
		},

		// 3. Énumération OTP — auth-svc, clé = msisdn.
		{
			Name: "otp_enumeration", Severity: SevWarn, Action: ActBlock,
			Threshold: 5, Window: 10 * time.Minute, BlockFor: time.Hour,
			FailOnly: true,
			Detail:   "Échecs répétés de vérification OTP pour un même numéro",
		},

		// 4. Test de cartes volées — payment-svc, clé = IP, sur
		//    chaque POST /payments/init.
		MatchHTTP(Rule{
			Name: "card_testing", Severity: SevCritical, Action: ActBlock,
			Threshold: 8, Window: 10 * time.Minute, BlockFor: time.Hour,
			Detail: "Initialisations de paiement en rafale (test de cartes volées)",
		}, "/payments/init", http.MethodPost),

		// 9. Session admin depuis une IP nouvelle — admin-svc appelle
		//    kit.Note(r, "admin_new_ip", accountID) quand
		//    l'IP n'est pas dans l'historique du compte. Seuil 1 =
		//    alerte au premier hit. Pas de blocage (ActAlert).
		{
			Name: "admin_new_ip", Severity: SevCritical, Action: ActAlert,
			Threshold: 1, Window: time.Hour,
			Detail: "Accès à la console admin depuis une adresse IP jamais vue pour ce compte",
		},

		// 10. Pic d'approbations de payouts — payment-svc/admin-svc,
		//     clé = admin account id.
		{
			Name: "payout_burst", Severity: SevCritical, Action: ActAlert,
			Threshold: 5, Window: 10 * time.Minute,
			Detail: "Nombre inhabituel d'approbations de virement en peu de temps",
		},
	}
}

// ---------- Middleware HTTP ----------

// guardMiddleware — monté par kit.Run entre withRecover et withLog.
// No-op si aucun guard actif.
func guardMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g := activeGuard
		if g == nil {
			next.ServeHTTP(w, r)
			return
		}
		ip := g.clientIP(r)

		// 1) Liste noire : refus immédiat.
		if until, blocked := g.isBlocked(ip); blocked {
			g.bumpBlockHit(ip)
			w.Header().Set("Retry-After", "60")
			Fail(w, http.StatusTooManyRequests, "ip_blocked",
				"Trop de requêtes suspectes depuis votre adresse. Réessayez après "+
					until.UTC().Format("15:04")+" UTC.")
			return
		}

		// 2) Laisser passer, mais capturer le status pour les règles
		//    qui en dépendent (404 scan, error flood).
		sw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(sw, r)

		// 3) Évaluer les règles HTTP après la réponse.
		g.evalHTTP(r, ip, sw.status)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusWriter) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status = code
		s.wroteHeader = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if !s.wroteHeader {
		s.wroteHeader = true
	}
	return s.ResponseWriter.Write(b)
}

// Flush passe au travers si le writer sous-jacent le supporte (SSE,
// streaming) — sinon no-op.
func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// ---------- Évaluation des règles ----------

func (g *Guard) evalHTTP(r *http.Request, ip string, status int) {
	for i := range g.rules {
		rule := &g.rules[i]
		m := rule.httpMatch
		if m == nil {
			continue // règle métier : pas déclenchée par le trafic HTTP
		}
		if len(m.methods) > 0 && !m.methods[r.Method] {
			continue
		}
		if m.pathExact != "" && r.URL.Path != m.pathExact {
			continue
		}
		if m.pathPrefix != "" && !strings.HasPrefix(r.URL.Path, m.pathPrefix) {
			continue
		}
		if m.statusIs404 && status != http.StatusNotFound {
			continue
		}
		if m.minStatus > 0 && status < m.minStatus {
			continue
		}
		g.hit(rule, ip, subjectForHTTP(rule, r), r.Method, r.URL.Path, false)
	}
}

// subjectForHTTP — pour une règle HTTP on n'a pas de "sujet" métier ;
// on met l'IP pour que le journal reste lisible.
func subjectForHTTP(_ *Rule, _ *http.Request) string { return "" }

// Note — à appeler depuis un handler pour une règle métier. key est
// l'axe de comptage (email, msisdn, account id…). Cherche la règle
// par nom ; no-op si inconnue ou si aucun guard actif.
func Note(r *http.Request, ruleName, key string) { note(r, ruleName, key, false) }

// NoteFail — comme Note mais marque l'occurrence comme un échec
// (compte pour les règles FailOnly : login, OTP).
func NoteFail(r *http.Request, ruleName, key string) { note(r, ruleName, key, true) }

func note(r *http.Request, ruleName, key string, failed bool) {
	g := activeGuard
	if g == nil {
		return
	}
	for i := range g.rules {
		if g.rules[i].Name != ruleName {
			continue
		}
		rule := &g.rules[i]
		ip := g.clientIP(r)
		countKey := key
		if countKey == "" {
			countKey = ip
		}
		method, path := "", ""
		if r != nil {
			method, path = r.Method, r.URL.Path
		}
		g.hitKey(rule, ip, countKey, key, method, path, failed)
		return
	}
}

// hit — incrémente pour une règle HTTP (clé = IP).
func (g *Guard) hit(rule *Rule, ip, subject, method, path string, failed bool) {
	g.hitKey(rule, ip, ip, subject, method, path, failed)
}

// hitKey — cœur du compteur : ajoute un tick, purge la fenêtre,
// déclenche si le seuil est atteint.
func (g *Guard) hitKey(rule *Rule, ip, countKey, subject, method, path string, failed bool) {
	now := time.Now()
	bkey := rule.Name + "|" + countKey

	g.mu.Lock()
	b := g.buckets[bkey]
	if b == nil {
		b = &bucket{}
		g.buckets[bkey] = b
	}
	cutoff := now.Add(-rule.Window)
	b.hits = appendWithin(b.hits, now, cutoff)
	if failed {
		b.fails = appendWithin(b.fails, now, cutoff)
	} else {
		b.fails = pruneBefore(b.fails, cutoff)
	}
	var count int
	if rule.FailOnly {
		count = len(b.fails)
	} else {
		count = len(b.hits)
	}
	triggered := count >= rule.Threshold
	if triggered {
		// Reset le bucket pour ne pas re-déclencher à chaque requête
		// suivante tant qu'on est au-dessus du seuil (une alerte par
		// fenêtre, pas une par requête).
		b.hits = nil
		b.fails = nil
	}
	g.mu.Unlock()

	if !triggered {
		return
	}

	ev := Event{
		Svc: g.svc, Rule: rule.Name, Severity: rule.Severity, Action: rule.Action,
		IP: ip, Subject: subject, Method: method, Path: path,
		Count: count, WindowSec: int(rule.Window.Seconds()), Detail: rule.Detail,
	}

	g.log.Warn("guard: règle déclenchée",
		"rule", rule.Name, "action", rule.Action, "severity", rule.Severity,
		"ip", ip, "subject", subject, "count", count,
		"window_sec", ev.WindowSec, "path", path)

	// Persistance + blocage + alerte, hors du verrou, sans bloquer
	// la requête courante.
	go g.handleTrigger(rule, ev)
}

func (g *Guard) handleTrigger(rule *Rule, ev Event) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	switch {
	case g.sink != nil:
		// Persistance déléguée (POST vers admin-svc). Protégée contre
		// une panique de l'implémentation fournie par le service.
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					g.log.Error("guard: panique dans SinkFn", "rec", rec, "rule", ev.Rule)
				}
			}()
			g.sink(ev)
		}()
	case g.db != nil:
		if _, err := g.db.Exec(ctx, `
			INSERT INTO security_events
			  (svc, rule, severity, action, ip, subject, method, path, count, window_sec, detail)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
			ev.Svc, ev.Rule, string(ev.Severity), string(ev.Action),
			ev.IP, ev.Subject, ev.Method, ev.Path, ev.Count, ev.WindowSec, ev.Detail,
		); err != nil {
			g.log.Error("guard: échec écriture security_events", "err", err, "rule", ev.Rule)
		}
	}

	if rule.Action == ActBlock && ev.IP != "" {
		g.blockIP(ctx, ev.IP, rule)
	}

	if g.alert != nil {
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					g.log.Error("guard: panique dans AlertFn", "rec", rec, "rule", ev.Rule)
				}
			}()
			g.alert(ev)
		}()
	}
}

func (g *Guard) blockIP(ctx context.Context, ip string, rule *Rule) {
	expires := time.Now().Add(rule.BlockFor)
	switch {
	case g.blockPush != nil:
		if err := g.blockPush(ctx, ip, rule.Name, rule.Detail, expires); err != nil {
			g.log.Error("guard: échec push blocage partagé", "err", err, "ip", ip)
		}
	case g.db != nil:
		if _, err := g.db.Exec(ctx, `
			INSERT INTO blocked_ips (ip, expires_at, rule, reason)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (ip) DO UPDATE SET
			  expires_at = GREATEST(blocked_ips.expires_at, EXCLUDED.expires_at),
			  rule = EXCLUDED.rule, reason = EXCLUDED.reason`,
			ip, expires, rule.Name, rule.Detail,
		); err != nil {
			g.log.Error("guard: échec écriture blocked_ips", "err", err, "ip", ip)
		}
	}
	g.blkMu.Lock()
	g.blocked[ip] = expires
	g.blkMu.Unlock()
	g.log.Warn("guard: IP bloquée", "ip", ip, "rule", rule.Name,
		"until", expires.UTC().Format(time.RFC3339))
}

// ---------- Liste noire (cache + Postgres) ----------

func (g *Guard) isBlocked(ip string) (time.Time, bool) {
	if ip == "" {
		return time.Time{}, false
	}
	g.blkMu.RLock()
	exp, ok := g.blocked[ip]
	fresh := time.Now().Before(g.blockedExp)
	g.blkMu.RUnlock()

	if ok && time.Now().Before(exp) {
		return exp, true
	}
	if fresh {
		// Cache à jour et l'IP n'y est pas (ou a expiré) → pas bloquée.
		return time.Time{}, false
	}
	// Cache périmé : recharge depuis Postgres.
	g.refreshBlocked()
	g.blkMu.RLock()
	exp, ok = g.blocked[ip]
	g.blkMu.RUnlock()
	if ok && time.Now().Before(exp) {
		return exp, true
	}
	return time.Time{}, false
}

func (g *Guard) refreshBlocked() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	var next map[string]time.Time
	switch {
	case g.blockList != nil:
		m, err := g.blockList(ctx)
		if err != nil {
			g.log.Error("guard: échec lecture liste noire partagée", "err", err)
			return
		}
		next = m
	case g.db != nil:
		rows, err := g.db.Query(ctx,
			`SELECT ip, expires_at FROM blocked_ips WHERE expires_at > now()`)
		if err != nil {
			g.log.Error("guard: échec rechargement blocked_ips", "err", err)
			return
		}
		defer rows.Close()
		next = map[string]time.Time{}
		for rows.Next() {
			var ip string
			var exp time.Time
			if err := rows.Scan(&ip, &exp); err == nil {
				next[ip] = exp
			}
		}
	default:
		next = map[string]time.Time{}
	}

	g.blkMu.Lock()
	g.blocked = next
	g.blockedExp = time.Now().Add(30 * time.Second)
	g.blkMu.Unlock()
}

func (g *Guard) bumpBlockHit(ip string) {
	if g.db == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, _ = g.db.Exec(ctx,
			`UPDATE blocked_ips SET hits = hits + 1 WHERE ip = $1`, ip)
	}()
}

// ---------- Utilitaires ----------

func (g *Guard) clientIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	if g.trustProxy {
		// Cloudflare pose l'IP réelle du visiteur ici.
		if cf := r.Header.Get("CF-Connecting-IP"); cf != "" {
			return strings.TrimSpace(cf)
		}
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			// Premier élément = client d'origine.
			if i := strings.IndexByte(xff, ','); i > 0 {
				return strings.TrimSpace(xff[:i])
			}
			return strings.TrimSpace(xff)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func appendWithin(ts []time.Time, now, cutoff time.Time) []time.Time {
	ts = pruneBefore(ts, cutoff)
	return append(ts, now)
}

func pruneBefore(ts []time.Time, cutoff time.Time) []time.Time {
	i := 0
	for i < len(ts) && ts[i].Before(cutoff) {
		i++
	}
	if i == 0 {
		return ts
	}
	return append(ts[:0], ts[i:]...)
}

func (g *Guard) janitor() {
	t := time.NewTicker(2 * time.Minute)
	defer t.Stop()
	for range t.C {
		now := time.Now()
		var maxWindow time.Duration
		for i := range g.rules {
			if g.rules[i].Window > maxWindow {
				maxWindow = g.rules[i].Window
			}
		}
		cutoff := now.Add(-maxWindow)
		g.mu.Lock()
		for k, b := range g.buckets {
			b.hits = pruneBefore(b.hits, cutoff)
			b.fails = pruneBefore(b.fails, cutoff)
			if len(b.hits) == 0 && len(b.fails) == 0 {
				delete(g.buckets, k)
			}
		}
		g.mu.Unlock()

		// Force un rechargement de la liste noire au prochain accès.
		g.blkMu.Lock()
		g.blockedExp = time.Time{}
		g.blkMu.Unlock()
	}
}

// ---------- API pour la console admin (lecture / déblocage manuel) ----------

// SecurityEventRow — une ligne de journal renvoyée à la console.
type SecurityEventRow struct {
	ID        int64     `json:"id"`
	CreatedAt time.Time `json:"created_at"`
	Svc       string    `json:"svc"`
	Rule      string    `json:"rule"`
	Severity  string    `json:"severity"`
	Action    string    `json:"action"`
	IP        string    `json:"ip"`
	Subject   string    `json:"subject"`
	Method    string    `json:"method"`
	Path      string    `json:"path"`
	Count     int       `json:"count"`
	WindowSec int       `json:"window_sec"`
	Detail    string    `json:"detail"`
}

// BlockedIPRow — une IP actuellement (ou récemment) bloquée.
type BlockedIPRow struct {
	IP        string    `json:"ip"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	Rule      string    `json:"rule"`
	Reason    string    `json:"reason"`
	Hits      int       `json:"hits"`
	Manual    bool      `json:"manual"`
	Active    bool      `json:"active"`
}

// RecentEvents — les n derniers événements (pour GET .../security/events).
func (g *Guard) RecentEvents(ctx context.Context, limit int) ([]SecurityEventRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := g.db.Query(ctx, `
		SELECT id, created_at, svc, rule, severity, action, ip, subject,
		       method, path, count, window_sec, detail
		FROM security_events ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SecurityEventRow{}
	for rows.Next() {
		var e SecurityEventRow
		if err := rows.Scan(&e.ID, &e.CreatedAt, &e.Svc, &e.Rule, &e.Severity,
			&e.Action, &e.IP, &e.Subject, &e.Method, &e.Path, &e.Count,
			&e.WindowSec, &e.Detail); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ListBlocked — IP bloquées (actives + expirées des dernières 24 h).
func (g *Guard) ListBlocked(ctx context.Context) ([]BlockedIPRow, error) {
	rows, err := g.db.Query(ctx, `
		SELECT ip, created_at, expires_at, rule, reason, hits, manual
		FROM blocked_ips
		WHERE expires_at > now() - interval '24 hours'
		ORDER BY expires_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	now := time.Now()
	out := []BlockedIPRow{}
	for rows.Next() {
		var b BlockedIPRow
		if err := rows.Scan(&b.IP, &b.CreatedAt, &b.ExpiresAt, &b.Rule,
			&b.Reason, &b.Hits, &b.Manual); err != nil {
			return nil, err
		}
		b.Active = b.ExpiresAt.After(now)
		out = append(out, b)
	}
	return out, rows.Err()
}

// Unblock — déblocage manuel depuis la console (POST .../unblock).
func (g *Guard) Unblock(ctx context.Context, ip string) error {
	if _, err := g.db.Exec(ctx, `DELETE FROM blocked_ips WHERE ip = $1`, ip); err != nil {
		return err
	}
	g.blkMu.Lock()
	delete(g.blocked, ip)
	g.blkMu.Unlock()
	g.log.Warn("guard: IP débloquée manuellement", "ip", ip)
	return nil
}

// BlockManual — blocage manuel depuis la console (POST .../block).
func (g *Guard) BlockManual(ctx context.Context, ip, reason string, d time.Duration) error {
	expires := time.Now().Add(d)
	if _, err := g.db.Exec(ctx, `
		INSERT INTO blocked_ips (ip, expires_at, rule, reason, manual)
		VALUES ($1,$2,'manual',$3,true)
		ON CONFLICT (ip) DO UPDATE SET
		  expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason, manual = true`,
		ip, expires, reason); err != nil {
		return err
	}
	g.blkMu.Lock()
	g.blocked[ip] = expires
	g.blkMu.Unlock()
	g.log.Warn("guard: IP bloquée manuellement", "ip", ip, "until", expires.UTC().Format(time.RFC3339))
	return nil
}

// ---------- Câblage "service satellite" (auth-svc, payment-svc, …) ----------

// RemoteGuardHooks — construit Sink / Blocklist / BlockPush qui parlent
// à admin-svc via ses endpoints /internal/security-*. À utiliser par
// tout service AUTRE qu'admin-svc pour que son guard partage le même
// journal et la même liste noire. adminURL = http://admin-svc:8088 en
// interne k8s ; secret = INTERNAL_API_SECRET (identique partout).
func RemoteGuardHooks(adminURL, secret string) (SinkFn, BlocklistFn, BlockPushFn) {
	client := &http.Client{Timeout: 5 * time.Second}
	base := strings.TrimRight(adminURL, "/")

	post := func(ctx context.Context, path string, body any) error {
		b, _ := json.Marshal(body)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, bytes.NewReader(b))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		if secret != "" {
			req.Header.Set("X-Internal-Secret", secret)
		}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 300 {
			return fmt.Errorf("admin-svc %s → HTTP %d", path, resp.StatusCode)
		}
		return nil
	}

	sink := func(ev Event) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := post(ctx, "/internal/security-events", ev); err != nil {
			slog.Error("guard: échec envoi event à admin-svc", "err", err, "rule", ev.Rule)
		}
	}

	blockPush := func(ctx context.Context, ip, rule, reason string, until time.Time) error {
		return post(ctx, "/internal/security-block", map[string]any{
			"ip": ip, "rule": rule, "reason": reason, "until": until.UTC().Format(time.RFC3339),
		})
	}

	blockList := func(ctx context.Context) (map[string]time.Time, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/internal/security-blocks", nil)
		if err != nil {
			return nil, err
		}
		if secret != "" {
			req.Header.Set("X-Internal-Secret", secret)
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 300 {
			return nil, fmt.Errorf("admin-svc /internal/security-blocks → HTTP %d", resp.StatusCode)
		}
		raw := map[string]string{}
		if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
			return nil, err
		}
		out := map[string]time.Time{}
		for ip, s := range raw {
			if t, err := time.Parse(time.RFC3339, s); err == nil {
				out[ip] = t
			}
		}
		return out, nil
	}

	return sink, blockList, blockPush
}

"use client"

import { useEffect, useRef, useState } from 'react'
import { BarChart2, RefreshCw, TrendingDown, Search, Eye, Globe2, Radio, AlertTriangle, Clock, XCircle, X } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type FunnelStepKey = 'product_view' | 'add_to_cart' | 'checkout_start' | 'payment_attempt' | 'checkout_complete'

interface SummaryData {
  days: number
  funnel: Record<FunnelStepKey, number>
  avgSecondsBetweenSteps: Record<string, number | null>
  paymentFailures: { reason: string; count: number }[]
  topSearches: { query: string; count: number }[]
  topProducts: { product_id: number; views: number }[]
  trafficSources: Record<string, number>
  activeNow: number
  dailyPageViews: { date: string; count: number }[]
}

interface StuckSession {
  session_id: string
  event_type: string
  checkout_step_number: number | null
  cart_value: string | null
  created_at: string
}

interface SessionEvent {
  event_type: string
  product_id: number | null
  search_query: string | null
  path: string | null
  checkout_step_number: number | null
  payment_failure_reason: string | null
  device_type: string | null
  cart_value: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

const FUNNEL_STEPS: { key: FunnelStepKey; label: string }[] = [
  { key: 'product_view', label: 'Vue produit' },
  { key: 'add_to_cart', label: 'Ajout panier' },
  { key: 'checkout_start', label: 'Début checkout' },
  { key: 'payment_attempt', label: 'Tentative paiement' },
  { key: 'checkout_complete', label: 'Paiement terminé' },
]

// Un pas de l'entonnoir avec une chute de plus de la moitié des sessions
// mérite d'être vu immédiatement, pas noyé dans une liste de chiffres.
const DROPOFF_ALERT_THRESHOLD = 0.5

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${(seconds / 3600).toFixed(1)} h`
}

const EVENT_LABELS: Record<string, string> = {
  page_view: 'Page vue',
  product_view: 'Produit consulté',
  search: 'Recherche',
  add_to_cart: 'Ajout au panier',
  remove_from_cart: 'Retrait du panier',
  checkout_start: 'Début du checkout',
  checkout_step: 'Étape checkout',
  checkout_complete: 'Commande terminée',
  payment_attempt: 'Tentative de paiement',
  payment_failed: 'Paiement échoué',
  payment_success: 'Paiement réussi',
  cart_abandoned: 'Panier abandonné',
}

const FUNNEL_CHART_CONFIG: ChartConfig = {
  count: { label: 'Sessions', color: 'var(--accent)' },
}

const TRAFFIC_CHART_CONFIG: ChartConfig = {
  count: { label: 'Vues de page', color: 'var(--accent)' },
}

// Fenêtre courte (5 min), sans websocket — juste un polling léger pour donner
// une impression de suivi en direct sans complexité d'infrastructure.
const ACTIVE_NOW_POLL_MS = 20000

export function AnalyticsDashboard() {
  const [data, setData] = useState<SummaryData | null>(null)
  const [productNames, setProductNames] = useState<Record<number, string>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(7)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [stuckSessions, setStuckSessions] = useState<StuckSession[] | null>(null)
  const [stuckLoading, setStuckLoading] = useState(false)
  const [stuckError, setStuckError] = useState<string | null>(null)
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [sessionEvents, setSessionEvents] = useState<SessionEvent[] | null>(null)
  const [sessionMeta, setSessionMeta] = useState<{ durationSeconds: number | null; country: string | null } | null>(null)
  const [sessionLoading, setSessionLoading] = useState(false)

  const fetchSummary = async (rangeDays: number, silent = false) => {
    if (!silent) setIsLoading(true)
    if (!silent) setError(null)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch(`/api/analytics/summary?days=${rangeDays}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      })
      if (!res.ok) {
        throw new Error(`Erreur ${res.status}`)
      }
      const json: any = await res.json()
      if (json?.error) {
        const detail = [json.error, json.wpStatus && `(WP ${json.wpStatus})`, json.wpBody]
          .filter(Boolean)
          .join(' ')
        throw new Error(detail)
      }
      setData(json as SummaryData)

      // Résout les noms des produits les plus vus (l'endpoint ne renvoie que des IDs)
      const ids = json.topProducts.map((p: any) => p.product_id).slice(0, 10)
      const results = await Promise.all(
        ids.map((id: number) => fetch(`/api/products?id=${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null))
      )
      const names: Record<number, string> = {}
      results.forEach((r, i) => {
        const name = r?.products?.[0]?.name || r?.name
        if (name) names[ids[i]] = name
      })
      setProductNames(names)
    } catch (e) {
      if (!silent) setError(e instanceof Error && e.message ? e.message : 'Impossible de charger les statistiques.')
    } finally {
      if (!silent) setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchSummary(days)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days])

  // Rafraîchit juste "visiteurs actifs maintenant" en tâche de fond, sans
  // recharger tout le tableau (silent=true : pas de spinner, pas d'erreur affichée).
  useEffect(() => {
    pollRef.current = setInterval(() => fetchSummary(days, true), ACTIVE_NOW_POLL_MS)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days])

  const fetchStuckSessions = async () => {
    setStuckLoading(true)
    setStuckError(null)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch('/api/analytics/stuck-sessions', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      })
      const json: any = await res.json()
      if (json?.error) throw new Error(json.error)
      setStuckSessions(json.sessions || [])
    } catch (e) {
      setStuckError(e instanceof Error && e.message ? e.message : 'Impossible de charger les sessions bloquées.')
    } finally {
      setStuckLoading(false)
    }
  }

  const openSessionTimeline = async (sessionId: string) => {
    setSelectedSession(sessionId)
    setSessionEvents(null)
    setSessionMeta(null)
    setSessionLoading(true)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch(`/api/analytics/session/${encodeURIComponent(sessionId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      })
      const json: any = await res.json()
      setSessionEvents(json?.events || [])
      setSessionMeta({ durationSeconds: json?.durationSeconds ?? null, country: json?.country ?? null })
    } catch {
      setSessionEvents([])
    } finally {
      setSessionLoading(false)
    }
  }

  function fmtDuration(seconds: number | null): string {
    if (seconds == null) return '—'
    if (seconds < 60) return `${seconds}s`
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}min${s ? ` ${s}s` : ''}`
  }

  const funnelChartData = FUNNEL_STEPS.map((step) => ({
    step: step.label,
    count: data?.funnel[step.key] || 0,
  }))

  // Taux de conversion (vs l'étape précédente) et alerte visuelle si plus de
  // la moitié des sessions décrochent entre deux étapes consécutives.
  const funnelWithDropoff = FUNNEL_STEPS.map((step, i) => {
    const count = data?.funnel[step.key] || 0
    const prevCount = i > 0 ? (data?.funnel[FUNNEL_STEPS[i - 1].key] || 0) : null
    const conversionRate = prevCount && prevCount > 0 ? count / prevCount : null
    const secondsFromPrev = i > 0 ? data?.avgSecondsBetweenSteps?.[`${FUNNEL_STEPS[i - 1].key}_to_${step.key}`] ?? null : null
    return {
      ...step,
      count,
      conversionRate,
      isAlert: conversionRate !== null && conversionRate < (1 - DROPOFF_ALERT_THRESHOLD),
      secondsFromPrev,
    }
  })

  const trafficChartData = (data?.dailyPageViews || []).map((d) => ({
    date: new Date(d.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }),
    count: d.count,
  }))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="flex gap-2">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-widest transition-colors ${
                  days === d ? 'bg-primary text-white' : 'bg-muted text-muted-foreground hover:bg-muted/70'
                }`}
              >
                {d}j
              </button>
            ))}
          </div>
          {data && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700">
              <Radio size={14} className="animate-pulse" />
              <span className="text-xs font-black">{data.activeNow} actif{data.activeNow > 1 ? 's' : ''} maintenant</span>
            </div>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchSummary(days)} disabled={isLoading} className="gap-2">
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} /> Actualiser
        </Button>
      </div>

      {isLoading && !data && (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <RefreshCw size={20} className="animate-spin mr-3" /> Chargement des statistiques…
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {data && (
        <>
          {/* Tendance des visites */}
          {trafficChartData.length > 1 && (
            <div>
              <h3 className="font-bold mb-4 flex items-center gap-2 text-sm uppercase tracking-widest text-muted-foreground">
                <Globe2 size={16} /> Visites par jour ({data.days} derniers jours)
              </h3>
              <ChartContainer config={TRAFFIC_CHART_CONFIG} className="h-56 w-full">
                <LineChart data={trafficChartData}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis tickLine={false} axisLine={false} fontSize={11} width={28} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Line type="monotone" dataKey="count" stroke="var(--color-count)" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            </div>
          )}

          {/* Entonnoir d'achat */}
          <div>
            <h3 className="font-bold mb-4 flex items-center gap-2 text-sm uppercase tracking-widest text-muted-foreground">
              <TrendingDown size={16} /> Entonnoir d'achat ({data.days} derniers jours)
            </h3>
            <ChartContainer config={FUNNEL_CHART_CONFIG} className="h-56 w-full">
              <BarChart data={funnelChartData} layout="vertical" margin={{ left: 8 }}>
                <CartesianGrid horizontal={false} />
                <XAxis type="number" tickLine={false} axisLine={false} fontSize={11} allowDecimals={false} />
                <YAxis type="category" dataKey="step" tickLine={false} axisLine={false} fontSize={11} width={110} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={4} />
              </BarChart>
            </ChartContainer>

            {/* Conversion/chute + temps moyen entre chaque étape — la vue
                agrégée ne montre que des volumes, pas où ni combien de temps
                ça bloque. */}
            <ul className="mt-3 space-y-1.5">
              {funnelWithDropoff.slice(1).map((step) => (
                <li
                  key={step.key}
                  className={`flex items-center justify-between text-xs px-3 py-2 rounded-lg ${
                    step.isAlert ? 'bg-destructive/10 text-destructive font-bold' : 'text-muted-foreground'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    {step.isAlert && <AlertTriangle size={12} />}
                    → {step.label}
                  </span>
                  <span className="flex items-center gap-3 shrink-0">
                    {step.secondsFromPrev !== null && step.secondsFromPrev !== undefined && (
                      <span className="flex items-center gap-1"><Clock size={11} /> {formatDuration(step.secondsFromPrev)}</span>
                    )}
                    <span>{step.conversionRate !== null ? `${Math.round(step.conversionRate * 100)}% converti` : '—'}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Échecs de paiement */}
          {data.paymentFailures.length > 0 && (
            <div>
              <h3 className="font-bold mb-3 flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
                <XCircle size={14} /> Raisons d'échec de paiement
              </h3>
              <ul className="space-y-1.5">
                {data.paymentFailures.slice(0, 10).map((f) => (
                  <li key={f.reason} className="flex justify-between text-xs">
                    <span className="truncate">{f.reason}</span>
                    <span className="font-bold text-muted-foreground shrink-0 ml-2">{f.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Sessions bloquées — drill-down vers le parcours individuel */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
                <AlertTriangle size={14} /> Sessions bloquées
              </h3>
              <Button variant="outline" size="sm" onClick={fetchStuckSessions} disabled={stuckLoading} className="gap-2 h-8 text-xs">
                <RefreshCw size={12} className={stuckLoading ? 'animate-spin' : ''} /> Vérifier
              </Button>
            </div>
            {stuckError && <p className="text-xs text-destructive">{stuckError}</p>}
            {stuckSessions === null && !stuckLoading && !stuckError && (
              <p className="text-xs text-muted-foreground">Clique sur "Vérifier" pour lister les sessions arrêtées en plein checkout depuis plus de 30 min.</p>
            )}
            {stuckSessions !== null && stuckSessions.length === 0 && (
              <p className="text-xs text-muted-foreground">Aucune session bloquée pour l'instant.</p>
            )}
            {stuckSessions !== null && stuckSessions.length > 0 && (
              <ul className="space-y-1.5">
                {stuckSessions.map((s) => (
                  <li key={s.session_id}>
                    <button
                      type="button"
                      onClick={() => openSessionTimeline(s.session_id)}
                      className="w-full flex items-center justify-between text-xs px-3 py-2 rounded-lg bg-muted/40 hover:bg-muted transition-colors text-left"
                    >
                      <span className="truncate font-mono">{s.session_id.slice(0, 12)}…</span>
                      <span className="flex items-center gap-3 shrink-0 text-muted-foreground">
                        <span>{EVENT_LABELS[s.event_type] || s.event_type}</span>
                        {s.cart_value && <span className="font-bold">{s.cart_value} $</span>}
                        <span>{new Date(s.created_at + 'Z').toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Recherches populaires */}
            <div>
              <h3 className="font-bold mb-3 flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
                <Search size={14} /> Recherches populaires
              </h3>
              {data.topSearches.length === 0 ? (
                <p className="text-xs text-muted-foreground">Aucune recherche enregistrée.</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.topSearches.slice(0, 10).map((s) => (
                    <li key={s.query} className="flex justify-between text-xs">
                      <span className="truncate">{s.query}</span>
                      <span className="font-bold text-muted-foreground shrink-0 ml-2">{s.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Produits les plus vus */}
            <div>
              <h3 className="font-bold mb-3 flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
                <Eye size={14} /> Produits les plus vus
              </h3>
              {data.topProducts.length === 0 ? (
                <p className="text-xs text-muted-foreground">Aucune vue enregistrée.</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.topProducts.slice(0, 10).map((p) => (
                    <li key={p.product_id} className="flex justify-between text-xs">
                      <span className="truncate">{productNames[p.product_id] || `Produit #${p.product_id}`}</span>
                      <span className="font-bold text-muted-foreground shrink-0 ml-2">{p.views}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Origine du trafic */}
            <div>
              <h3 className="font-bold mb-3 flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
                <Globe2 size={14} /> Origine du trafic
              </h3>
              {Object.keys(data.trafficSources).length === 0 ? (
                <p className="text-xs text-muted-foreground">Aucune donnée.</p>
              ) : (
                <ul className="space-y-1.5">
                  {Object.entries(data.trafficSources).map(([source, count]) => (
                    <li key={source} className="flex justify-between text-xs">
                      <span className="truncate">{source === 'direct' ? 'Direct' : source}</span>
                      <span className="font-bold text-muted-foreground shrink-0 ml-2">{count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}

      {/* Parcours individuel — timeline chronologique de la session choisie */}
      <Dialog open={selectedSession !== null} onOpenChange={(open) => { if (!open) { setSelectedSession(null); setSessionEvents(null) } }}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{selectedSession?.slice(0, 16)}…</DialogTitle>
          </DialogHeader>
          {!sessionLoading && sessionMeta && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground -mt-2 mb-1">
              <span className="flex items-center gap-1"><Clock size={12} /> {fmtDuration(sessionMeta.durationSeconds)}</span>
              {sessionMeta.country && <span className="flex items-center gap-1"><Globe2 size={12} /> {sessionMeta.country}</span>}
            </div>
          )}
          {sessionLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <RefreshCw size={18} className="animate-spin mr-2" /> Chargement…
            </div>
          ) : sessionEvents && sessionEvents.length > 0 ? (
            <ol className="space-y-3 border-l-2 border-border ml-2">
              {sessionEvents.map((e) => {
                const cart = (e.metadata?.cart as { id: number; name: string; qty: number; price?: string }[] | undefined)
                const added = e.metadata?.added as { name: string; qty: number } | undefined
                const removed = e.metadata?.removed as { name: string; qty: number } | undefined
                return (
                  <li key={`${e.created_at}-${e.event_type}`} className="pl-4 relative">
                    <span className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-accent" />
                    <p className="text-sm font-bold">{EVENT_LABELS[e.event_type] || e.event_type}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(e.created_at + 'Z').toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </p>
                    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      {e.product_id && <p>Produit #{e.product_id}</p>}
                      {e.search_query && <p>Recherche : "{e.search_query}"</p>}
                      {e.checkout_step_number != null && <p>Étape checkout #{e.checkout_step_number}</p>}
                      {e.payment_failure_reason && <p className="text-destructive">Raison : {e.payment_failure_reason}</p>}
                      {e.cart_value && <p>Valeur panier : {e.cart_value} $</p>}
                      {e.device_type && <p>Appareil : {e.device_type}</p>}
                      {e.path && <p className="truncate">Page : {e.path}</p>}
                      {added && <p>Ajouté : {added.name} × {added.qty}</p>}
                      {removed && <p>Retiré : {removed.name} × {removed.qty}</p>}
                      {cart && cart.length > 0 && (
                        <div className="mt-1 p-2 bg-muted/40 rounded-lg">
                          <p className="font-bold text-[10px] uppercase mb-1">Panier à ce moment</p>
                          {cart.map((item, i) => (
                            <p key={i}>{item.name} × {item.qty}{item.price ? ` — ${item.price} $` : ''}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground py-6 text-center">Aucun événement trouvé pour cette session.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

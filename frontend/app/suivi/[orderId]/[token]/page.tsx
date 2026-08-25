import Link from 'next/link'
import { headers } from 'next/headers'
import { PackageX, CheckCircle2, MapPin } from 'lucide-react'
import { ScanCheckpointButton } from '@/components/miad/ScanCheckpointButton'

export const runtime = 'edge'

// GAP BACKEND CONNU (voir app/api/order-tracking/route.ts pour le détail
// complet) : aucun service Go n'expose encore de suivi de commande par
// token public — cette page appelait avant l'ancienne URL WordPress
// directement (morte depuis la migration). Passe maintenant par la route
// Next.js intermédiaire, qui renvoie explicitement { ok: false } tant que
// ce mécanisme n'existe pas côté Go, plutôt que d'appeler un backend mort.

interface TrackingData {
  ok?: boolean
  error?: string
  order_number?: string
  status?: string
  delivery_stage?: string
  stage_label?: string | null
  shipping_method?: string
  tracking_number?: string
  dhl_status?: string
  dhl_events?: { timestamp: string; description: string; location: string }[]
  total?: string
  date?: string
  client_name?: string
  items?: { name: string; quantity: number }[]
  scan_checkpoints?: { timestamp: string; lat: number; lng: number; address: string }[]
}

const DELIVERY_STAGE_ORDER = ['vendor_confirmed', 'rep_received', 'local_pickup', 'intl_handoff', 'delivered']
const DELIVERY_STEPS = [
  { label: 'Payé', short: '💳' },
  { label: 'Vendeur', short: '✅' },
  { label: 'Collecte', short: '📥' },
  { label: 'Locale', short: '🚚' },
  { label: 'Intl.', short: '✈️' },
  { label: 'Livré', short: '🎉' },
]

async function fetchTracking(orderId: string, token: string): Promise<TrackingData> {
  try {
    const h = await headers()
    const origin = h.get('origin') || `https://${h.get('host')}`
    const res = await fetch(
      `${origin}/api/order-tracking?order_id=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' }
    )
    return await res.json()
  } catch {
    return { error: 'Serveur indisponible' }
  }
}

export default async function OrderTrackingPage({
  params,
}: {
  params: Promise<{ orderId: string; token: string }>
}) {
  const { orderId, token } = await params
  const data = await fetchTracking(orderId, token)

  if (!data.ok) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-muted/20 px-4">
        <div className="max-w-sm w-full text-center bg-card border border-border rounded-2xl p-8 shadow-sm">
          <PackageX size={40} className="mx-auto text-muted-foreground/40 mb-4" />
          <h1 className="font-black text-lg mb-2">Lien de suivi invalide</h1>
          <p className="text-sm text-muted-foreground mb-6">
            {data.error || "Ce lien n'est plus valide ou la commande est introuvable."}
          </p>
          <Link href="/" className="inline-block px-5 py-2.5 rounded-full bg-primary text-white text-sm font-black">
            Retour à l&apos;accueil
          </Link>
        </div>
      </main>
    )
  }

  let currentStep = 0
  if (data.status === 'completed') {
    currentStep = DELIVERY_STEPS.length - 1
  } else if (data.delivery_stage) {
    const idx = DELIVERY_STAGE_ORDER.indexOf(data.delivery_stage)
    currentStep = idx >= 0 ? idx + 1 : 0
  }
  const pct = currentStep === 0 ? 0 : Math.round((currentStep / (DELIVERY_STEPS.length - 1)) * 100)
  const isDelivered = currentStep === DELIVERY_STEPS.length - 1

  return (
    <main className="min-h-screen bg-muted/20 py-10 px-4">
      <div className="max-w-md mx-auto space-y-5">
        <div className="text-center">
          <Link href="/" className="inline-flex items-center gap-1.5 mb-4">
            <span className="text-lg font-black text-primary">MIAD Market</span>
          </Link>
          <h1 className="font-black text-xl">Suivi de commande #{data.order_number}</h1>
          {data.client_name && (
            <p className="text-sm text-muted-foreground mt-1">Bonjour {data.client_name} 👋</p>
          )}
        </div>

        <div className="bg-card border border-border rounded-2xl p-6 shadow-sm">
          {isDelivered && (
            <div className="flex items-center gap-2 text-sm font-bold text-green-700 bg-green-50 rounded-xl px-3 py-2 mb-5">
              <CheckCircle2 size={16} /> Livré — merci pour votre confiance !
            </div>
          )}

          <div className="relative px-1 mb-2">
            <div className="absolute left-4 right-4 top-4 h-1 bg-border rounded-full" />
            <div
              className="absolute left-4 top-4 h-1 bg-accent rounded-full transition-all duration-700"
              style={{ width: `calc(${pct}% - 2rem)` }}
            />
            <div className="relative flex justify-between">
              {DELIVERY_STEPS.map((step, i) => {
                const done = i <= currentStep
                const active = i === currentStep
                return (
                  <div key={step.label} className="flex flex-col items-center gap-1">
                    <div
                      className={`w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-black transition-all duration-300
                        ${done ? 'bg-accent border-accent text-white' : 'bg-white border-border text-muted-foreground/40'}
                        ${active ? 'scale-110 shadow-md shadow-accent/30' : ''}`}
                    >
                      {done ? '✓' : step.short}
                    </div>
                    <span className={`text-[10px] font-bold leading-tight text-center max-w-12 ${done ? 'text-foreground' : 'text-muted-foreground/40'}`}>
                      {step.label}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="bg-card border border-border rounded-2xl p-5 shadow-sm space-y-3 text-sm">
          {data.stage_label && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Étape actuelle</span>
              <span className="font-bold">{data.stage_label}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Mode de livraison</span>
            <span className="font-bold">{data.shipping_method}</span>
          </div>
          {data.tracking_number && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">N° de suivi</span>
              <span className="font-bold font-mono">{data.tracking_number}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Total</span>
            <span className="font-black">{data.total}</span>
          </div>
        </div>

        {!!data.dhl_events?.length && (
          <div className="bg-card border border-border rounded-2xl p-5 shadow-sm">
            <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-1">Suivi transporteur (DHL)</p>
            {data.dhl_status && <p className="text-sm font-bold mb-3">{data.dhl_status}</p>}
            <ul className="space-y-3 text-sm">
              {data.dhl_events.map((event) => (
                <li key={event.timestamp + event.description} className="border-l-2 border-accent/30 pl-3">
                  <p className="font-semibold">{event.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {event.timestamp ? new Date(event.timestamp).toLocaleString('fr-FR') : ''}
                    {event.location ? ` — ${event.location}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="bg-card border border-border rounded-2xl p-5 shadow-sm space-y-4">
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-1">Points de passage</p>
            <p className="text-xs text-muted-foreground">
              À chaque étape (vendeur, représentant, transporteur), la personne qui a le colis scanne ce lien pour confirmer sa position.
            </p>
          </div>
          {!isDelivered && <ScanCheckpointButton orderId={orderId} token={token} />}
          {!!data.scan_checkpoints?.length && (
            <ul className="space-y-3 text-sm">
              {[...data.scan_checkpoints].reverse().map((cp, i) => (
                <li key={cp.timestamp + i} className="border-l-2 border-accent/30 pl-3 flex gap-2">
                  <MapPin size={14} className="text-accent shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">{cp.address || `${cp.lat.toFixed(4)}, ${cp.lng.toFixed(4)}`}</p>
                    <p className="text-xs text-muted-foreground">
                      {cp.timestamp ? new Date(cp.timestamp + 'Z').toLocaleString('fr-FR') : ''}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {!!data.items?.length && (
          <div className="bg-card border border-border rounded-2xl p-5 shadow-sm">
            <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3">Produits</p>
            <ul className="space-y-1.5 text-sm">
              {data.items.map((item) => (
                <li key={item.name} className="flex justify-between gap-3">
                  <span className="truncate">{item.name}</span>
                  <span className="text-muted-foreground shrink-0">x{item.quantity}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="text-center pt-2">
          <Link href="/" className="text-xs font-bold text-accent underline underline-offset-2">
            Continuer mes achats sur MIAD Market →
          </Link>
        </div>
      </div>
    </main>
  )
}

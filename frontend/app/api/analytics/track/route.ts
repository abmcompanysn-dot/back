import { NextResponse } from 'next/server'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')

const ALLOWED_EVENTS = new Set([
  'page_view', 'product_view', 'add_to_cart', 'remove_from_cart',
  'checkout_start', 'checkout_step', 'checkout_complete',
  'payment_attempt', 'payment_failed', 'payment_success', 'cart_abandoned',
  'search',
])

// Relais public vers l'endpoint WordPress de tracking — aucune donnée sensible
// (pas de PII), le seul but ici est de valider la forme avant de relayer et
// d'éviter d'exposer directement l'URL WordPress au client.
export async function POST(req: Request) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const {
    eventType, sessionId, productId, searchQuery, referrer, path,
    userId, checkoutStepNumber, paymentFailureReason, deviceType, cartValue, metadata,
  } = body || {}

  if (typeof eventType !== 'string' || !ALLOWED_EVENTS.has(eventType)) {
    return NextResponse.json({ ok: false, error: 'invalid_event_type' }, { status: 400 })
  }
  if (typeof sessionId !== 'string' || sessionId.length < 8 || sessionId.length > 64) {
    return NextResponse.json({ ok: false, error: 'invalid_session_id' }, { status: 400 })
  }

  // Capturé ici (edge Cloudflare Pages, voit la vraie IP du visiteur) plutôt
  // que côté WordPress, qui ne verrait que l'IP de sortie de Cloudflare Pages
  // — même raisonnement que pour le journal admin (lib/miad-admin-api.ts).
  const country = req.headers.get('cf-ipcountry') || undefined

  try {
    await fetch(`${WOO_URL}/wp-json/miad-analytics/v1/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'MIAD-Headless-Client' },
      body: JSON.stringify({
        eventType,
        sessionId,
        productId: typeof productId === 'number' || typeof productId === 'string' ? productId : undefined,
        searchQuery: typeof searchQuery === 'string' ? searchQuery.slice(0, 255) : undefined,
        referrer: typeof referrer === 'string' ? referrer.slice(0, 255) : undefined,
        path: typeof path === 'string' ? path.slice(0, 255) : undefined,
        userId: typeof userId === 'number' || typeof userId === 'string' ? userId : undefined,
        checkoutStepNumber: typeof checkoutStepNumber === 'number' ? checkoutStepNumber : undefined,
        paymentFailureReason: typeof paymentFailureReason === 'string' ? paymentFailureReason.slice(0, 100) : undefined,
        deviceType: typeof deviceType === 'string' ? deviceType : undefined,
        cartValue: typeof cartValue === 'number' ? cartValue : undefined,
        metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
        country,
      }),
    })
  } catch {
    // Le tracking est non-bloquant : un échec réseau vers WordPress ne doit
    // jamais remonter d'erreur visible côté client.
  }

  return NextResponse.json({ ok: true })
}

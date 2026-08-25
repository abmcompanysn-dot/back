import { NextResponse } from 'next/server'

export const runtime = 'edge';

const ALLOWED_EVENTS = new Set([
  'page_view', 'product_view', 'add_to_cart', 'remove_from_cart',
  'checkout_start', 'checkout_step', 'checkout_complete',
  'payment_attempt', 'payment_failed', 'payment_success', 'cart_abandoned',
  'search',
])

// AUCUN service Go n'a d'équivalent au plugin analytics WordPress
// (miad-analytics/v1/track) — pas de table événements, pas de service
// analytics dédié (voir aussi app/api/admin/action-log, qui est un
// journal d'ACTIONS ADMIN, pas un tracker de comportement visiteur ;
// et app/api/recommendations/admin, différé au même titre côté back-office).
// La validation d'entrée est conservée pour ne rien casser côté appelants,
// mais l'événement n'est plus persisté nulle part — accepté (200) et
// jeté, jamais une erreur visible côté client puisque le tracking a
// toujours été non-bloquant par design.
export async function POST(req: Request) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const { eventType, sessionId } = body || {}

  if (typeof eventType !== 'string' || !ALLOWED_EVENTS.has(eventType)) {
    return NextResponse.json({ ok: false, error: 'invalid_event_type' }, { status: 400 })
  }
  if (typeof sessionId !== 'string' || sessionId.length < 8 || sessionId.length > 64) {
    return NextResponse.json({ ok: false, error: 'invalid_session_id' }, { status: 400 })
  }

  return NextResponse.json({ ok: true })
}

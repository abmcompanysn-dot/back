import { NextResponse } from 'next/server'

export const runtime = 'edge'

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')

// Proxy vers l'endpoint public WordPress (miad-representative.php) — pas
// d'auth ici non plus, sécurisé côté WP par le même token HMAC que
// /order-tracking (voir app/api/order-tracking/route.ts).
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { orderId, token, lat, lng } = body

  if (!orderId || !token || lat === undefined || lng === undefined) {
    return NextResponse.json({ error: 'Paramètres manquants' }, { status: 400 })
  }

  try {
    const res = await fetch(`${WOO_URL}/wp-json/miad-products/v1/scan-checkpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ order_id: orderId, token, lat, lng }),
      cache: 'no-store',
    })
    const data = await res.json().catch(() => ({ error: 'Réponse serveur invalide' }))
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Serveur indisponible' }, { status: 503 })
  }
}

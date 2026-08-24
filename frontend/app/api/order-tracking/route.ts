import { NextResponse } from 'next/server'

export const runtime = 'edge'

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')

// Proxy vers l'endpoint public WordPress (miad-representative.php) — pas
// d'auth ici non plus, la sécurité vient du token vérifié côté WP (HMAC par
// commande, voir miad_order_tracking_token()).
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const orderId = searchParams.get('order_id')
  const token = searchParams.get('token')
  if (!orderId || !token) {
    return NextResponse.json({ error: 'Paramètres manquants' }, { status: 400 })
  }

  try {
    const res = await fetch(
      `${WOO_URL}/wp-json/miad-products/v1/order-tracking?order_id=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' }
    )
    const data = await res.json().catch(() => ({ error: 'Réponse serveur invalide' }))
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Serveur indisponible' }, { status: 503 })
  }
}

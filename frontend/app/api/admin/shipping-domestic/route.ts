import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge'

// Grille tarifaire par tranche de distance (livraison nationale Sénégal) —
// lecture/écriture réservées à l'admin, via callHeadlessAdmin (même modèle
// que le reste des routes admin : trace chaque appel dans le journal WP).

export async function GET(request: Request) {
  const result = await callHeadlessAdmin(request, {
    role: 'admin',
    action: 'shipping_domestic.tiers.get',
    path: '/wp-json/miad/v1/shipping-domestic/tiers',
    method: 'GET',
  })
  if (!result.ok) return NextResponse.json({ error: result.error, wpBody: (result as any).wpBody }, { status: result.status })
  return NextResponse.json(result.data)
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body || !Array.isArray(body.tiers)) {
    return NextResponse.json({ error: 'tiers (array) requis' }, { status: 400 })
  }

  const result = await callHeadlessAdmin(request, {
    role: 'admin',
    action: 'shipping_domestic.tiers.set',
    path: '/wp-json/miad/v1/shipping-domestic/tiers',
    method: 'POST',
    body,
  })
  if (!result.ok) return NextResponse.json({ error: result.error, wpBody: (result as any).wpBody }, { status: result.status })
  return NextResponse.json(result.data)
}

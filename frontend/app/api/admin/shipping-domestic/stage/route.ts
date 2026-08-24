import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge'

// Mise à jour du statut de livraison nationale d'une commande (admin
// uniquement en V1 — client/vendeur consultent en lecture seule via le
// meta _miad_domestic_stage déjà exposé sur GET wc/v3/orders).
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body?.orderId || !body?.stage) {
    return NextResponse.json({ error: 'orderId et stage requis' }, { status: 400 })
  }

  const result = await callHeadlessAdmin(request, {
    role: 'admin',
    action: 'shipping_domestic.order_stage.set',
    path: '/wp-json/miad/v1/shipping-domestic/order-stage',
    method: 'POST',
    body,
  })
  if (!result.ok) return NextResponse.json({ error: result.error, wpBody: (result as any).wpBody }, { status: result.status })
  return NextResponse.json(result.data)
}

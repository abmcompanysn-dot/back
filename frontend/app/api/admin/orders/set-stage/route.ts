import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

// Migré vers admin-svc (POST /admin/api/orders/set-stage) — statut de
// livraison DHL (international). fulfillment-svc résout la commande vers
// son expédition puis pose l'événement, voir dhlSetOrderStage (admin-svc).
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { order_id, stage } = body
  if (!order_id || !stage) return NextResponse.json({ error: 'order_id et stage requis' }, { status: 400 })

  const result = await callHeadlessAdmin(req, {
    role: 'admin',
    action: 'orders.set_stage',
    path: '/admin/api/orders/set-stage',
    method: 'POST',
    body: { order_id, stage },
  })
  if (!result.ok) return NextResponse.json({ error: result.error, upstreamBody: (result as any).upstreamBody }, { status: result.status })
  return NextResponse.json(result.data)
}

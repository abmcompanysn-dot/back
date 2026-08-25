import { NextResponse } from 'next/server'
import { fetchWpUser, isAdmin, ADMIN_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

// Migré vers fulfillment-svc : POST /dhl/orders/{id}/create-shipment
// construit désormais le payload MyDHL complet lui-même (expéditeur
// depuis vendor-svc, destinataire depuis order-svc, articles avec
// poids/HS code depuis catalog-svc) — portage fidèle de
// miad_dhl_create_shipment_api() (ancien plugin WordPress).
export async function POST(req: Request) {
  const auth = req.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  const user = await fetchWpUser(auth.slice(7))
  if (!user || !isAdmin(user)) return NextResponse.json({ error: 'Accès refusé' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const { order_id, weight, length, width, height, hsCode } = body
  if (!order_id) return NextResponse.json({ error: 'order_id requis' }, { status: 400 })

  const res = await fetch(`${ADMIN_SVC_URL}/admin/api/dhl/orders/${order_id}/create-shipment`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ weight, length, width, height, hs_code: hsCode }),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: (data as any)?.error?.message || 'Erreur DHL' }, { status: res.status })
  return NextResponse.json(data)
}

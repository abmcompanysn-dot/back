import { NextResponse } from 'next/server'
import { ORDER_SVC_URL, VENDOR_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// GET /api/vendor/orders?status=any&page=1&per_page=20
// Proxy vers GET /vendor/{id}/orders (vendor-svc, délègue à order-svc
// ?vendor_id=) — l'id vendeur vient du JWT (vendor_id), jamais du client.
export async function GET(request: Request) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }
  const user = await fetchWpUser(auth.slice(7))
  if (!user?.vendor_id) return NextResponse.json({ error: 'Accès réservé aux vendeurs' }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const page = searchParams.get('page') || '1'

  const res = await fetch(`${VENDOR_SVC_URL}/vendor/${user.vendor_id}/orders?page=${page}`, { cache: 'no-store' })
  if (!res.ok) return NextResponse.json({ orders: [], total: 0 })
  const data = await res.json()
  return NextResponse.json({ orders: (data.items || []).map(mapOrder), total: data.total || 0 })
}

// PUT /api/vendor/orders — mettre à jour le statut d'une commande.
// order-svc ne vérifie pas lui-même l'appartenance (pas de notion de rôle
// côté order-svc) — la vérification se fait ici : on relit la commande et
// on compare son vendor_id à celui du JWT avant d'autoriser le changement.
export async function PUT(request: Request) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }
  const user = await fetchWpUser(auth.slice(7))
  if (!user?.vendor_id) return NextResponse.json({ error: 'Accès réservé aux vendeurs' }, { status: 403 })

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Corps JSON invalide' }, { status: 400 })
  }

  const { orderId, status } = body
  if (!orderId || !status) return NextResponse.json({ error: 'orderId et status requis' }, { status: 400 })

  const allowed = ['processing', 'shipped', 'delivered', 'cancelled', 'refunded']
  if (!allowed.includes(status)) return NextResponse.json({ error: 'Statut non autorisé' }, { status: 400 })

  const orderRes = await fetch(`${ORDER_SVC_URL}/orders/${orderId}`, { cache: 'no-store' })
  if (!orderRes.ok) return NextResponse.json({ error: 'Commande introuvable' }, { status: 404 })
  const order = await orderRes.json()
  if (String(order.vendor_id) !== String(user.vendor_id)) {
    return NextResponse.json({ error: 'Cette commande ne vous appartient pas' }, { status: 403 })
  }

  const res = await fetch(`${ORDER_SVC_URL}/orders/${orderId}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  if (!res.ok) return NextResponse.json({ error: 'Erreur backend' }, { status: res.status })
  return NextResponse.json({ success: true, order: mapOrder(await res.json()) })
}

function mapOrder(o: any) {
  return {
    id: o.id,
    number: o.reference || o.id,
    status: o.status || 'pending',
    date: o.created_at || '',
    total: parseFloat(o.total_usd || 0),
    currency: 'USD',
  }
}

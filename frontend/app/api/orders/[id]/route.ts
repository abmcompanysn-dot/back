import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'
import { ORDER_SVC_URL, fetchWpUser, isAdmin } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// shapeOrder — order-svc getParentOrder renvoie le format Go (snake_case,
// shipping_address, total_usd…). OrderDetailPanel.tsx (rep) ET
// ClientOrderDetail.tsx attendent en partie le format WooCommerce
// (order.billing / order.shipping). On expose les deux alias plutôt que
// de patcher chaque accès côté composant.
function shapeOrder(data: any) {
  const d: any = data || {}
  const addr = d.shipping_address || {}
  return {
    ...d,
    shipping: {
      first_name: addr.first_name || '', last_name: addr.last_name || '',
      address_1: addr.address_1 || '', address_2: addr.address_2 || '',
      city: addr.city || '', state: addr.state || '', postcode: addr.postcode || '',
      country: addr.country || '', phone: addr.phone || '',
    },
    billing: {
      first_name: addr.first_name || '', last_name: addr.last_name || '',
      address_1: addr.address_1 || '', address_2: addr.address_2 || '',
      city: addr.city || '', state: addr.state || '', postcode: addr.postcode || '',
      country: addr.country || '', phone: addr.phone || '', email: addr.email || '',
    },
    shipping_lines: d.shipping_lines || [{ method_title: 'MIAD Standard' }],
    currency_symbol: d.currency_symbol || '$',
    payment_method_title: d.payment_method_title || d.payment_method || '',
    customer_note: d.customer_note || '',
    meta_data: d.meta_data || [],
  }
}

// GET /api/orders/[id] — détail d'une commande GROUPÉE (parent).
//
// Deux publics :
//  1. admin / représentant → via callHeadlessAdmin (journalisé), inchangé.
//  2. CLIENT propriétaire → branche directe vers order-svc, avec
//     vérification que order.customer_id === user.sub (getParentOrder
//     expose customer_id depuis le 2026-09-01). Comble le trou : le
//     client ne pouvait pas voir le détail de ses propres commandes
//     (regroupement par boutique, images produits), seulement la liste.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const auth = request.headers.get('Authorization')
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : ''
  const user = token ? await fetchWpUser(token) : null

  // Client non-admin/non-rep : accès à SES commandes uniquement.
  if (user?.sub && !isAdmin(user)) {
    const res = await fetch(`${ORDER_SVC_URL}/orders/parent/${id}`, { cache: 'no-store' })
    if (!res.ok) {
      return NextResponse.json({ error: 'Commande introuvable' }, { status: res.status })
    }
    const data = await res.json()

    // Vérification d'appartenance. getParentOrder expose customer_id depuis
    // le 2026-09-01 — mais si le backend order-svc n'a pas encore été
    // redéployé, ce champ est absent : on retombe alors sur la liste des
    // commandes du client (elle contient parent_order_id) pour confirmer
    // que ce parent lui appartient. Jamais de bypass : sans preuve
    // d'appartenance → 404.
    let owned = data.customer_id != null && String(data.customer_id) === String(user.sub)
    if (data.customer_id == null) {
      try {
        const listRes = await fetch(`${ORDER_SVC_URL}/orders?customer_id=${user.sub}&page_size=100`, { cache: 'no-store' })
        if (listRes.ok) {
          const list = await listRes.json()
          owned = (list.items || []).some(
            (o: any) => String(o.parent_order_id || o.id) === String(id)
          )
        }
      } catch { /* owned reste false → 404 ci-dessous */ }
    }
    if (!owned) {
      // Ne pas révéler l'existence de la commande à un tiers.
      return NextResponse.json({ error: 'Commande introuvable' }, { status: 404 })
    }
    return NextResponse.json({ order: shapeOrder(data) })
  }

  // admin / représentant (journalisé)
  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'orders.get',
    path: `/admin/api/orders/parent/${id}`,
  })

  if (!result.ok) return NextResponse.json({ error: result.error, upstreamStatus: result.upstreamStatus, upstreamBody: result.upstreamBody }, { status: result.status })
  return NextResponse.json({ order: shapeOrder(result.data) })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const [{ id }, body] = await Promise.all([params, request.json().catch(() => ({}))])

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'orders.update',
    method: 'PUT',
    path: `/admin/api/orders/${id}/status`,
    body: { status: body.status },
  })

  if (!result.ok) return NextResponse.json({ error: result.error, upstreamStatus: result.upstreamStatus, upstreamBody: result.upstreamBody }, { status: result.status })
  return NextResponse.json({ order: result.data })
}

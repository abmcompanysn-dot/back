import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'orders.get',
    path: `/admin/api/orders/parent/${id}`,
  })

  if (!result.ok) return NextResponse.json({ error: result.error, upstreamStatus: result.upstreamStatus, upstreamBody: result.upstreamBody }, { status: result.status })

  // order-svc getParentOrder renvoie shipping_address (snake_case, format
  // Go). OrderDetailPanel.tsx lit order.billing / order.shipping (format
  // WooCommerce) → crash "Cannot read properties of undefined (reading
  // 'first_name')" au clic sur le détail dans l'espace représentant
  // (2026-08-28). On expose les deux alias.
  const data: any = result.data || {}
  const addr = data.shipping_address || {}
  const shaped = {
    ...data,
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
    shipping_lines: data.shipping_lines || [{ method_title: 'MIAD Standard' }],
    // Champs format WooCommerce attendus par OrderDetailPanel (impression /
    // bordereau) mais absents du format Go getParentOrder.
    currency_symbol: data.currency_symbol || '$',
    payment_method_title: data.payment_method_title || data.payment_method || '',
    customer_note: data.customer_note || '',
    meta_data: data.meta_data || [],
  }
  return NextResponse.json({ order: shaped })
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

import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const { orderId, trackingNumber, carrier, events } = body || {}

  if (!orderId || !trackingNumber) {
    return NextResponse.json({ error: 'orderId et trackingNumber requis' }, { status: 400 })
  }

  const metaData: any[] = [
    { key: '_miad_tracking_number', value: String(trackingNumber) },
    { key: '_miad_carrier', value: carrier || 'DHL' },
  ]
  if (events && Array.isArray(events)) {
    metaData.push({ key: '_miad_tracking_events', value: JSON.stringify(events) })
  }

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'orders.tracking.update',
    method: 'PUT',
    path: `/wp-json/wc/v3/orders/${orderId}`,
    auth: 'wc-basic',
    body: { meta_data: metaData },
  })

  if (!result.ok) {
    return NextResponse.json({ error: 'Erreur de mise à jour WooCommerce', wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status === 200 ? 500 : result.status })
  }

  return NextResponse.json({ success: true, orderId, trackingNumber, carrier: carrier || 'DHL' })
}

import { NextResponse } from 'next/server'
import { FULFILLMENT_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const { orderId, trackingNumber, carrier } = body || {}

  if (!orderId || !trackingNumber) {
    return NextResponse.json({ error: 'orderId et trackingNumber requis' }, { status: 400 })
  }

  const res = await fetch(`${FULFILLMENT_SVC_URL}/shipments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      order_id: Number(orderId),
      tracking_number: String(trackingNumber),
      carrier: carrier || 'dhl',
    }),
  })

  if (!res.ok) {
    const upstreamBody = await res.text().catch(() => '')
    return NextResponse.json(
      { error: 'Erreur de mise à jour du suivi', upstreamStatus: res.status, upstreamBody },
      { status: res.status === 200 ? 500 : res.status }
    )
  }

  return NextResponse.json({ success: true, orderId, trackingNumber, carrier: carrier || 'dhl' })
}

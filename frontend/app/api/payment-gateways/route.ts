import { NextResponse } from 'next/server'
import { PAYMENT_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'

export async function GET() {
  try {
    const response = await fetch(`${PAYMENT_SVC_URL}/payment-methods`, {
      next: { revalidate: 3600 }, // Cache d'une heure car les méthodes changent rarement
    })

    if (!response.ok) {
      console.error(`[Payment Gateways Error] Status: ${response.status}`)
      return NextResponse.json({ gateways: [], error: 'Impossible de récupérer les méthodes de paiement' }, { status: response.status })
    }

    const data = await response.json()
    return NextResponse.json({ gateways: data.gateways || [] })
  } catch (error) {
    console.error('[API Payment Gateways Exception]:', error)
    return NextResponse.json({ gateways: [], error: 'Internal Server Error' }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'

export const runtime = 'edge';

// Utilisation de l'URL normalisée pour éviter les problèmes de pare-feu
const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://www.miadmarket.com').replace(/\/$/, '')
const WOO_CK = process.env.WOO_CONSUMER_KEY
const WOO_CS = process.env.WOO_CONSUMER_SECRET
import { requireEnv } from '@/lib/require-env'
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

export async function GET() {
  try {
    if (!WOO_CK || !WOO_CS) {
      return NextResponse.json({ error: 'Clés API WooCommerce manquantes' }, { status: 500 })
    }

    // On récupère toutes les passerelles de paiement de WooCommerce
    const apiUrl = new URL(`${WOO_URL}/wp-json/wc/v3/payment_gateways`)
    apiUrl.searchParams.append('consumer_key', WOO_CK)
    apiUrl.searchParams.append('consumer_secret', WOO_CS)
    
    const response = await fetch(apiUrl.toString(), {
      headers: {
        'Accept': 'application/json',
        'X-Headless-Secret': INTERNAL_SECRET,
        'User-Agent': 'MIAD-Headless-Client'
      },
      next: { revalidate: 3600 } // Cache d'une heure car les méthodes changent rarement
    })

    if (!response.ok) {
      console.error(`[Payment Gateways Error] Status: ${response.status}`)
      return NextResponse.json({ gateways: [], error: 'Impossible de récupérer les méthodes de paiement' }, { status: response.status })
    }

    const gateways = await response.json()
    return NextResponse.json({ gateways: gateways })
  } catch (error) {
    console.error("[API Payment Gateways Exception]:", error)
    return NextResponse.json({ gateways: [], error: 'Internal Server Error' }, { status: 500 })
  }
}

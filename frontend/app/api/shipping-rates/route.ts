import { NextResponse } from 'next/server'
import { SHIPPING_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';
export const revalidate = 300 // ISR 5 min

// Tarifs de livraison — source UNIQUE : shipping-svc GET /shipping/config
// (fin du calcul en dur : useShippingRates.ts, app/page.tsx et
// CheckoutPage lisaient auparavant des constantes figées, et cette route
// interrogeait l'ancien WordPress mort — gap documenté le 2026-08-25,
// résolu le 2026-09-02 avec l'endpoint /shipping/config unifié).
//
// Format renvoyé (calé sur ShippingRatesConfig du hook) :
//   { local, zone_africa, free_threshold, domestic_fallback_usd,
//     zones: { AF: {standard,express}, EU: {...}, ... } }

const FALLBACK = {
  local: 3,
  zone_africa: 6,
  free_threshold: 150,
  domestic_fallback_usd: 8.33,
  zones: {
    AF: { standard: 12, express: 30 },
    EU: { standard: 25, express: 45 },
    NA: { standard: 25, express: 50 },
    SA: { standard: 25, express: 55 },
    AS: { standard: 25, express: 55 },
    OC: { standard: 30, express: 60 },
  },
}

export async function GET() {
  try {
    const res = await fetch(`${SHIPPING_SVC_URL}/shipping/config`, {
      next: { revalidate: 300, tags: ['shipping-config'] },
    })
    if (!res.ok) throw new Error(`shipping-svc returned ${res.status}`)
    const data = await res.json()
    // Garde-fou : si un champ manque (base fraîche, migration partielle),
    // on complète depuis le fallback plutôt que de propager un trou.
    return NextResponse.json(
      {
        local: data.local ?? FALLBACK.local,
        zone_africa: data.zone_africa ?? FALLBACK.zone_africa,
        free_threshold: data.free_threshold ?? FALLBACK.free_threshold,
        domestic_fallback_usd: data.domestic_fallback_usd ?? FALLBACK.domestic_fallback_usd,
        zones: { ...FALLBACK.zones, ...(data.zones || {}) },
      },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' } }
    )
  } catch {
    return NextResponse.json(FALLBACK)
  }
}

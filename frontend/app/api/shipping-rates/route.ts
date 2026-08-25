import { NextResponse } from 'next/server'

export const runtime = 'edge';

// GAP CONNU (2026-08-25) : appelle encore l'ancien WordPress mort
// (NEXT_PUBLIC_WC_URL n'a jamais été positionné sur Cloudflare Pages) —
// retombe donc TOUJOURS sur le fallback codé en dur ci-dessous, jamais sur
// une vraie donnée. shipping-svc (Go) expose bien GET /shipping-rates,
// mais avec un schéma différent (zones par pays, base_rate_usd/
// per_item_usd) qui ne correspond pas à ce que ce fichier et useShippingRates.ts
// attendent (local/zone_africa/zones{AF,EU,...}:{standard,express}) —
// décision explicite du fondateur (2026-08-25) : laisser tel quel pour
// l'instant, migration prévue plus tard. Ne pas migrer silencieusement
// avec un mapping deviné entre-temps.
const WC_BASE = process.env.NEXT_PUBLIC_WC_URL || 'https://api.miadmarket.com'

export const revalidate = 300 // revalide toutes les 5 min (ISR)

export async function GET() {
  try {
    const res = await fetch(`${WC_BASE}/wp-json/miad/v1/shipping-rates`, {
      next: { revalidate: 300 },
    })

    if (!res.ok) throw new Error(`WordPress returned ${res.status}`)
    const data = await res.json()

    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' },
    })
  } catch {
    // Fallback sur les valeurs codées en dur si WordPress est injoignable
    return NextResponse.json({
      local:       3,
      zone_africa: 6,
      zones: {
        AF: { standard: 12, express: 30 },
        EU: { standard: 25, express: 45 },
        NA: { standard: 25, express: 50 },
        SA: { standard: 25, express: 55 },
        AS: { standard: 25, express: 55 },
        OC: { standard: 30, express: 60 },
      },
    })
  }
}

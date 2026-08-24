import { NextResponse } from 'next/server'

export const runtime = 'edge'

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')

// Calcul du prix de livraison nationale (Sénégal) pour UN vendeur — le
// checkout appelle cette route une fois par vendeur présent dans le panier
// (multi-vendeur = plusieurs frais distincts, cahier des charges section 5).
// Public/no-secret côté WP (comme /shipping-rates existant) car appelé en
// direct pendant la saisie du formulaire, avant paiement.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body?.vendorId) {
    return NextResponse.json({ error: 'vendorId requis' }, { status: 400 })
  }

  try {
    const res = await fetch(`${WOO_URL}/wp-json/miad/v1/shipping-domestic/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'MIAD-Headless-Client' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`WordPress returned ${res.status}`)
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({
      ok: true, distance_km: null, price: 3000, tier_label: 'estimation',
      resolved_from: 'fallback_default', origin_source: 'error', dest_source: 'error',
    })
  }
}

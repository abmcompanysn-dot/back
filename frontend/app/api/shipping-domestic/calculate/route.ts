import { NextResponse } from 'next/server'
import { SHIPPING_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// Calcul du prix de livraison nationale (Sénégal) pour UN vendeur — le
// checkout appelle cette route une fois par vendeur présent dans le panier
// (multi-vendeur = plusieurs frais distincts, cahier des charges section 5).
// Public/no-secret côté shipping-svc car appelé en direct pendant la saisie
// du formulaire, avant paiement.
//
// shipping-svc (POST /shipping-domestic/calculate) attend
// { vendor_id, dest_lat, dest_lng } et renvoie { distance_km, price_usd,
// tier_id } — pas de tier_label/eta_label (la grille domestic_tiers côté Go
// n'a que max_distance_km + price_usd, contrairement à l'ancienne grille
// WordPress qui portait des libellés). On mappe donc price_usd -> price et
// on laisse tier_label/eta_label à null : le frontend (CheckoutPage.tsx)
// les traite déjà comme optionnels (`data.tier_label ?? null`).
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body?.vendorId) {
    return NextResponse.json({ error: 'vendorId requis' }, { status: 400 })
  }
  if (body.buyerLat === undefined || body.buyerLng === undefined) {
    // shipping-svc calcule par distance à vol d'oiseau (lat/lng obligatoires)
    // — pas de repli "par ville" côté Go, contrairement à l'ancien WordPress.
    return NextResponse.json({
      ok: true, distance_km: null, price: 3000, tier_label: 'estimation',
      resolved_from: 'fallback_default', origin_source: 'missing_coords', dest_source: 'missing_coords',
    })
  }

  try {
    const res = await fetch(`${SHIPPING_SVC_URL}/shipping-domestic/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vendor_id: Number(body.vendorId),
        dest_lat: Number(body.buyerLat),
        dest_lng: Number(body.buyerLng),
      }),
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`shipping-svc returned ${res.status}`)
    const data = await res.json()
    return NextResponse.json({
      ok: true,
      price: data.price_usd,
      distance_km: data.distance_km,
      tier_label: null,
      eta_label: null,
      resolved_from: 'shipping-svc',
      origin_source: 'vendor_shipping_address',
      dest_source: 'buyer_coords',
    })
  } catch {
    return NextResponse.json({
      ok: true, distance_km: null, price: 3000, tier_label: 'estimation',
      resolved_from: 'fallback_default', origin_source: 'error', dest_source: 'error',
    })
  }
}

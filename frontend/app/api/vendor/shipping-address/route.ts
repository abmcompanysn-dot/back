import { NextResponse } from 'next/server'
import { SHIPPING_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// Adresse d'expédition du vendeur connecté (module livraison nationale
// Sénégal, calcul Haversine côté shipping-svc — voir A.9/plan de migration).
// L'identité du vendeur est résolue via son propre token, jamais un
// vendorId fourni tel quel par le client. Contrat différent de l'ancien
// endpoint WordPress : shipping-svc attend {address, lat, lng} (coordonnées
// GPS), pas {city} — la géolocalisation doit être résolue côté client
// (ex: sélecteur de carte) avant l'appel POST.

async function resolveVendor(request: Request) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return null
  return fetchWpUser(auth.slice(7))
}

export async function GET(request: Request) {
  const user = await resolveVendor(request)
  if (!user?.vendor_id) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })

  const res = await fetch(`${SHIPPING_SVC_URL}/vendor-shipping-address?vendor_id=${user.vendor_id}`, {
    cache: 'no-store',
  })
  if (res.status === 404) return NextResponse.json({ address: null })
  if (!res.ok) return NextResponse.json({ error: 'Erreur serveur' }, { status: 502 })
  const data = await res.json()
  return NextResponse.json(data)
}

export async function POST(request: Request) {
  const user = await resolveVendor(request)
  if (!user?.vendor_id) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body?.lat || !body?.lng) {
    return NextResponse.json({ error: 'lat et lng requis (coordonnées GPS)' }, { status: 400 })
  }

  const res = await fetch(`${SHIPPING_SVC_URL}/vendor-shipping-address`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vendor_id: user.vendor_id,
      address: body.address || '',
      lat: body.lat,
      lng: body.lng,
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    return NextResponse.json({ error: err?.error?.message || 'Erreur serveur' }, { status: res.status })
  }

  const data = await res.json()
  return NextResponse.json(data)
}

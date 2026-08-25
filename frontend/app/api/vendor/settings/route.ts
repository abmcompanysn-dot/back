import { NextResponse } from 'next/server'
import { VENDOR_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// PUT /api/vendor/settings
// body: { storeName, phone, address, email, description }
// Remplace l'appel en dur du dashboard vendeur vers l'ancien WordPress mort
// (wp-json/dokan/v1/settings, silencieusement avalé par un toast "enregistré
// localement" même en cas d'échec — le vendeur croyait sauvegarder sans que
// rien ne soit persisté). Relaie vers vendor-svc PUT /vendor/profile, qui
// accepte désormais aussi email/address/description en plus de name/phone/city.
export async function PUT(request: Request) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }
  const user = await fetchWpUser(auth.slice(7))
  if (!user?.vendor_id) return NextResponse.json({ error: 'Accès réservé aux vendeurs' }, { status: 403 })

  const body = await request.json().catch(() => null)
  const { storeName, phone, address, email, description } = body || {}

  const res = await fetch(`${VENDOR_SVC_URL}/vendor/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vendor_id: user.vendor_id,
      name: storeName || '',
      phone: phone || '',
      address: address || '',
      email: email || '',
      description: description || '',
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    return NextResponse.json({ error: err?.error?.message || 'Erreur backend' }, { status: res.status })
  }

  const data = await res.json()
  return NextResponse.json({ success: true, vendor: data })
}

import { NextResponse } from 'next/server'
import { VENDOR_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// PUT /api/vendor/profile
// body: { type: 'avatar' | 'banner', url: string }
// L'URL vient de POST /media/upload (MinIO, voir A.8 du plan de
// migration) — plus de mediaId WordPress à deux temps upload+attach,
// l'URL finale est déjà connue avant cet appel.
export async function PUT(request: Request) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }
  const user = await fetchWpUser(auth.slice(7))
  if (!user?.vendor_id) return NextResponse.json({ error: 'Accès réservé aux vendeurs' }, { status: 403 })

  const body = await request.json().catch(() => null)
  const { type, url } = body || {}

  if (!type || !url || !['avatar', 'banner'].includes(type)) {
    return NextResponse.json({ error: 'type (avatar|banner) et url requis' }, { status: 400 })
  }

  const payload =
    type === 'avatar'
      ? { vendor_id: user.vendor_id, logo_url: url }
      : { vendor_id: user.vendor_id, banner_url: url }

  const res = await fetch(`${VENDOR_SVC_URL}/vendor/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    return NextResponse.json({ error: err?.error?.message || 'Erreur backend' }, { status: res.status })
  }

  const data = await res.json()
  return NextResponse.json({
    success: true,
    type,
    url: type === 'avatar' ? data.gravatar : data.banner,
  })
}

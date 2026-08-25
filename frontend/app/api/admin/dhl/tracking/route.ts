import { NextResponse } from 'next/server'
import { fetchWpUser, isAdmin, ADMIN_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const auth = req.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  const user = await fetchWpUser(auth.slice(7))
  if (!user || !isAdmin(user)) return NextResponse.json({ error: 'Accès refusé' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const trackingNumber = searchParams.get('tracking_number') || ''
  if (!trackingNumber) return NextResponse.json({ error: 'tracking_number requis' }, { status: 400 })

  const res = await fetch(`${ADMIN_SVC_URL}/admin/api/dhl/tracking/${encodeURIComponent(trackingNumber)}`, {
    headers: { Authorization: auth },
    cache: 'no-store',
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: (data as any)?.error?.message || 'Erreur DHL' }, { status: res.status })
  return NextResponse.json(data)
}

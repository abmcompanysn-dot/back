import { NextResponse } from 'next/server'
import { fetchWpUser, isAdmin, ADMIN_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  const user = await fetchWpUser(auth.slice(7))
  if (!user || !isAdmin(user)) return NextResponse.json({ error: 'Accès refusé' }, { status: 403 })
  const { id } = await params

  const res = await fetch(`${ADMIN_SVC_URL}/admin/api/dhl/order/${encodeURIComponent(id)}`, {
    headers: { Authorization: auth },
    cache: 'no-store',
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: (data as any)?.error?.message || 'Erreur serveur' }, { status: res.status })
  return NextResponse.json(data)
}

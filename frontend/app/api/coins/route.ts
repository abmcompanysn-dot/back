import { NextResponse } from 'next/server'
import { fetchWpUser, LOYALTY_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

// Migré depuis l'appel client direct à l'ancien wp-json/miad/v1/coins
// (lib/coins.ts, syncCoinsFromAPI) — le customer_id est résolu depuis le
// JWT vérifié côté serveur (sub), jamais transmis par le client.
export async function GET(req: Request) {
  const auth = req.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  const user = await fetchWpUser(auth.slice(7))
  if (!user) return NextResponse.json({ error: 'Session invalide' }, { status: 401 })

  const res = await fetch(`${LOYALTY_SVC_URL}/coins/${encodeURIComponent(String(user.sub))}`, { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: (data as any)?.error?.message || 'Erreur serveur' }, { status: res.status })
  return NextResponse.json(data)
}

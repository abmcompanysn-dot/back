import { NextResponse } from 'next/server'
import { fetchWpUser, LOYALTY_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

// Migré depuis l'appel client direct à l'ancien wp-json/miad/v1/coins/daily
// (lib/coins.ts, claimDailyAPI) — customer_id résolu depuis le JWT vérifié
// côté serveur, jamais transmis par le client.
export async function POST(req: Request) {
  const auth = req.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  const user = await fetchWpUser(auth.slice(7))
  if (!user) return NextResponse.json({ error: 'Session invalide' }, { status: 401 })

  const res = await fetch(`${LOYALTY_SVC_URL}/coins/daily`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: user.sub }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: (data as any)?.error?.message || 'Erreur serveur' }, { status: res.status })
  // loyalty-svc renvoie { customer_id, awarded } sans le nouveau solde total —
  // on le récupère avec un second appel pour rester cohérent avec
  // l'ancienne réponse WordPress { claimed, balance } attendue côté client.
  const balRes = await fetch(`${LOYALTY_SVC_URL}/coins/${encodeURIComponent(String(user.sub))}`, { cache: 'no-store' })
  const balData = await balRes.json().catch(() => ({}))
  return NextResponse.json({ claimed: true, balance: balData.balance ?? null, history: balData.history ?? [] })
}

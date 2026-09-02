import { NextResponse } from 'next/server'
import { LOYALTY_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'
export const revalidate = 300

// Liste publique des coupons actifs (affichés au client dans
// CouponsSection). loyalty-svc GET /coupons renvoie
// { coupons: [{ code, type, amount, coin_cost, max_uses, used_count,
//   expires_at? }] }. On filtre les expirés / épuisés côté serveur pour
// ne jamais montrer un code inutilisable.
export async function GET() {
  try {
    const res = await fetch(`${LOYALTY_SVC_URL}/coupons`, { next: { revalidate: 300, tags: ['coupons'] } })
    if (!res.ok) return NextResponse.json({ coupons: [] })
    const data = await res.json()
    const now = Date.now()
    const coupons = (data.coupons || []).filter((c: any) => {
      if (c.expires_at && new Date(c.expires_at).getTime() < now) return false
      if (c.max_uses > 0 && c.used_count >= c.max_uses) return false
      return true
    })
    return NextResponse.json(
      { coupons },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } }
    )
  } catch {
    return NextResponse.json({ coupons: [] })
  }
}

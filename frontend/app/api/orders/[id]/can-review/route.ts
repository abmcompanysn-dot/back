import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { CATALOG_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// GET /api/orders/[id]/can-review — produits d'une commande (livrée)
// encore à noter par le client connecté. Sert au formulaire d'avis (choix
// de la commande) et à l'encart "Noter mes achats" du dashboard.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const h = await headers()
  const user = await fetchWpUser(h.get('authorization') || h.get('cookie') || '')
  if (!user?.sub) {
    return NextResponse.json({ toReview: [] }, { status: 401 })
  }
  try {
    const res = await fetch(
      `${CATALOG_SVC_URL}/orders/${id}/can-review?customer_id=${user.sub}`,
      { cache: 'no-store' }
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return NextResponse.json({ toReview: [] }, { status: res.status })
    return NextResponse.json({ orderId: Number(id), toReview: data.to_review || [] })
  } catch {
    return NextResponse.json({ toReview: [] }, { status: 500 })
  }
}

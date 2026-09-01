import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { CATALOG_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// POST /api/reviews/[id]/helpful — vote "utile" (1 par personne/avis).
// voter_key = "cust:<id>" si connecté, sinon "anon:<empreinte IP>".
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ success: false }, { status: 400 })
  }
  const h = await headers()
  const user = await fetchWpUser(h.get('authorization') || h.get('cookie') || '')
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || 'anon'
  const voterKey = user?.sub ? `cust:${user.sub}` : `anon:${ip}`

  try {
    const res = await fetch(`${CATALOG_SVC_URL}/reviews/${id}/helpful`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voter_key: voterKey }),
    })
    const data = await res.json().catch(() => ({}))
    return NextResponse.json(
      { success: res.ok, helpfulCount: data.helpful_count ?? 0, counted: data.counted ?? false },
      { status: res.ok ? 200 : res.status }
    )
  } catch {
    return NextResponse.json({ success: false }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const TOKEN = 'miad-vt-xk29p7'
const MIAD_API = (process.env.MIAD_PRODUCTS_API || 'https://api.miadmarket.com/wp-json/miad-products/v1').replace(/\/$/, '')
const MIAD_SECRET = process.env.MIAD_PRODUCTS_SECRET || ''

export async function GET() {
  return NextResponse.json({ ok: true, route: 'vendor-transfer', hasSecret: !!MIAD_SECRET })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  if (body.token !== TOKEN) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })

  const { ids, authorId } = body
  if (!Array.isArray(ids) || !ids.length || !authorId)
    return NextResponse.json({ error: 'ids[] et authorId requis' }, { status: 400 })
  if (!MIAD_SECRET)
    return NextResponse.json({ error: 'MIAD_PRODUCTS_SECRET manquant sur Cloudflare Pages' }, { status: 500 })

  const res = await fetch(`${MIAD_API}/set-author`, {
    method: 'POST',
    headers: {
      'X-Miad-Products-Secret': MIAD_SECRET,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ids, authorId }),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: (data as any).error || 'Erreur MIAD API' }, { status: res.status })
  return NextResponse.json(data)
}

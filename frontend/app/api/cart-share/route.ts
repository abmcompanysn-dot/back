import { NextResponse } from 'next/server'
import { catalogCacheGet, catalogCacheSet } from '@/lib/catalog-cache'

export const runtime = 'edge'

// Permet à un client de retrouver son panier sur un autre appareil : le panier
// est sérialisé côté serveur (Cloudflare KV) derrière un id, et le lien
// `/?cart=<id>` le restaure. No-op en `next dev` local (KV indisponible hors
// Cloudflare Pages, voir lib/catalog-cache.ts).
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const items = body?.items

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'items[] requis' }, { status: 400 })
  }

  const id = crypto.randomUUID()
  await catalogCacheSet(`cart-share:${id}`, items)

  return NextResponse.json({ id })
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id requis' }, { status: 400 })
  }

  const cached = await catalogCacheGet<unknown[]>(`cart-share:${id}`)
  if (!cached) {
    return NextResponse.json({ error: 'Panier introuvable ou expiré' }, { status: 404 })
  }

  return NextResponse.json({ items: cached.data })
}

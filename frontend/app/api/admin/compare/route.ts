import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge'

// "Explorateur de données" (dashboard admin, onglet Vue d'ensemble) : liste
// brute des produits (SKU, prix, stock) pour un audit rapide côté admin.
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url)
  const page = searchParams.get('page') || '1'

  const result = await callHeadlessAdmin<{ items: any[] }>(req, {
    role: 'admin',
    action: 'admin.compare.list',
    path: '/admin/api/products',
    query: { page_size: 100, page },
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error, upstreamStatus: result.upstreamStatus, upstreamBody: result.upstreamBody }, { status: result.status })
  }
  const items = result.data?.items
  if (!Array.isArray(items)) {
    return NextResponse.json({ error: 'Réponse backend invalide' }, { status: 200 })
  }

  const comparison = items.map((p: any) => ({
    sku: p.sku || String(p.id),
    name: p.name || '',
    price: parseFloat(p.price || '0'),
    stock_quantity: undefined,
    stock_status: p.status === 'active' ? 'instock' : 'outofstock',
  }))

  return NextResponse.json({ comparison })
}

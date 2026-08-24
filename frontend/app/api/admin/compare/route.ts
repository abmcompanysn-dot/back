import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

// "Explorateur de données" (dashboard admin, onglet Vue d'ensemble) : liste
// brute des produits WooCommerce (SKU, prix, stock) pour un audit rapide côté
// admin.
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url)
  const page = searchParams.get('page') || '1'

  const result = await callHeadlessAdmin<any[]>(req, {
    role: 'admin',
    action: 'admin.compare.list',
    path: '/wp-json/wc/v3/products',
    auth: 'wc-basic',
    query: { per_page: 100, page, status: 'publish', orderby: 'date', order: 'desc' },
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  }
  if (!Array.isArray(result.data)) {
    return NextResponse.json({ error: 'Réponse WooCommerce invalide' }, { status: 200 })
  }

  const comparison = result.data.map((p: any) => ({
    sku: p.sku || String(p.id),
    name: p.name || '',
    price: parseFloat(p.price || '0'),
    stock_quantity: p.stock_quantity,
    stock_status: p.stock_status,
  }))

  return NextResponse.json({ comparison })
}

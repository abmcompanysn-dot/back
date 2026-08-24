import { NextResponse } from 'next/server'
import { fetchWpUser, isAdmin } from '@/lib/miad-server-auth'

export const runtime = 'edge';

const SITE   = (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.miadmarket.com').replace(/\/$/, '')
const WOO    = (process.env.NEXT_PUBLIC_WOO_URL  || 'https://api.miadmarket.com').replace(/\/$/, '')
const WOO_CK = process.env.WOO_CONSUMER_KEY    || ''
const WOO_CS = process.env.WOO_CONSUMER_SECRET || ''

interface WcProduct {
  id: number
  slug: string
  name: string
  description: string
  short_description: string
  price: string
  regular_price: string
  sale_price: string
  stock_status: string
  images: { src: string }[]
  store?: { shop_name?: string; store_name?: string; name?: string }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function csvEscape(value: unknown): string {
  const s = String(value ?? '')
  return /["\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function fetchAllProducts(): Promise<WcProduct[]> {
  const results: WcProduct[] = []
  let page = 1
  while (true) {
    const q = new URLSearchParams({
      per_page: '100', page: String(page), status: 'publish',
      consumer_key: WOO_CK, consumer_secret: WOO_CS,
    })
    const res = await fetch(`${WOO}/wp-json/wc/v3/products?${q}`, {
      headers: { 'User-Agent': 'MIAD-Headless-Client' },
      next: { revalidate: 3600 },
    })
    if (!res.ok) break
    const data: WcProduct[] = await res.json()
    if (!Array.isArray(data) || data.length === 0) break
    results.push(...data)
    if (data.length < 100) break
    page++
  }
  return results
}

// GET /api/admin/meta-csv — export CSV du catalogue pour import manuel dans
// Meta Commerce Manager (bouton "Exporter CSV (Meta)" du dashboard admin).
// Memes champs que /merchant-feed.xml, en CSV plutot qu'en RSS — utile pour
// forcer un import immediat sans attendre le prochain passage programme du
// flux automatique (demande le 2026-08-10).
export async function GET(request: Request) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }
  const user = await fetchWpUser(auth.slice(7))
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Accès refusé' }, { status: 403 })
  }

  const products = await fetchAllProducts()

  const header = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'additional_image_link', 'brand', 'sale_price']
  const lines = [header.join(',')]

  for (const p of products) {
    const image = p.images?.[0]?.src
    if (!image || !p.slug) continue
    const price = parseFloat(p.price || p.regular_price || '0')
    if (!price) continue

    const onSale = !!p.sale_price && parseFloat(p.sale_price) > 0 && parseFloat(p.sale_price) < parseFloat(p.regular_price || '0')
    const regularPrice = onSale ? parseFloat(p.regular_price) : price
    const additional = (p.images || []).slice(1, 5).map(img => img.src).join(';')
    const brand = p.store?.shop_name || p.store?.store_name || p.store?.name || 'MIAD Market'

    const row = [
      p.id,
      p.name,
      stripHtml(p.short_description || p.description || p.name).slice(0, 5000),
      p.stock_status === 'instock' ? 'in stock' : 'out of stock',
      'new',
      `${regularPrice.toFixed(2)} USD`,
      `${SITE}/product/${p.slug}`,
      image,
      additional,
      brand,
      onSale ? `${price.toFixed(2)} USD` : '',
    ].map(csvEscape).join(',')
    lines.push(row)
  }

  // BOM UTF-8 : Excel/Numbers ouvrent sinon les accents en charabia.
  const csv = '﻿' + lines.join('\r\n')

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="miad-catalogue-meta-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}

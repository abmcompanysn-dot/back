import { NextResponse } from 'next/server'
import { fetchWpUser, isAdmin, CATALOG_SVC_URL, VENDOR_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

const SITE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://miadmarket.ca').replace(/\/$/, '')

interface CatalogProduct {
  id: number
  slug: string
  name: string
  description: string
  price: string
  regular_price: string
  sale_price: string
  stock: number
  vendor_id: number
  images: { src: string }[]
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function csvEscape(value: unknown): string {
  const s = String(value ?? '')
  return /["\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function fetchAllProducts(): Promise<CatalogProduct[]> {
  const results: CatalogProduct[] = []
  let page = 1
  while (true) {
    const res = await fetch(`${CATALOG_SVC_URL}/products?page=${page}&page_size=100&lang=fr`, {
      next: { revalidate: 3600 },
    })
    if (!res.ok) break
    const data: any = await res.json().catch(() => ({}))
    const batch: CatalogProduct[] = data.items || []
    if (batch.length === 0) break
    results.push(...batch)
    if (!data.has_more || batch.length < 100) break
    page++
  }
  return results
}

// GET /api/admin/meta-csv — export CSV du catalogue pour import manuel dans
// Meta Commerce Manager. Mêmes champs que /merchant-feed.xml, en CSV.
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

  const vendorIds = Array.from(new Set(products.map((p) => p.vendor_id).filter(Boolean)))
  const vendorNamesById: Record<string, string> = {}
  if (vendorIds.length > 0) {
    const storesRes = await fetch(`${VENDOR_SVC_URL}/stores?page_size=100`, { next: { revalidate: 3600 } })
    if (storesRes.ok) {
      const storesData: any = await storesRes.json().catch(() => ({}))
      for (const s of (storesData.items || storesData.stores || [])) {
        vendorNamesById[String(s.id)] = s.store_name || s.name || 'Boutique'
      }
    }
  }

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
    const brand = vendorNamesById[String(p.vendor_id)] || 'MIAD Market'

    const row = [
      p.id,
      p.name,
      stripHtml(p.description || p.name).slice(0, 5000),
      p.stock > 0 ? 'in stock' : 'out of stock',
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

import { NextResponse } from 'next/server'
import { CATALOG_SVC_URL, VENDOR_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'

const BASE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://miadmarket.ca').replace(/\/$/, '')

interface CatalogProduct {
  id: number
  slug: string
  name: string
  description: string
  sku: string
  price: string
  regular_price: string
  sale_price: string
  status: string
  stock: number
  vendor_id: number
  images: { src: string }[]
}

// Migré vers catalog-svc : page_size/has_more natifs, plus besoin de la
// pagination par lots parallèles ni du contournement X-WP-TotalPages
// (spécifique à WooCommerce — voir l'historique de ce fichier pour le
// contexte de l'ancien bug, résolu par construction ici : catalog-svc
// renvoie le total exact dans le body JSON, jamais dans un en-tête).
async function fetchAllProducts(): Promise<CatalogProduct[]> {
  const PER_PAGE = 100
  const MAX_PAGES = 50 // garde-fou (5000 produits) contre une boucle infinie

  const all: CatalogProduct[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `${CATALOG_SVC_URL}/products?page=${page}&page_size=${PER_PAGE}&lang=fr`,
      { next: { revalidate: 3600 } }
    )
    if (!res.ok) break
    const data: any = await res.json().catch(() => ({}))
    const batch: CatalogProduct[] = data.items || []
    all.push(...batch)
    if (!data.has_more || batch.length < PER_PAGE) break
  }
  return all
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function buildItem(p: CatalogProduct, vendorNamesById: Record<string, string>): string {
  const title = escapeXml(p.name)
  const description = escapeXml(stripHtml(p.description || p.name).slice(0, 5000))
  const link = `${BASE}/product/${p.slug}`
  const image = p.images?.[0]?.src
  if (!image || !p.slug) return ''

  const price = parseFloat(p.price || p.regular_price || '0')
  if (!price) return ''

  const onSale = p.sale_price && parseFloat(p.sale_price) > 0 && parseFloat(p.sale_price) < parseFloat(p.regular_price || '0')
  const availability = p.stock > 0 ? 'in stock' : 'out of stock'
  const brand = escapeXml(vendorNamesById[String(p.vendor_id)] || 'MIAD Market')
  const additionalImages = (p.images || []).slice(1, 11)
    .map(img => `      <g:additional_image_link>${escapeXml(img.src)}</g:additional_image_link>`)
    .join('\n')

  return `
    <item>
      <g:id>${p.id}</g:id>
      <title>${title}</title>
      <description>${description}</description>
      <link>${link}</link>
      <g:image_link>${escapeXml(image)}</g:image_link>
${additionalImages}
      <g:condition>new</g:condition>
      <g:availability>${availability}</g:availability>
      <g:price>${(onSale ? parseFloat(p.regular_price) : price).toFixed(2)} USD</g:price>
      ${onSale ? `<g:sale_price>${price.toFixed(2)} USD</g:sale_price>` : ''}
      <g:brand>${brand}</g:brand>
      <g:identifier_exists>no</g:identifier_exists>
      ${p.sku ? `<g:mpn>${escapeXml(p.sku)}</g:mpn>` : ''}
    </item>`
}

export async function GET() {
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

  const items = products.flatMap((p) => {
    const item = buildItem(p, vendorNamesById)
    return item ? [item] : []
  }).join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>MIAD Market — Catalogue produits</title>
    <link>${BASE}</link>
    <description>Flux produits MIAD Market pour Google Merchant Center</description>
${items}
  </channel>
</rss>`

  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    },
  })
}

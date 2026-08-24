import { NextResponse } from 'next/server'

export const runtime = 'edge'

const BASE   = (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.miadmarket.com').replace(/\/$/, '')
const WOO    = (process.env.NEXT_PUBLIC_WOO_URL  || 'https://api.miadmarket.com').replace(/\/$/, '')
const WOO_CK = process.env.WOO_CONSUMER_KEY    || ''
const WOO_CS = process.env.WOO_CONSUMER_SECRET || ''

interface WcProduct {
  id: number
  slug: string
  name: string
  description: string
  short_description: string
  sku: string
  price: string
  regular_price: string
  sale_price: string
  stock_status: string
  images: { src: string }[]
  store?: { shop_name?: string; store_name?: string; name?: string }
}

// Meme pagination que app/sitemap.ts — auth par parametres d'URL uniquement
// (un header Authorization en plus fait echouer la requete WooCommerce).
//
// Les pages etaient recuperees en sequence (une requete WooCommerce apres
// l'autre) : avec ~800 produits publies ca fait 8+ aller-retours d'affilee
// avant meme de commencer a construire le XML, largement de quoi depasser
// le delai d'attente du robot d'indexation de Meta et faire remonter
// "0 produits" cote Commerce Manager (signale le 2026-08-10).
//
// 1ere tentative de correctif : lire X-WP-TotalPages sur la 1ere page pour
// lancer le reste en parallele. Regression decouverte le meme jour — sur ce
// runtime edge, le cache `next: { revalidate }` de fetch() ne preserve pas
// forcement cet en-tete personnalise sur une reponse servie depuis le
// cache, donc totalPages retombait a 1 en silence et le flux perdait 700+
// produits (797 -> 100, confirme par un fetch direct). Remplace par une
// pagination par lots en parallele qui ne depend d'aucun en-tete : on
// avance par paquets de PAGES_PER_BATCH pages tant que la derniere page du
// lot est pleine (signe qu'il en reste peut-etre), et on s'arrete des
// qu'une page renvoie moins de PER_PAGE produits.
function fetchProductsPage(page: number, perPage: number): Promise<Response> {
  const q = new URLSearchParams({
    per_page: String(perPage), page: String(page),
    status: 'publish',
    consumer_key: WOO_CK, consumer_secret: WOO_CS,
  })
  return fetch(`${WOO}/wp-json/wc/v3/products?${q}`, {
    headers: { 'User-Agent': 'MIAD-Headless-Client' },
    next: { revalidate: 3600 },
  })
}

async function fetchOnePage(page: number, perPage: number): Promise<WcProduct[]> {
  try {
    const res = await fetchProductsPage(page, perPage)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

async function fetchAllProducts(): Promise<WcProduct[]> {
  const PER_PAGE = 100
  const PAGES_PER_BATCH = 5
  const MAX_PAGES = 50 // garde-fou (5000 produits) contre une boucle infinie

  const all: WcProduct[] = []
  let page = 1

  while (page <= MAX_PAGES) {
    const batchPages = Array.from({ length: PAGES_PER_BATCH }, (_, i) => page + i)
    const batch = await Promise.all(batchPages.map((p) => fetchOnePage(p, PER_PAGE)))

    for (const pageProducts of batch) all.push(...pageProducts)

    const lastPage = batch[batch.length - 1]
    if (lastPage.length < PER_PAGE) break // derniere page du lot pas pleine : plus rien apres

    page += PAGES_PER_BATCH
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

function buildItem(p: WcProduct): string {
  const title = escapeXml(p.name)
  const description = escapeXml(stripHtml(p.short_description || p.description || p.name).slice(0, 5000))
  const link = `${BASE}/product/${p.slug}`
  const image = p.images?.[0]?.src
  if (!image || !p.slug) return ''

  const price = parseFloat(p.price || p.regular_price || '0')
  if (!price) return ''

  const onSale = p.sale_price && parseFloat(p.sale_price) > 0 && parseFloat(p.sale_price) < parseFloat(p.regular_price || '0')
  const availability = p.stock_status === 'instock' ? 'in stock' : 'out of stock'
  const brand = escapeXml(p.store?.shop_name || p.store?.store_name || p.store?.name || 'MIAD Market')
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

  const items = products.flatMap((p) => {
    const item = buildItem(p)
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

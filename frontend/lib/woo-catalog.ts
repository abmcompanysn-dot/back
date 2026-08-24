/**
 * Accès direct au catalogue WooCommerce (wc/v3/products), partagé par les
 * endpoints qui ont besoin du vrai catalogue côté edge (assistant IA,
 * recherche sémantique, génération d'embeddings) — pas de données mock.
 */

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')
const WOO_CK = process.env.WOO_CONSUMER_KEY
const WOO_CS = process.env.WOO_CONSUMER_SECRET
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET

export function hasWooCredentials(): boolean {
  return !!(WOO_CK && WOO_CS)
}

function wooHeaders(): Record<string, string> {
  const auth = Buffer.from(`${WOO_CK}:${WOO_CS}`).toString('base64')
  return {
    Authorization: `Basic ${auth}`,
    'User-Agent': 'MIAD-Headless-Client',
    ...(INTERNAL_SECRET ? { 'X-Headless-Secret': INTERNAL_SECRET } : {}),
    Accept: 'application/json',
  }
}

export interface CatalogProduct {
  id: number
  name: string
  slug: string
  price: number
  regularPrice: number
  currency: string
  image: string
  category: string
  categorySlug: string
  vendor: { name: string; slug: string }
  country: string
  countryCode: string
  inStock: boolean
  type: string
}

export function mapWooProduct(p: any): CatalogProduct {
  return {
    id: p.id,
    name: p.name || '',
    slug: p.slug || '',
    price: parseFloat(p.price || '0'),
    regularPrice: parseFloat(p.regular_price || p.price || '0'),
    currency: '$',
    image: p.images?.[0]?.src || '/placeholder.svg',
    category: p.categories?.[0]?.name || 'Général',
    categorySlug: p.categories?.[0]?.slug || '',
    vendor: {
      name: p.store?.shop_name || p.store?.store_name || 'Boutique',
      slug: p.store?.shop_url?.split('/').filter(Boolean).pop() || '',
    },
    country: p.store?.address?.country || '',
    countryCode: (p.store?.address?.country || '').toLowerCase(),
    inStock: p.stock_status === 'instock',
    type: p.type,
  }
}

export async function searchWooProducts(query: string, limit: number): Promise<any[]> {
  if (!hasWooCredentials()) return []
  const url = new URL(`${WOO_URL}/wp-json/wc/v3/products`)
  url.searchParams.set('status', 'publish')
  url.searchParams.set('per_page', String(Math.min(Math.max(limit, 4) * 5, 30)))
  if (query) url.searchParams.set('search', query)

  const res = await fetch(url.toString(), { headers: wooHeaders(), next: { revalidate: 300 } })
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

// lang optionnel mais fortement recommandé : sans lui, WPML applique son
// filtre de langue par défaut (pas le français) sur `include=`, comme
// constaté sur VendorStorePage/CategoryPage (voir CLAUDE.md, 2026-07-30) —
// un appelant qui omet lang peut se retrouver avec des IDs valides mais
// silencieusement filtrés côté WooCommerce.
export async function fetchWooProductsByIds(ids: (number | string)[], lang?: 'fr' | 'en'): Promise<any[]> {
  if (!hasWooCredentials() || !ids.length) return []
  const url = new URL(`${WOO_URL}/wp-json/wc/v3/products`)
  url.searchParams.set('include', ids.join(','))
  url.searchParams.set('per_page', String(ids.length))
  url.searchParams.set('status', 'publish')
  if (lang) url.searchParams.set('lang', lang)

  const res = await fetch(url.toString(), { headers: wooHeaders(), next: { revalidate: 300 } })
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

export async function fetchAllPublishedWooProducts(): Promise<any[]> {
  if (!hasWooCredentials()) return []
  const all: any[] = []
  let page = 1
  while (true) {
    const url = new URL(`${WOO_URL}/wp-json/wc/v3/products`)
    url.searchParams.set('status', 'publish')
    url.searchParams.set('per_page', '100')
    url.searchParams.set('page', String(page))
    const res = await fetch(url.toString(), { headers: wooHeaders(), cache: 'no-store' })
    if (!res.ok) break
    const batch = await res.json()
    if (!Array.isArray(batch) || batch.length === 0) break
    all.push(...batch)
    if (batch.length < 100) break
    page++
  }
  return all
}

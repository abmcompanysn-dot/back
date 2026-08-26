/**
 * Accès direct au catalogue (catalog-svc), partagé par les endpoints qui
 * ont besoin du vrai catalogue côté edge (assistant IA, recherche
 * sémantique, génération d'embeddings) — pas de données mock.
 */

import { CATALOG_SVC_URL, VENDOR_SVC_URL } from './miad-server-auth'

// Conservé pour compatibilité avec les appelants existants : catalog-svc
// n'a pas de credentials à vérifier (endpoints publics, pas de Basic
// Auth), donc toujours true — permet de ne pas toucher aux appelants qui
// font `if (!hasWooCredentials()) return` avant leur propre migration.
export function hasWooCredentials(): boolean {
  return true
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
      name: p.store?.store_name || 'Boutique',
      slug: p.store?.slug || '',
    },
    country: p.store?.country || '',
    countryCode: (p.store?.country || '').toLowerCase(),
    inStock: p.status === 'active',
    type: p.type,
  }
}

export async function searchWooProducts(query: string, limit: number): Promise<any[]> {
  const url = new URL(`${CATALOG_SVC_URL}/products`)
  url.searchParams.set('page_size', String(Math.min(Math.max(limit, 4) * 5, 30)))
  if (query) url.searchParams.set('q', query)

  const res = await fetch(url.toString(), { next: { revalidate: 300 } })
  if (!res.ok) return []
  const data = await res.json()
  return data.items || []
}

// fetchWooProductsByIds — utilisée par wishlist/panier (produits déjà
// connus par ID, pas une recherche). Enrichit désormais chaque produit
// avec un vrai objet `vendor` (nom, logo...) via vendor-svc, exactement
// comme app/api/products/route.ts mapProduct — dupliqué ici volontairement
// (pas d'appel HTTP interne fiable en edge runtime, où il n'existe pas
// d'URL de base connue sans configuration supplémentaire). Avant ce fix,
// cette fonction renvoyait les items catalog-svc BRUTS (vendor_id
// numérique, jamais d'objet vendor) — tout composant qui lit
// product.vendor.name plantait (bug de prod trouvé le 2026-08-26 : crash
// de CartPage.tsx juste après connexion, le panier étant fusionné depuis
// le serveur via cette fonction).
export async function fetchWooProductsByIds(ids: (number | string)[], lang?: 'fr' | 'en'): Promise<any[]> {
  if (!ids.length) return []
  const url = new URL(`${CATALOG_SVC_URL}/products`)
  url.searchParams.set('include', ids.join(','))
  if (lang) url.searchParams.set('lang', lang)

  const res = await fetch(url.toString(), { next: { revalidate: 300 } })
  if (!res.ok) return []
  const data = await res.json()
  const rawProducts: any[] = data.items || []
  if (rawProducts.length === 0) return []

  const vendorIds = Array.from(new Set(rawProducts.map((p) => p.vendor_id).filter(Boolean)))
  const vendorsById: Record<string, any> = {}
  if (vendorIds.length > 0) {
    const storesRes = await fetch(`${VENDOR_SVC_URL}/stores?page_size=100`, { next: { revalidate: 3600 } })
    if (storesRes.ok) {
      const storesData = await storesRes.json().catch(() => ({}))
      for (const s of storesData.items || storesData.stores || []) {
        vendorsById[String(s.id)] = s
      }
    }
  }

  return rawProducts.map((p) => {
    const store = vendorsById[String(p.vendor_id)]
    return {
      id: p.id || null,
      name: p.name || '',
      slug: p.slug || '',
      sku: p.sku || '',
      description: p.description || '',
      price: parseFloat(p.price || p.price_usd || '0'),
      regularPrice: parseFloat(p.regular_price || p.price || p.price_usd || '0'),
      salePrice: p.on_sale && p.sale_price ? parseFloat(p.sale_price) : undefined,
      onSale: !!p.on_sale,
      image: p.image || p.images?.[0]?.src || '/placeholder.svg',
      images: (p.images || []).map((img: any) => img.src || img),
      categories: p.category_id ? [{ name: '', slug: '' }] : [],
      category: 'Général',
      categorySlug: '',
      stock: p.stock ?? 0,
      inStock: (p.stock ?? 0) > 0 || p.status === 'active',
      manageStock: true,
      rating: 0,
      salesCount: 0,
      lang: (lang || p.lang || 'fr') as 'fr' | 'en',
      countryCode: store?.country || '',
      meta_data: [],
      attributes: [],
      defaultAttributes: [],
      vendor: store
        ? {
            id: String(p.vendor_id),
            name: store.store_name || store.name || 'Boutique',
            slug: store.slug || '',
            logo: store.gravatar || store.logo_url || '',
            banner: store.banner || store.banner_url || '',
            country: store.country || '',
            countryCode: store.country || '',
            rating: parseFloat(store.rating_avg || '0'),
            verified: !!store.verified,
            productCount: store.product_count || store.products_count || 0,
          }
        : p.vendor_id
          ? { id: String(p.vendor_id), name: 'Boutique', slug: '', logo: '', country: '', countryCode: '', rating: 0, verified: false, productCount: 0 }
          : null,
      type: p.type || 'simple',
    }
  })
}

export async function fetchAllPublishedWooProducts(): Promise<any[]> {
  const all: any[] = []
  let page = 1
  while (true) {
    const url = new URL(`${CATALOG_SVC_URL}/products`)
    url.searchParams.set('page_size', '100')
    url.searchParams.set('page', String(page))
    const res = await fetch(url.toString(), { cache: 'no-store' })
    if (!res.ok) break
    const data = await res.json()
    const batch = data.items || []
    if (batch.length === 0) break
    all.push(...batch)
    if (batch.length < 100) break
    page++
  }
  return all
}

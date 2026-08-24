/**
 * Accès direct au catalogue (catalog-svc), partagé par les endpoints qui
 * ont besoin du vrai catalogue côté edge (assistant IA, recherche
 * sémantique, génération d'embeddings) — pas de données mock.
 */

import { CATALOG_SVC_URL } from './miad-server-auth'

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

export async function fetchWooProductsByIds(ids: (number | string)[], lang?: 'fr' | 'en'): Promise<any[]> {
  if (!ids.length) return []
  const url = new URL(`${CATALOG_SVC_URL}/products`)
  url.searchParams.set('include', ids.join(','))
  if (lang) url.searchParams.set('lang', lang)

  const res = await fetch(url.toString(), { next: { revalidate: 300 } })
  if (!res.ok) return []
  const data = await res.json()
  return data.items || []
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

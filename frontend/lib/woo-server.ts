// Server-only WooCommerce data fetching — used by standalone SSR pages
// Calls WooCommerce directly (no internal API routes) to avoid BASE_URL issues

import { cache } from 'react'

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')
const WOO_CK = process.env.WOO_CONSUMER_KEY || ''
const WOO_CS = process.env.WOO_CONSUMER_SECRET || ''

const wooHeaders = () => ({
  Authorization: `Basic ${btoa(`${WOO_CK}:${WOO_CS}`)}`,
  'User-Agent': 'MIAD-Headless-Client',
  Accept: 'application/json',
})

const dokanQuery = () => `consumer_key=${WOO_CK}&consumer_secret=${WOO_CS}`

const MIAD_PRODUCTS_API = process.env.MIAD_PRODUCTS_API || `${WOO_URL}/wp-json/miad-products/v1`
const MIAD_PRODUCTS_SECRET = process.env.MIAD_PRODUCTS_SECRET || ''

function getCountryCode(store: any): string {
  if (!store?.address || typeof store.address !== 'object' || Array.isArray(store.address)) return ''
  return store.address.country || ''
}

function mapProduct(p: any): any {
  return {
    id: p.id || null,
    name: p.name || '',
    slug: p.slug || '',
    sku: p.sku || '',
    description: p.description || '',
    price: parseFloat(p.price || '0'),
    regularPrice: parseFloat(p.regular_price || p.price || '0'),
    salePrice: p.sale_price ? parseFloat(p.sale_price) : undefined,
    image: p.images?.[0]?.src || '',
    images: p.images?.map((img: any) => img.src) || [],
    categories: p.categories?.map((c: any) => ({ name: c.name || '', slug: c.slug || '' })) || [],
    category: p.categories?.[0]?.name || '',
    categorySlug: p.categories?.[0]?.slug || '',
    stock: p.stock_quantity ?? 0,
    inStock: p.stock_status === 'instock',
    rating: parseFloat(p.average_rating || '0'),
    salesCount: p.rating_count || 0,
    countryCode: getCountryCode(p.store),
    country: getCountryCode(p.store),
    currency: '$',
    lang: 'fr' as const,
    type: p.type || 'simple',
    attributes: p.attributes?.map((a: any) => ({
      name: a.name || '',
      options: a.options || [],
      variation: !!a.variation,
    })) || [],
    defaultAttributes: p.default_attributes?.map((d: any) => ({ name: d.name, option: d.option })) || [],
    vendor: p.store
      ? {
          id: p.store.id?.toString() || null,
          name: p.store.shop_name || p.store.store_name || p.store.name || 'Boutique',
          slug: p.store.shop_url?.split('/').filter(Boolean).pop() || '',
          logo: p.store.avatar || p.store.gravatar || '',
          banner: p.store.banner || '',
          countryCode: getCountryCode(p.store),
          country: getCountryCode(p.store),
          rating: parseFloat(p.store.rating || '0'),
          verified: !!p.store.enabled,
          productCount: p.store.product_count || 0,
        }
      : null,
    variations: [],
  }
}

function mapStore(s: any, override?: { logo?: string; banner?: string }): any {
  return {
    id: s.id?.toString() || null,
    name: s.store_name || 'Vendeur',
    slug: s.shop_url?.split('/').filter(Boolean).pop() || '',
    logo: override?.logo || s.gravatar || '',
    banner: override?.banner || s.banner || '',
    country: s.address?.country || '',
    countryCode: s.address?.country || '',
    rating: parseFloat(s.rating?.rating || '0'),
    verified: !!s.enabled,
    productCount: s.products_count || 0,
  }
}

// Dokan ne reflète jamais l'URL CDN pour gravatar/banner (incident du
// 2026-07-04, reconfirmé le 2026-07-14 — voir CLAUDE.md). Même override que
// app/api/stores/route.ts, manquant ici jusqu'au 2026-07-17 : la route SEO
// /vendor/[slug] (qui appelle fetchStores(), pas /api/stores) affichait donc
// encore le logo/bannière Dokan cassé même après un override posé côté admin.
async function getVendorImageOverrides(): Promise<Record<string, { logo?: string; banner?: string }>> {
  try {
    const res = await fetch(`${MIAD_PRODUCTS_API}/vendor-image-overrides`, {
      headers: { 'Accept': 'application/json' },
      next: { revalidate: 300 },
    })
    if (!res.ok) return {}
    const data: any = await res.json().catch(() => ({}))
    return data.overrides || {}
  } catch {
    return {}
  }
}

async function fetchRawProduct(slug: string, lang?: string): Promise<any | null> {
  const isNumeric = /^\d+$/.test(slug)
  const langParam = lang ? `&lang=${lang}` : ''
  const url = isNumeric
    ? `${WOO_URL}/wp-json/wc/v3/products/${slug}?${lang ? `lang=${lang}` : ''}`
    : `${WOO_URL}/wp-json/wc/v3/products?slug=${slug}&status=publish${langParam}`

  const res = await fetch(url, {
    headers: wooHeaders(),
    next: { revalidate: 3600, tags: [`product-${slug}`] },
  })
  if (!res.ok) return null
  const text = await res.text()
  if (text.trim().startsWith('<')) return null
  const data = JSON.parse(text)
  const raw = Array.isArray(data) ? data[0] : data
  return raw?.id ? raw : null
}

export async function fetchProductBySlug(slug: string): Promise<any | null> {
  try {
    // Try French and default-language slug lookup in parallel to avoid serial round-trips
    const [frRaw, fallback] = await Promise.all([
      fetchRawProduct(slug, 'fr'),
      fetchRawProduct(slug),
    ])

    let raw = frRaw
    if (!raw) {
      if (!fallback?.id) return null
      // Re-fetch by ID with lang=fr to get the French content
      raw = (await fetchRawProduct(String(fallback.id), 'fr')) ?? fallback
    }

    if (!raw) return null

    const product = mapProduct(raw)

    // Fetch variations if variable
    if (raw.type === 'variable') {
      const varRes = await fetch(
        `${WOO_URL}/wp-json/wc/v3/products/${raw.id}/variations?per_page=100&lang=fr`,
        { headers: wooHeaders(), next: { revalidate: 3600 } }
      )
      if (varRes.ok) {
        const vars = await varRes.json()
        product.variations = vars.map((v: any) => ({
          id: v.id?.toString(),
          price: parseFloat(v.price || '0'),
          regularPrice: parseFloat(v.regular_price || v.price || '0'),
          stock: v.stock_quantity || 0,
          inStock: v.stock_status === 'instock',
          image: v.image?.src || product.image,
          attributes: v.attributes?.map((a: any) => ({ name: a.name, option: a.option })) || [],
        }))
      }
    }

    return product
  } catch {
    return null
  }
}

// cache() : plusieurs sections de l'accueil (par pays, boutiques mises en
// avant) demandent la même donnée dans le même rendu — un seul fetch réel.
export const fetchStores = cache(async (perPage = 100): Promise<any[]> => {
  try {
    const url = `${WOO_URL}/wp-json/dokan/v1/stores?per_page=${perPage}&${dokanQuery()}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'MIAD-Headless-Client', Accept: 'application/json' },
      next: { revalidate: 3600, tags: ['stores'] },
    })
    if (!res.ok) return []
    const data = await res.json()
    const list = Array.isArray(data) ? data : data.stores || []
    const overrides = await getVendorImageOverrides()
    // Comptes vendeur jamais finalisés (aucun nom de boutique renseigné) — ne
    // doivent pas apparaître comme "boutiques" sur le site public.
    return list.reduce((acc: any[], s: any) => {
      if (s.store_name && s.store_name.trim() !== '') acc.push(mapStore(s, overrides[String(s.id)]))
      return acc
    }, [])
  } catch {
    return []
  }
})

export const fetchInitialProducts = cache(async (perPage = 100, lang: 'fr' | 'en' = 'fr'): Promise<any[]> => {
  try {
    const url = `${WOO_URL}/wp-json/wc/v3/products?per_page=${perPage}&status=publish&lang=${lang}&orderby=date&order=desc`
    const res = await fetch(url, {
      headers: wooHeaders(),
      next: { revalidate: 60 },
    })
    if (!res.ok) return []
    const data = await res.json()
    return (Array.isArray(data) ? data : []).map(mapProduct).map((p: any) => ({ ...p, lang }))
  } catch {
    return []
  }
})

// Vrais produits en promotion (prix barré réel côté WooCommerce) — utilisé sur
// la page /promotions, qui affichait jusqu'ici des codes et une remise fictifs.
// cache() : plusieurs sections de l'accueil (Flash Sales, Deals) demandent la
// même donnée dans le même rendu — un seul fetch réel par requête au lieu de N.
export const fetchOnSaleProducts = cache(async (perPage = 24): Promise<any[]> => {
  try {
    const url = `${WOO_URL}/wp-json/wc/v3/products?per_page=${perPage}&status=publish&on_sale=true&lang=fr&orderby=date&order=desc`
    const res = await fetch(url, {
      headers: wooHeaders(),
      next: { revalidate: 300 },
    })
    if (!res.ok) return []
    const data = await res.json()
    return (Array.isArray(data) ? data : []).map(mapProduct)
  } catch {
    return []
  }
})

// Coupons WooCommerce actifs (non expirés) — pour n'afficher que des codes
// promo réellement utilisables au checkout, pas des exemples codés en dur.
export async function fetchActiveCoupons(): Promise<any[]> {
  try {
    const url = `${WOO_URL}/wp-json/wc/v3/coupons?per_page=20&orderby=date&order=desc`
    const res = await fetch(url, {
      headers: wooHeaders(),
      next: { revalidate: 300 },
    })
    if (!res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data)) return []
    const now = Date.now()
    return data.reduce((acc: any[], c: any) => {
      if (!c.date_expires || new Date(c.date_expires).getTime() > now) {
        acc.push({
          code: c.code,
          discountType: c.discount_type,
          amount: c.amount,
          minimumAmount: c.minimum_amount || '',
        })
      }
      return acc
    }, [])
  } catch {
    return []
  }
}

export async function fetchInitialCategories(): Promise<any[]> {
  try {
    const url = `${WOO_URL}/wp-json/wc/v3/products/categories?per_page=50&lang=fr&orderby=count&order=desc&hide_empty=true`
    const res = await fetch(url, {
      headers: wooHeaders(),
      next: { revalidate: 3600 },
    })
    if (!res.ok) return []
    const data = await res.json()
    return (Array.isArray(data) ? data : []).map((c: any) => ({
      id: String(c.id),
      name: c.name || '',
      slug: c.slug || '',
      image: c.image?.src || '',
      productCount: c.count || 0,
      lang: 'fr' as const,
    }))
  } catch {
    return []
  }
}

// /wp-json/dokan/v1/stores/{id}/products est cassé côté WordPress : il
// renvoie toujours les produits du vendeur 95 quel que soit l'{id} demandé
// dans l'URL (constaté le 2026-07-10, corrigé dans app/api/products/route.ts
// à ce moment-là — mais cette fonction, utilisée par la page SEO dédiée
// /vendor/[slug], avait été oubliée et appelait toujours l'endpoint cassé en
// PRIMARY : comme il répond 200 (juste avec les mauvais produits), le repli
// wc/v3?author= ne se déclenchait jamais. Même correctif ici : IDs réels via
// une requête SQL directe (/vendor-product-ids), puis wc/v3?include=.
export async function fetchProductsByVendor(
  vendorId: string,
  page = 1,
  perPage = 100
): Promise<{ products: any[]; total: number; totalPages: number }> {
  try {
    const idsRes = await fetch(`${MIAD_PRODUCTS_API}/vendor-product-ids?vendorId=${vendorId}`, {
      headers: { 'x-miad-products-secret': MIAD_PRODUCTS_SECRET, Accept: 'application/json' },
      next: { revalidate: 3600, tags: [`vendor-${vendorId}`] },
    })
    if (!idsRes.ok) throw new Error('vendor-product-ids failed')
    const idsData: any = await idsRes.json().catch(() => ({}))
    const allIds: number[] = idsData.ids || []
    const total = allIds.length
    const totalPages = Math.max(1, Math.ceil(total / perPage))
    const startIdx = (page - 1) * perPage
    const pageIds = allIds.slice(startIdx, startIdx + perPage)

    if (pageIds.length === 0) return { products: [], total, totalPages }

    const url = `${WOO_URL}/wp-json/wc/v3/products?include=${pageIds.join(',')}&per_page=${perPage}&status=publish&lang=fr`
    const res = await fetch(url, {
      headers: wooHeaders(),
      next: { revalidate: 3600, tags: [`vendor-${vendorId}`] },
    })
    if (!res.ok) return { products: [], total, totalPages }
    const data = await res.json()
    const products = (Array.isArray(data) ? data : []).map(mapProduct)
    return { products, total, totalPages }
  } catch {
    return { products: [], total: 0, totalPages: 0 }
  }
}

// Section "Alimentation" de l'accueil — même critère que le filtre client
// historique (categorySlug === slug dans HomePage.tsx), déplacé côté serveur
// pour pouvoir streamer indépendamment. Filtre sur le lot déjà mis en cache
// par fetchInitialProducts() plutôt qu'un nouvel appel réseau dédié.
export async function fetchProductsByCategorySlug(categorySlug: string, limit = 8, lang: 'fr' | 'en' = 'fr'): Promise<any[]> {
  const products = await fetchInitialProducts(100, lang)
  return products.filter((p: any) => p.categorySlug === categorySlug).slice(0, limit)
}

// Regroupement produits+boutiques par pays pour les sections "Marché [Pays]"
// de l'accueil — même logique que productsByCountry/storesByCountry dans
// MiadMarketClient.tsx, déplacée côté serveur. cache() : un seul appel réel
// même si plusieurs CountrySectionServer (un par pays) l'utilisent.
export const fetchHomeCountryData = cache(async (): Promise<{
  productsByCountry: Record<string, any[]>
  storesByCountry: Record<string, any[]>
}> => {
  const [products, stores] = await Promise.all([fetchInitialProducts(100), fetchStores(100)])

  const productsByCountry: Record<string, any[]> = {}
  products.forEach((p: any) => {
    const code = (p.countryCode || 'sn').toLowerCase()
    if (!productsByCountry[code]) productsByCountry[code] = []
    productsByCountry[code].push(p)
  })

  const storesByCountry: Record<string, any[]> = {}
  stores.forEach((s: any) => {
    const code = (s.countryCode || 'sn').toLowerCase()
    if (!storesByCountry[code]) storesByCountry[code] = []
    storesByCountry[code].push(s)
  })

  return { productsByCountry, storesByCountry }
})

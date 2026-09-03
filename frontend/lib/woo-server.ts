// Module SSR central catalogue/boutiques — appelle directement le backend
// Go (catalog-svc/vendor-svc via la passerelle unique origin.miadmarket.ca).
//
// productToWooShape/vendorToDokanShape côté Go ont été conçus pour
// ressembler au format WooCommerce/Dokan attendu ici — mapProduct/mapStore
// restent donc presque identiques à leur version WordPress, seule la
// source des appels change.

import { cache } from 'react'
import { CATALOG_SVC_URL, VENDOR_SVC_URL, LOYALTY_SVC_URL } from './miad-server-auth'
import { decodeHtmlEntities } from './utils'

function getCountryCode(store: any): string {
  if (!store?.address || typeof store.address !== 'object' || Array.isArray(store.address)) return ''
  return store.address.country || ''
}

function mapProduct(p: any): any {
  return {
    id: p.id || null,
    // Décodage entités HTML — catalog-svc renvoie des noms échappés hérités
    // de WooCommerce ("Rouge &amp; Blanc"). Cf. app/api/products/route.ts.
    name: decodeHtmlEntities(p.name || ''),
    slug: p.slug || '',
    sku: p.sku || '',
    description: decodeHtmlEntities(p.description || ''),
    price: parseFloat(p.price || '0'),
    regularPrice: parseFloat(p.regular_price || p.price || '0'),
    salePrice: p.on_sale && p.sale_price ? parseFloat(p.sale_price) : undefined,
    onSale: !!p.on_sale,
    image: p.images?.[0]?.src || '',
    images: p.images?.map((img: any) => img.src) || [],
    categories: p.categories?.map((c: any) => ({ name: c.name || '', slug: c.slug || '' })) || [],
    category: p.categories?.[0]?.name || '',
    categorySlug: p.categories?.[0]?.slug || '',
    stock: p.stock_quantity ?? 0,
    inStock: p.stock_status ? p.stock_status === 'instock' : p.status === 'active',
    weightKg: p.weight_kg ?? undefined,
    lengthCm: p.length_cm ?? undefined,
    widthCm: p.width_cm ?? undefined,
    heightCm: p.height_cm ?? undefined,
    originCountry: p.origin_country || undefined,
    // Sous-titre + tableau de caractéristiques (catalog-svc 2026-08-31),
    // décodage entités HTML comme name/description. Cf. app/api/products/route.ts.
    subtitle: decodeHtmlEntities(p.subtitle || ''),
    specifications: Array.isArray(p.specifications)
      ? p.specifications
          .filter((s: any) => s && (s.k || s.key) && (s.v || s.value))
          .map((s: any) => ({
            k: decodeHtmlEntities(String(s.k ?? s.key ?? '')),
            v: decodeHtmlEntities(String(s.v ?? s.value ?? '')),
            source: s.source === 'ai' ? 'ai' : 'vendor',
          }))
      : [],
    rating: parseFloat(p.average_rating || '0'),
    salesCount: p.rating_count || 0,
    countryCode: getCountryCode(p.store),
    country: getCountryCode(p.store),
    currency: '$',
    lang: (p.lang as 'fr' | 'en') || 'fr',
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
          name: p.store.store_name || p.store.name || 'Boutique',
          slug: p.store.slug || '',
          logo: p.store.gravatar || p.store.logo_url || '',
          banner: p.store.banner || p.store.banner_url || '',
          countryCode: getCountryCode(p.store),
          country: getCountryCode(p.store),
          rating: parseFloat(p.store.rating_avg || '0'),
          verified: !!p.store.enabled,
          productCount: p.store.product_count || 0,
        }
      : null,
    variations: (p.variations || []).map((v: any) => ({
      id: v.id?.toString(),
      price: parseFloat(v.price || '0'),
      regularPrice: parseFloat(v.price || '0'),
      stock: v.stock || 0,
      inStock: !!v.in_stock,
      image: v.image_url || '',
      attributes: v.attributes || {},
    })),
  }
}

// Version allégée de mapProduct — pour les listes de cartes produit de
// l'accueil (fetchInitialProducts/fetchCategoryRow), PAS pour la fiche
// produit détaillée (fetchProductBySlug garde mapProduct complet).
//
// Trouvé le 2026-09-03 : la page d'accueil pesait 316 Ko de HTML, dont la
// majorité était le payload React (self.__next_f.push) sérialisant ~47
// produits avec TOUS les champs de mapProduct (poids, dimensions,
// spécifications, variations, attributs bruts, vendeur complet...) — la
// plupart valant $undefined ou [] pour la majorité du catalogue (306
// occurrences de $undefined mesurées sur cette seule page). Une carte
// produit d'accueil (ProductCard.tsx/LinkProductCard.tsx) n'a jamais lu
// que les champs ci-dessous — vérifié champ par champ dans les deux
// composants avant de couper le reste, et confirmé qu'aucun composant
// panier/checkout ne lit de champ au-delà de ceux-ci sur un item du
// panier (addToCart stocke le produit tel quel dans le panier).
function mapProductCard(p: any): any {
  return {
    id: p.id || null,
    name: decodeHtmlEntities(p.name || ''),
    slug: p.slug || '',
    price: parseFloat(p.price || '0'),
    regularPrice: parseFloat(p.regular_price || p.price || '0'),
    salePrice: p.on_sale && p.sale_price ? parseFloat(p.sale_price) : undefined,
    onSale: !!p.on_sale,
    image: p.images?.[0]?.src || '',
    categorySlug: p.categories?.[0]?.slug || '',
    stock: p.stock_quantity ?? 0,
    inStock: p.stock_status ? p.stock_status === 'instock' : p.status === 'active',
    rating: parseFloat(p.average_rating || '0'),
    salesCount: p.rating_count || 0,
    countryCode: getCountryCode(p.store),
    currency: '$',
    lang: (p.lang as 'fr' | 'en') || 'fr',
    type: p.type || 'simple',
    vendor: p.store
      ? {
          id: p.store.id?.toString() || null,
          name: p.store.store_name || p.store.name || 'Boutique',
          slug: p.store.slug || '',
        }
      : null,
  }
}

function mapStore(s: any): any {
  return {
    id: s.id?.toString() || null,
    name: s.store_name || s.name || 'Vendeur',
    slug: s.slug || '',
    logo: s.gravatar || s.logo_url || '',
    banner: s.banner || s.banner_url || '',
    country: s.country || '',
    countryCode: s.country || '',
    rating: parseFloat(s.rating_avg || '0'),
    verified: !!s.enabled,
    productCount: s.products_count || s.product_count || 0,
  }
}

export async function fetchProductBySlug(slug: string): Promise<any | null> {
  try {
    // Recherche par slug d'abord (produit publié récent), repli par ID si
    // le paramètre est numérique — catalog-svc supporte les deux filtres
    // nativement sur GET /products, plus besoin des 2-3 appels parallèles
    // qu'exigeait le contournement du filtrage WPML silencieux sous WordPress.
    const isNumeric = /^\d+$/.test(slug)
    const url = isNumeric
      ? `${CATALOG_SVC_URL}/products/${slug}?lang=fr`
      : `${CATALOG_SVC_URL}/products?slug=${encodeURIComponent(slug)}&lang=fr`

    const res = await fetch(url, { next: { revalidate: 3600, tags: [`product-${slug}`] } })
    if (!res.ok) return null
    const data = await res.json()
    let raw = isNumeric ? data : data.items?.[0]
    if (!raw?.id) return null

    // GET /products?slug= (liste) renvoie description / subtitle /
    // specifications VIDES — seul GET /products/{id} (détail) les remplit.
    // Une fiche produit a besoin de la fiche complète (description, tableau
    // de caractéristiques, variations…) : on refait donc systématiquement
    // un appel par id après avoir résolu le slug. Sinon la section
    // DESCRIPTION affiche "Aucune description disponible" alors que la
    // donnée existe bien en base (bug fondateur 2026-09-02).
    if (!isNumeric) {
      const full = await fetch(`${CATALOG_SVC_URL}/products/${raw.id}?lang=fr`, {
        next: { revalidate: 3600, tags: [`product-${slug}`, `product-${raw.id}`] },
      })
      if (full.ok) {
        const fullData = await full.json()
        if (fullData?.id) raw = fullData
      }
    }

    return mapProduct(raw)
  } catch {
    return null
  }
}

// cache() : plusieurs sections de l'accueil (par pays, boutiques mises en
// avant) demandent la même donnée dans le même rendu — un seul fetch réel.
export const fetchStores = cache(async (perPage = 100): Promise<any[]> => {
  try {
    const res = await fetch(`${VENDOR_SVC_URL}/stores?page_size=${perPage}`, {
      next: { revalidate: 3600, tags: ['stores'] },
    })
    if (!res.ok) return []
    const data = await res.json()
    const list = data.items || data.stores || []
    // Comptes vendeur jamais finalisés (aucun nom de boutique renseigné) — ne
    // doivent pas apparaître comme "boutiques" sur le site public.
    return list.reduce((acc: any[], s: any) => {
      const name = s.store_name || s.name
      if (name && name.trim() !== '') acc.push(mapStore(s))
      return acc
    }, [])
  } catch {
    return []
  }
})

// fetchVendorBySlug — recherche ciblée d'UNE boutique (?slug=X côté
// vendor-svc, ajouté le 2026-08-28). app/vendor/[slug]/page.tsx cherchait
// jusqu'ici la boutique via fetchStores() (limité aux 100 premières,
// triées par note) — une boutique hors de ce lot donnait un faux
// notFound() malgré une URL /vendor/X valide.
export const fetchVendorBySlug = cache(async (slug: string): Promise<any | null> => {
  try {
    const res = await fetch(`${VENDOR_SVC_URL}/stores?slug=${encodeURIComponent(slug)}&page_size=1`, {
      next: { revalidate: 300, tags: [`vendor-${slug}`] },
    })
    if (!res.ok) return null
    const data = await res.json()
    const list = data.items || data.stores || []
    const raw = list[0]
    if (!raw) return null
    const name = raw.store_name || raw.name
    if (!name || name.trim() === '') return null
    return mapStore(raw)
  } catch {
    return null
  }
})

export const fetchInitialProducts = cache(async (perPage = 100, lang: 'fr' | 'en' = 'fr'): Promise<any[]> => {
  try {
    const res = await fetch(`${CATALOG_SVC_URL}/products?page_size=${perPage}&lang=${lang}`, {
      next: { revalidate: 60 },
    })
    if (!res.ok) return []
    const data = await res.json()
    // mapProductCard (allégé) — cette fonction n'alimente que des sections
    // d'accueil affichées en cartes (FoodServer via fetchProductsByCategorySlug,
    // fetchHomeCountryData). Voir le commentaire sur mapProductCard.
    return (data.items || []).map(mapProductCard).map((p: any) => ({ ...p, lang }))
  } catch {
    return []
  }
})

// Vrais produits en promotion (prix barré réel côté catalog-svc) — utilisé
// sur la page /promotions.
export const fetchOnSaleProducts = cache(async (perPage = 24): Promise<any[]> => {
  try {
    const res = await fetch(`${CATALOG_SVC_URL}/products?page_size=${perPage}&on_sale=true&lang=fr`, {
      next: { revalidate: 300 },
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.items || []).map(mapProduct)
  } catch {
    return []
  }
})

// Coupons actifs — pour n'afficher que des codes promo réellement
// utilisables au checkout, pas des exemples codés en dur.
export async function fetchActiveCoupons(): Promise<any[]> {
  try {
    const res = await fetch(`${LOYALTY_SVC_URL}/coupons`, { next: { revalidate: 300 } })
    if (!res.ok) return []
    const data = await res.json()
    const list = data.items || data.coupons || []
    const now = Date.now()
    return list.reduce((acc: any[], c: any) => {
      if (!c.expires_at || new Date(c.expires_at).getTime() > now) {
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
    const res = await fetch(`${CATALOG_SVC_URL}/categories?lang=fr`, { next: { revalidate: 3600 } })
    if (!res.ok) return []
    const data = await res.json()
    // catalog-svc renvoie { categories: [...] } avec productCount (camelCase)
    // — pas { items } ni product_count. Sans ce fallback, fetchInitialCategories
    // renvoyait [] (rangées catégorie de l'accueil jamais affichées, constaté
    // le 2026-08-28).
    const list = data.categories || data.items || []
    return list.map((c: any) => ({
      id: String(c.id),
      name: c.name || '',
      slug: c.slug || '',
      image: c.image_url || c.image?.src || '',
      productCount: c.productCount ?? c.product_count ?? c.count ?? 0,
      isRoot: c.isRoot ?? (c.parent_id === 0 || c.parent === 0),
      lang: 'fr' as const,
    }))
  } catch {
    return []
  }
}

// Le filtre ?vendor_id= existe nativement sur GET /products côté
// catalog-svc — remplace tout le contournement WordPress (vendor-product-ids
// + include=), qui n'était nécessaire que parce que
// dokan/v1/stores/{id}/products était cassé (ignorait l'{id} demandé).
export async function fetchProductsByVendor(
  vendorId: string,
  page = 1,
  perPage = 100
): Promise<{ products: any[]; total: number; totalPages: number }> {
  try {
    const res = await fetch(
      `${CATALOG_SVC_URL}/products?vendor_id=${vendorId}&page=${page}&page_size=${perPage}&lang=fr`,
      { next: { revalidate: 3600, tags: [`vendor-${vendorId}`] } }
    )
    if (!res.ok) return { products: [], total: 0, totalPages: 0 }
    const data = await res.json()
    return {
      products: (data.items || []).map(mapProduct),
      total: data.total || 0,
      totalPages: data.total_pages || 1,
    }
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

// fetchCategoryRow — première page (N produits) d'une catégorie + son
// nombre total de pages, pour les rangées catégorie de l'accueil
// (CategoryRow.tsx). Résout d'abord le slug en id de terme (catalog-svc
// GET /products attend category_id, pas le slug — même piège que
// app/api/products/route.ts, cf. CLAUDE.md frontend), puis pagine.
export async function fetchCategoryRow(
  categorySlug: string,
  perPage = 6,
  lang: 'fr' | 'en' = 'fr'
): Promise<{ products: any[]; totalPages: number }> {
  try {
    // slug -> id
    const catRes = await fetch(`${CATALOG_SVC_URL}/categories?lang=${lang}`, { next: { revalidate: 3600 } })
    if (!catRes.ok) return { products: [], totalPages: 0 }
    const catData = await catRes.json()
    // Slugs en base suffixés par langue (`-fr`/`-en`) — cf. catalog-svc
    // listCategories. Match tolérant : exact, slug+`-<lang>`, ou slug de base.
    const wanted = categorySlug.replace(/-(fr|en)$/, '')
    const cats = catData.items || catData.categories || []
    const match =
      cats.find((c: any) => c.slug === categorySlug) ||
      cats.find((c: any) => c.slug === `${wanted}-${lang}`) ||
      cats.find((c: any) => String(c.slug || '').replace(/-(fr|en)$/, '') === wanted)
    if (!match?.id) return { products: [], totalPages: 0 }

    const res = await fetch(
      `${CATALOG_SVC_URL}/products?category_id=${match.id}&page=1&page_size=${perPage}&lang=${lang}`,
      { next: { revalidate: 900, tags: ['products', `category-${categorySlug}`] } }
    )
    if (!res.ok) return { products: [], totalPages: 0 }
    const data = await res.json()
    // mapProductCard (allégé) — n'alimente que les rangées catégorie de
    // l'accueil (CategorySections.tsx → CategoryRow.tsx → ProductCard).
    return {
      products: (data.items || []).map(mapProductCard),
      totalPages: data.total_pages || 1,
    }
  } catch {
    return { products: [], totalPages: 0 }
  }
}

// fetchCategoryWithProducts — pour la route SEO /categorie/[slug] :
// résout la catégorie (nom + id, match tolérant sur le suffixe -fr/-en),
// puis ramène jusqu'à `limit` produits pour le JSON-LD ItemList + le
// premier rendu. Renvoie null si la catégorie n'existe pas.
export async function fetchCategoryWithProducts(
  categorySlug: string,
  limit = 48,
  lang: 'fr' | 'en' = 'fr'
): Promise<{
  category: { id: number; name: string; slug: string; description?: string; productCount?: number }
  products: any[]
  total: number
} | null> {
  try {
    const catRes = await fetch(`${CATALOG_SVC_URL}/categories?lang=${lang}`, { next: { revalidate: 3600 } })
    if (!catRes.ok) return null
    const catData = await catRes.json()
    const cats = catData.items || catData.categories || []
    const wanted = categorySlug.replace(/-(fr|en)$/, '')
    const match =
      cats.find((c: any) => c.slug === categorySlug) ||
      cats.find((c: any) => c.slug === `${wanted}-${lang}`) ||
      cats.find((c: any) => String(c.slug || '').replace(/-(fr|en)$/, '') === wanted)
    if (!match?.id) return null

    const res = await fetch(
      `${CATALOG_SVC_URL}/products?category_id=${match.id}&page=1&page_size=${limit}&lang=${lang}`,
      { next: { revalidate: 900, tags: ['products', `category-${categorySlug}`] } }
    )
    const data = res.ok ? await res.json() : { items: [], total: 0 }
    return {
      category: {
        id: match.id,
        name: decodeHtmlEntities(match.name || wanted),
        slug: String(match.slug || categorySlug).replace(/-(fr|en)$/, ''),
        description: match.description ? decodeHtmlEntities(match.description) : undefined,
        productCount: match.product_count ?? match.count ?? undefined,
      },
      products: (data.items || []).map(mapProduct),
      total: data.total ?? (data.items || []).length,
    }
  } catch {
    return null
  }
}

// Regroupement produits+boutiques par pays pour les sections "Marché [Pays]"
// de l'accueil. Le pays vient du vendeur (vendor.country côté catalog-svc,
// pas d'attribut pays direct sur le produit) — cohérent avec vendorToDokanShape.
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

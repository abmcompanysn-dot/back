/**
 * MIAD Market - Algorithme de recommandation de produits
 *
 * Signal de priorité :
 *  1. Similarité sémantique (Vectorize) avec le dernier produit vu — capture
 *     l'intention réelle ("ce type de produit"), pas juste sa catégorie.
 *  2. Historique de navigation + commandes, catégorie la plus représentée.
 *  3. Repli sur les produits populaires/tendance si aucun signal disponible.
 */
import { type WooProduct } from './woocommerce'
import { getRecentlyViewedIds } from './recently-viewed'

async function fetchSemanticallySimilar(productId: string, limit: number): Promise<WooProduct[]> {
  try {
    const res = await fetch(`/api/products/${productId}/similar?limit=${limit}`)
    if (!res.ok) return []
    const data = await res.json()
    const ids: string[] = data.ids || []
    if (!ids.length) return []
    return fetchProductsByIds(ids)
  } catch {
    return []
  }
}

async function fetchProductsByIds(ids: string[]): Promise<WooProduct[]> {
  if (!ids.length) return []
  const results = await Promise.all(
    ids.map((id) =>
      fetch(`/api/products?id=${id}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    )
  )
  return results.flatMap((r) => {
    const product = r?.products?.[0]
    return product ? [product] : []
  })
}

async function getPurchasedProductIds(): Promise<string[]> {
  try {
    const token = localStorage.getItem('miad_token') || localStorage.getItem('token')
    if (!token) return []
    const res = await fetch('/api/customer', { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return []
    const json = await res.json()
    const orders = json?.data?.recentOrders || []
    return orders
      .flatMap((o: any) => (o.line_items || []).map((li: any) => String(li.product_id)))
      .slice(0, 10)
  } catch {
    return []
  }
}

function mostFrequentCategory(products: WooProduct[]): { slug: string; name: string } | null {
  const counts = new Map<string, { name: string; count: number }>()
  for (const p of products) {
    if (!p.categorySlug) continue
    const entry = counts.get(p.categorySlug) || { name: p.category, count: 0 }
    entry.count++
    counts.set(p.categorySlug, entry)
  }
  let best: { slug: string; name: string } | null = null
  let bestCount = 0
  for (const [slug, { name, count }] of counts) {
    if (count > bestCount) {
      bestCount = count
      best = { slug, name }
    }
  }
  return best
}

/**
 * Catégorie la plus consultée par ce visiteur (localStorage, pas de compte
 * requis) — sert à personnaliser des messages d'accueil selon le profil
 * plutôt que seulement le pays détecté (ex: bannière d'accueil).
 */
export async function getFavoriteCategoryFromHistory(): Promise<{ slug: string; name: string } | null> {
  const viewedIds = getRecentlyViewedIds()
  if (!viewedIds.length) return null
  const products = await fetchProductsByIds(viewedIds.slice(0, 5))
  return mostFrequentCategory(products)
}

/** Fiches complètes des derniers produits vus (section "Mon activité"). */
export async function fetchRecentlyViewedProducts(limit = 8): Promise<WooProduct[]> {
  return fetchProductsByIds(getRecentlyViewedIds().slice(0, limit))
}

export async function fetchRecommendedProducts(excludeIds: (string | number)[] = [], limit = 8): Promise<WooProduct[]> {
  const exclude = new Set(excludeIds.map(String))

  const [viewedIds, purchasedIds] = await Promise.all([
    Promise.resolve(getRecentlyViewedIds()),
    getPurchasedProductIds(),
  ])

  const lastViewedId = viewedIds.find((id) => !exclude.has(id))
  if (lastViewedId) {
    const semantic = (await fetchSemanticallySimilar(lastViewedId, limit + exclude.size))
      .filter((p) => !exclude.has(String(p.id)))
    if (semantic.length >= limit) return semantic.slice(0, limit)
  }

  const signalIds = [...viewedIds.slice(0, 3), ...purchasedIds.slice(0, 3)].filter((id) => !exclude.has(id))

  let categorySlug: string | null = null
  if (signalIds.length) {
    const signalProducts = await fetchProductsByIds([...new Set(signalIds)].slice(0, 5))
    categorySlug = mostFrequentCategory(signalProducts)?.slug || null
  }

  let products: WooProduct[] = []
  if (categorySlug) {
    const res = await fetch(`/api/products?category=${categorySlug}&orderby=popularity&per_page=${limit + exclude.size}`)
    if (res.ok) {
      const data = await res.json()
      products = (data.products || []).filter((p: WooProduct) => !exclude.has(String(p.id)))
    }
  }

  if (products.length < limit) {
    const res = await fetch(`/api/products?orderby=popularity&per_page=${limit + exclude.size + products.length}`)
    if (res.ok) {
      const data = await res.json()
      const existingIds = new Set(products.map((p) => p.id))
      const more = (data.products || []).filter(
        (p: WooProduct) => !exclude.has(String(p.id)) && !existingIds.has(p.id)
      )
      products = [...products, ...more]
    }
  }

  return products.slice(0, limit)
}

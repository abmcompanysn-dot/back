/**
 * MIAD Market - Historique de navigation produit (localStorage)
 * Alimente l'algorithme de recommandation (lib/recommendations.ts).
 */
const KEY = 'miad_recently_viewed:v1'
const MAX = 20

export function recordRecentlyViewed(productId: string | number) {
  if (typeof window === 'undefined' || !productId) return
  try {
    const id = String(productId)
    const list = getRecentlyViewedIds().filter((existing) => existing !== id)
    list.unshift(id)
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
  } catch {
    // localStorage indisponible (navigation privée...) — pas bloquant
  }
}

export function getRecentlyViewedIds(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

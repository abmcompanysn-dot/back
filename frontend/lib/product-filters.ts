import type { WooProduct } from '@/lib/woocommerce'

export const PRICE_RANGES = [
  { label: 'Tous les prix', min: 0, max: 1000000 },
  { label: 'Moins de 5,000 $', min: 0, max: 5000 },
  { label: '5,000 - 20,000 $', min: 5000, max: 20000 },
  { label: 'Plus de 20,000 $', min: 20000, max: 1000000 },
] as const

export const MIN_RATINGS = [
  { label: 'Toutes les notes', value: 0 },
  { label: '4 étoiles et plus', value: 4 },
  { label: '3 étoiles et plus', value: 3 },
] as const

export interface ProductFilters {
  selectedCountries: string[]
  priceRange: [number, number]
  minRating: number
  sortBy: string
}

// Filtre + trie côté client — même logique pour la page catégorie et la
// recherche, pour un comportement identique partout sur le site.
export function filterAndSortProducts(products: WooProduct[], filters: ProductFilters): WooProduct[] {
  let result = [...products]

  if (filters.selectedCountries.length > 0) {
    const countrySet = new Set(filters.selectedCountries)
    result = result.filter(p => countrySet.has(p.countryCode?.toLowerCase()))
  }

  result = result.filter(p => p.price >= filters.priceRange[0] && p.price <= filters.priceRange[1])

  if (filters.minRating > 0) {
    result = result.filter(p => (p.rating || 0) >= filters.minRating)
  }

  if (filters.sortBy === 'price-asc') result.sort((a, b) => a.price - b.price)
  if (filters.sortBy === 'price-desc') result.sort((a, b) => b.price - a.price)
  if (filters.sortBy === 'rating-desc') result.sort((a, b) => (b.rating || 0) - (a.rating || 0))

  return result
}

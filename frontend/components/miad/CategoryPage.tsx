"use client"

import { useState, useMemo } from 'react'
import useSWR from 'swr'
import { ArrowLeft, ShoppingBag, X, SlidersHorizontal, Package } from 'lucide-react'
import { type WooCategory, type WooProduct } from '@/lib/woocommerce'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ProductFilterSidebar } from './ProductFilterSidebar'
import { filterAndSortProducts } from '@/lib/product-filters'
import { ProductCard } from './ProductCard'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const fetcher = (url: string) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('miad_token') : null;
  return fetch(url, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} })
    .then(res => {
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new TypeError("Réponse non-JSON reçue");
      }
      return res.json();
    });
}

// Filtres pilotés par le parent (MiadMarketClient) : ils doivent survivre
// à l'ouverture d'un produit puis au retour arrière — CategoryPage se
// démonte à chaque fois, donc un useState local était perdu.
export type CategoryFilters = {
  sortBy: string
  selectedCountries: string[]
  priceRange: [number, number]
  minRating: number
}

interface CategoryPageProps {
  category: WooCategory
  products: WooProduct[]
  language?: 'fr' | 'en'
  filters: CategoryFilters
  onFiltersChange: (next: CategoryFilters) => void
  onBack: () => void
  onProductClick: (product: WooProduct) => void
  onAddToCart: (product: WooProduct) => void
}

export function CategoryPage({ category, products: initialProducts, language = 'fr', filters, onFiltersChange, onBack, onProductClick, onAddToCart }: CategoryPageProps) {
  const { sortBy, selectedCountries, priceRange, minRating } = filters
  const patch = (p: Partial<CategoryFilters>) => onFiltersChange({ ...filters, ...p })
  const setSortBy = (v: string) => patch({ sortBy: v })
  const setSelectedCountries = (v: string[]) => patch({ selectedCountries: v })
  const setPriceRange = (v: [number, number]) => patch({ priceRange: v })
  const setMinRating = (v: number) => patch({ minRating: v })
  const [isFilterMobileOpen, setIsFilterMobileOpen] = useState(false)

  // Construction de la requête API
  const countryQuery = selectedCountries.length 
    ? `&country=${selectedCountries.join(',').toUpperCase()}` 
    : ''

  // lang doit être explicite : sans lui, WPML applique un filtre de langue
  // par défaut (pas le français), donc la page remplaçait la liste initiale
  // complète par un sous-ensemble tronqué une fois le vrai fetch résolu —
  // même bug que sur la page boutique (voir VendorStorePage.tsx), corrigé le
  // 2026-07-30.
  const { data, isLoading } = useSWR(
    `/api/products?category=${category.slug}${countryQuery}&orderby=${sortBy}&lang=${language}`,
    fetcher,
    { revalidateOnFocus: false, fallbackData: { products: initialProducts } }
  )

  // LOGIQUE DE SÉCURITÉ : Priorité aux produits déjà chargés pour éviter le vide
  const allAvailableProducts = useMemo(() => {
    const apiProducts = data?.products || []
    if (apiProducts.length > 0) return apiProducts
    
    // Fallback : On filtre les produits initiaux pour cette catégorie
    return initialProducts.filter(p => p.categorySlug === category.slug)
  }, [data, initialProducts, category.slug])

  // Filtrage Client (Prix, Pays, Note) — logique partagée avec la recherche
  const filteredProducts = useMemo(
    () => filterAndSortProducts(allAvailableProducts, { selectedCountries, priceRange, minRating, sortBy }),
    [allAvailableProducts, selectedCountries, priceRange, minRating, sortBy]
  )

  return (
    <main className="min-h-screen bg-background">
      {/* Header Banner */}
      <div className="bg-muted/30 border-b border-border py-12">
        <div className="container mx-auto px-4">
          <button type="button" onClick={onBack} className="group flex items-center gap-2 text-muted-foreground hover:text-accent mb-8 transition-all font-bold text-xs uppercase tracking-widest">
            <ArrowLeft size={16} className="group-hover:-translate-x-1 transition-transform" />
            <span>Retour au marché</span>
          </button>
          
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-8">
            <div className="flex items-center gap-6">
              <div className="w-20 h-20 bg-accent text-white rounded-[28px] shadow-2xl shadow-accent/30 flex items-center justify-center rotate-3">
                <ShoppingBag size={36} />
              </div>
              <div>
                <h1 className="text-4xl lg:text-5xl font-black uppercase tracking-tighter">{category.name}</h1>
                <p className="text-muted-foreground font-bold text-sm mt-1 uppercase tracking-widest opacity-60">
                  {filteredProducts.length} Pépites trouvées
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-3">
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-[180px] bg-card h-12 rounded-2xl border-border font-bold">
                  <SelectValue placeholder="Trier" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Nouveautés</SelectItem>
                  <SelectItem value="price-asc">Prix croissant</SelectItem>
                  <SelectItem value="price-desc">Prix décroissant</SelectItem>
                </SelectContent>
              </Select>
              <Button 
                variant="outline" 
                size="icon" 
                className="lg:hidden h-12 w-12 rounded-2xl border-border"
                onClick={() => setIsFilterMobileOpen(true)}
              >
                <SlidersHorizontal size={20} />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-16">
        <div className="flex flex-col lg:flex-row gap-16">
          <aside className="hidden lg:block w-72 shrink-0">
            <div className="sticky top-24">
              <ProductFilterSidebar
                selectedCountries={selectedCountries}
                onSelectedCountriesChange={setSelectedCountries}
                priceRange={priceRange}
                onPriceRangeChange={setPriceRange}
                minRating={minRating}
                onMinRatingChange={setMinRating}
              />
            </div>
          </aside>

          <div className="flex-1">
            {isLoading && filteredProducts.length === 0 ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                {[...Array(12)].map((_, i) => (
                  <div key={i} className="space-y-2">
                    <Skeleton className="aspect-square w-full rounded-md" />
                    <Skeleton className="h-3 w-2/3" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                ))}
              </div>
            ) : filteredProducts.length > 0 ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                {filteredProducts.map(product => (
                  <ProductCard key={product.id} product={product} onClick={onProductClick} onAddToCart={onAddToCart} />
                ))}
              </div>
            ) : (
              <div className="text-center py-32 bg-muted/10 rounded-[60px] border-2 border-dashed border-border/50">
                <Package size={64} className="mx-auto text-muted-foreground opacity-10 mb-6" />
                <h3 className="text-2xl font-black uppercase tracking-tighter">Rayon vide</h3>
                <p className="text-muted-foreground mt-2 mb-8 max-w-xs mx-auto text-sm font-medium">Nos artisans préparent de nouveaux stocks. Revenez bientôt !</p>
                <Button variant="outline" onClick={() => { setSelectedCountries([]); setPriceRange([0, 1000000]) }} className="rounded-full px-10 border-accent text-accent font-black h-12 hover:bg-accent hover:text-white transition-all">
                  VOIR TOUT LE MARCHÉ
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Mobile Drawer */}
      {isFilterMobileOpen && (
        <div className="fixed inset-0 z-[100] lg:hidden">
          <div
            role="button"
            tabIndex={0}
            aria-label="Fermer les filtres"
            className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in duration-300"
            onClick={() => setIsFilterMobileOpen(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsFilterMobileOpen(false) } }}
          />
          <div className="absolute bottom-0 left-0 right-0 bg-background rounded-t-[50px] p-10 shadow-2xl animate-in slide-in-from-bottom duration-500 max-h-[85vh] overflow-y-auto">
            <div className="w-12 h-1.5 bg-muted rounded-full mx-auto mb-8" />
            <div className="flex items-center justify-between mb-10">
              <h2 className="text-3xl font-black uppercase tracking-tighter">Filtres</h2>
              <button type="button" aria-label="Fermer" onClick={() => setIsFilterMobileOpen(false)} className="w-12 h-12 rounded-full bg-muted flex items-center justify-center active:scale-90 transition-transform"><X size={24} /></button>
            </div>
            <ProductFilterSidebar
              selectedCountries={selectedCountries}
              onSelectedCountriesChange={setSelectedCountries}
              priceRange={priceRange}
              onPriceRangeChange={setPriceRange}
              minRating={minRating}
              onMinRatingChange={setMinRating}
            />
            <Button className="w-full bg-accent text-white font-black h-16 rounded-[24px] mt-12 shadow-2xl shadow-accent/30 text-lg" onClick={() => setIsFilterMobileOpen(false)}>
              APPLIQUER
            </Button>
          </div>
        </div>
      )}
    </main>
  )
}
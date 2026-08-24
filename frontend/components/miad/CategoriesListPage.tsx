"use client"

import { useState, useMemo } from 'react'
import useSWR from 'swr'
import { ArrowLeft, ShoppingBag } from 'lucide-react'
import { type WooCategory, type WooProduct } from '@/lib/woocommerce'
import { ProductCard } from './ProductCard'
import { Skeleton } from '@/components/ui/skeleton'

interface CategoriesListPageProps {
  categories: WooCategory[]
  allProducts: WooProduct[]
  language?: 'fr' | 'en'
  onBack: () => void
  onProductClick: (product: WooProduct) => void
  onAddToCart: (product: WooProduct) => void
  onCategoryClick: (slug: string) => void
}

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function CategoriesListPage({
  categories,
  allProducts,
  language = 'fr',
  onBack,
  onProductClick,
  onAddToCart,
}: CategoriesListPageProps) {
  const [selectedSlug, setSelectedSlug] = useState<string>('')
  // Retombe sur la première catégorie tant que l'utilisateur n'a rien choisi
  const effectiveSlug = selectedSlug || categories[0]?.slug || ''

  // Produits locaux filtrés par catégorie
  const localFiltered = useMemo(
    () => allProducts.filter(p => p.categorySlug === effectiveSlug || p.categories?.some(c => c.slug === effectiveSlug)),
    [effectiveSlug, allProducts]
  )

  // Catégorie active (pour récupérer son ID WooCommerce)
  const activeCategory = useMemo(
    () => categories.find(c => c.slug === effectiveSlug),
    [effectiveSlug, categories]
  )

  // Fetch API dès qu'il n'y a pas de produits locaux pour cette catégorie
  const { data: apiData, isLoading } = useSWR<{ products: WooProduct[] }>(
    localFiltered.length === 0 && activeCategory?.id
      ? `/api/products?category=${activeCategory.id}&per_page=100&variations=true&lang=${language}`
      : null,
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      revalidateOnMount: true,
      dedupingInterval: 300000,
    }
  )

  const filteredProducts = localFiltered.length > 0
    ? localFiltered
    : (apiData?.products ?? [])

  return (
    <main className="fixed inset-0 z-50 bg-background flex flex-col animate-in slide-in-from-right duration-300">
      {/* Header */}
      <div className="h-16 flex items-center px-4 border-b bg-white shrink-0">
        <button type="button" onClick={onBack} aria-label="Retour" className="p-2 -ml-2 hover:bg-muted rounded-full">
          <ArrowLeft size={24} />
        </button>
        <h1 className="ml-2 font-black uppercase tracking-tighter italic">Tous les Rayons</h1>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Barre latérale des catégories */}
        <div className="w-24 border-r bg-muted/20 overflow-y-auto scrollbar-hide">
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setSelectedSlug(cat.slug)}
              className={`w-full py-4 px-2 text-center transition-all border-l-4 ${
                effectiveSlug === cat.slug
                  ? 'bg-white border-accent text-accent font-black'
                  : 'border-transparent text-muted-foreground font-medium text-xs'
              }`}
            >
              <div className="text-[10px] uppercase leading-tight">{cat.name}</div>
            </button>
          ))}
        </div>

        {/* Grille de produits */}
        <div className="flex-1 overflow-y-auto p-4 bg-white">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-sm font-black uppercase tracking-widest text-primary flex items-center gap-2">
              <ShoppingBag size={16} className="text-accent" />
              {activeCategory?.name || 'Sélection'}
            </h2>
            {!isLoading && (
              <span className="text-[10px] font-bold text-muted-foreground">
                {filteredProducts.length} articles
              </span>
            )}
          </div>

          {isLoading ? (
            <div className="grid grid-cols-2 gap-3">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="aspect-3/4 rounded-2xl" />
              ))}
            </div>
          ) : filteredProducts.length > 0 ? (
            <div className="grid grid-cols-2 gap-3">
              {filteredProducts.map(product => (
                <ProductCard
                  key={product.id}
                  product={product}
                  onClick={onProductClick}
                  onAddToCart={onAddToCart}
                  hideVendorInfo={true}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-center opacity-40">
              <ShoppingBag size={48} className="mb-4" />
              <p className="text-xs font-bold uppercase">{language === 'en' ? 'No products in this category.' : 'Aucun produit dans cette catégorie.'}</p>
              <button type="button" onClick={onBack} className="mt-4 text-accent text-[10px] font-black underline uppercase">
                Retourner à l'accueil
              </button>
            </div>
          )}
          <div className="h-20" />
        </div>
      </div>
    </main>
  )
}

"use client"

import { useEffect, useState } from 'react'
import { ProductCard } from './ProductCard'
import { fetchRecommendedProducts } from '@/lib/recommendations'
import { type WooProduct } from '@/lib/woocommerce'

interface RecommendedProductsProps {
  excludeIds?: (string | number)[]
  title?: string
}

// Rendu sur /success & /order-received (hors SPA) : un rechargement est
// inévitable ici, mais on vise l'URL SPA ?v=product (app complète : header,
// panier, nav) plutôt que la route SEO isolée /product/[slug].
const goToProduct = (p: WooProduct) => { window.location.href = `/?v=product&slug=${p.slug || p.id}` }

/** Suggestions affichées sur les pages de confirmation de commande. */
export function RecommendedProducts({ excludeIds = [], title = 'Vous pourriez aussi aimer' }: RecommendedProductsProps) {
  const [products, setProducts] = useState<WooProduct[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetchRecommendedProducts(excludeIds, 8)
      .then((p) => { if (!cancelled) setProducts(p) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading || products.length === 0) return null

  return (
    <div className="w-full max-w-5xl mb-16">
      <h3 className="text-xl font-black mb-6 text-center md:text-left">{title}</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {products.map((p) => (
          <ProductCard key={p.id} product={p} onClick={goToProduct} onAddToCart={goToProduct} />
        ))}
      </div>
    </div>
  )
}

"use client"

import { useEffect, useState } from 'react'
import { ProductCard } from './ProductCard'
import { type WooProduct } from '@/lib/woocommerce'

interface FrequentlyBoughtTogetherProps {
  productId: number | string
  onProductClick: (product: WooProduct) => void
  onAddToCart: (product: WooProduct) => void
}

/**
 * "Achetés ensemble" — basé sur de vraies co-occurrences de commandes
 * WooCommerce (recalculées quotidiennement côté serveur), pas des
 * suggestions inventées. Reste discret (rien affiché) si aucune donnée
 * n'existe encore pour ce produit (catalogue jeune, peu de commandes).
 */
export function FrequentlyBoughtTogether({ productId, onProductClick, onAddToCart }: FrequentlyBoughtTogetherProps) {
  const [products, setProducts] = useState<WooProduct[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/recommendations/frequently-bought?product_id=${productId}&limit=6`)
      .then((r) => (r.ok ? r.json() : { recommendations: [] }))
      .then(async (data) => {
        const ids: number[] = (data.recommendations || []).map((r: any) => r.product_id)
        if (!ids.length) { if (!cancelled) setProducts([]); return }
        const results = await Promise.all(
          ids.map((id) => fetch(`/api/products?id=${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null))
        )
        if (cancelled) return
        setProducts(results.flatMap((r) => (r?.products?.[0] ? [r.products[0]] : [])))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [productId])

  if (loading || products.length === 0) return null

  return (
    <div className="mt-16 pt-10 border-t border-border">
      <h2 className="text-xl font-bold mb-6">Achetés ensemble</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
        {products.map((p) => (
          <ProductCard key={p.id} product={p} onClick={onProductClick} onAddToCart={onAddToCart} />
        ))}
      </div>
    </div>
  )
}

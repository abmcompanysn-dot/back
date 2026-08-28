"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { WooProduct } from '@/lib/woocommerce'
import { LinkProductCard } from './LinkProductCard'
import { useStreamedNavClick } from '@/contexts/StreamedNavClickContext'

// CategoryRow — rangée horizontale scrollable d'une catégorie sur l'accueil.
// 6 produits chargés d'emblée (fournis par le Server Component parent), puis
// le scroll vers la droite charge la page suivante (/api/products?category=
// <slug>&page=N&per_page=6). Lien "Voir tout" -> navigation catégorie via le
// callback streamé (même mécanisme que LinkProductCard, pas de <Link>).
//
// Ajouté le 2026-08-28 : sections catégorie EN PLUS de l'accueil existant
// (FoodServer + InfiniteProductFeed), pas en remplacement.

interface CategoryRowProps {
  categoryName: string
  categorySlug: string
  initialProducts: WooProduct[]
  totalPages: number
  userCountry?: string
}

const PER_PAGE = 6

export function CategoryRow({ categoryName, categorySlug, initialProducts, totalPages, userCountry }: CategoryRowProps) {
  const nav = useStreamedNavClick()
  const scrollRef = useRef<HTMLDivElement>(null)

  const [products, setProducts] = useState<WooProduct[]>(initialProducts)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(totalPages > 1)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(false)

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return
    setLoading(true)
    try {
      const next = page + 1
      const res = await fetch(`/api/products?category=${encodeURIComponent(categorySlug)}&page=${next}&per_page=${PER_PAGE}`)
      const data = await res.json()
      const more: WooProduct[] = data.products || []
      if (more.length === 0) {
        setHasMore(false)
      } else {
        setProducts((prev) => {
          const seen = new Set(prev.map((p) => p.id))
          return [...prev, ...more.filter((p) => !seen.has(p.id))]
        })
        setPage(next)
        if (next >= (data.pages || totalPages)) setHasMore(false)
      }
    } catch {
      setHasMore(false)
    } finally {
      setLoading(false)
    }
  }, [loading, hasMore, page, categorySlug, totalPages])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setAtStart(el.scrollLeft <= 4)
    const nearEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 300
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4)
    if (nearEnd) loadMore()
  }, [loadMore])

  useEffect(() => {
    onScroll()
  }, [products, onScroll])

  const scrollBy = (dir: 'left' | 'right') => {
    scrollRef.current?.scrollBy({ left: dir === 'left' ? -320 : 320, behavior: 'smooth' })
  }

  const goToCategory = () => {
    // Bascule vers la vue catégorie via le callback streamé (pas de <Link>,
    // pas de round-trip serveur) — même mécanisme que "Voir tout" d'une
    // section pays.
    nav?.onViewAllCategory?.(categorySlug)
  }

  if (products.length === 0) return null

  return (
    <section className="py-8 border-b border-border/30">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl md:text-2xl font-black uppercase tracking-tighter">
            {categoryName}
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goToCategory}
              className="text-xs font-black uppercase tracking-widest text-accent hover:underline"
            >
              Voir tout
            </button>
            <button
              type="button"
              aria-label="Précédent"
              onClick={() => scrollBy('left')}
              disabled={atStart}
              className="w-8 h-8 rounded-full border border-border flex items-center justify-center disabled:opacity-30 hover:bg-muted transition-colors"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              aria-label="Suivant"
              onClick={() => scrollBy('right')}
              disabled={atEnd && !hasMore}
              className="w-8 h-8 rounded-full border border-border flex items-center justify-center disabled:opacity-30 hover:bg-muted transition-colors"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex gap-4 overflow-x-auto scrollbar-hide pb-2 snap-x"
        >
          {products.map((p) => (
            <div key={p.id} className="shrink-0 w-40 sm:w-48 snap-start">
              <LinkProductCard product={p} userCountry={userCountry} />
            </div>
          ))}
          {loading && (
            <div className="shrink-0 w-40 sm:w-48 flex items-center justify-center text-xs text-muted-foreground">
              Chargement…
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

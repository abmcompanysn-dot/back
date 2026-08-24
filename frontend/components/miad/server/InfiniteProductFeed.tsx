'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Loader2, PackageSearch } from 'lucide-react'
import { type WooProduct } from '@/lib/woocommerce'
import { LinkProductCard } from '../LinkProductCard'

const PER_PAGE = 20

// Cache module par clé (survit au démontage/remontage du composant tant que
// la page n'est pas rechargée) — MiadMarketClient.tsx démonte entièrement
// l'accueil quand on ouvre une fiche produit (switch sur currentView), donc
// sans ça, revenir en arrière repartait toujours de la page 1 même si on
// avait déjà scrollé/chargé beaucoup plus loin. La restauration du scroll
// (navStack dans MiadMarketClient.tsx) ne fonctionne correctement que si la
// hauteur du contenu est déjà identique à ce qu'elle était — d'où l'intérêt
// de restaurer aussi la liste de produits, pas seulement la position Y
// (demandé le 2026-07-23 : "le retour en arrière doit mener à où j'étais
// exactement même si le système a chargé d'autres produits"). Clé par
// instance (ex: "home" vs "product-42") pour que le feed de l'accueil et
// celui d'une fiche produit (onglet Recommandations) ne partagent pas leur
// état — sinon ouvrir un produit affichait le lot déjà chargé sur l'accueil.
const feedCache = new Map<string, { products: WooProduct[]; page: number; hasMore: boolean }>()

interface InfiniteProductFeedProps {
  cacheKey?: string
  title?: string
  language?: 'fr' | 'en'
}

/**
 * Grille de produits qui charge automatiquement la page suivante quand on
 * scrolle vers le bas (pas de bouton "charger plus") — demandé le
 * 2026-07-23, utilisée en bas de l'accueil et de l'onglet Recommandations
 * d'une fiche produit. 2 colonnes sur mobile comme demandé, plus large sur
 * les écrans plus grands. Client Component autonome (LinkProductCard gère
 * déjà sa propre navigation/panier via StreamedNavClickContext + cart-store,
 * donc pas besoin de callbacks depuis l'appelant ici).
 */
export function InfiniteProductFeed({ cacheKey = 'home', title, language = 'fr' }: InfiniteProductFeedProps = {}) {
  const resolvedTitle = title ?? (language === 'en' ? 'Discover more products' : 'Découvrir plus de produits')
  // La langue fait partie de la clé de cache : sans ça, basculer FR/EN sur le
  // même feed ('home') mélangerait des produits des deux langues dans la
  // même liste (le cache module survit au démontage du composant).
  const effectiveCacheKey = `${cacheKey}-${language}`
  const cached = feedCache.get(effectiveCacheKey)
  const [products, setProducts] = useState<WooProduct[]>(() => cached?.products ?? [])
  const [page, setPage] = useState(() => cached?.page ?? 0)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(() => cached?.hasMore ?? true)
  const [error, setError] = useState(false)

  useEffect(() => {
    feedCache.set(effectiveCacheKey, { products, page, hasMore })
  }, [effectiveCacheKey, products, page, hasMore])
  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)

  const loadNextPage = useCallback(async () => {
    if (loadingRef.current || !hasMore) return
    loadingRef.current = true
    setLoading(true)
    setError(false)
    try {
      const nextPage = page + 1
      const res = await fetch(`/api/products?page=${nextPage}&per_page=${PER_PAGE}&lang=${language}`)
      const data = await res.json()
      const newProducts: WooProduct[] = data.products || []
      setProducts((prev) => [...prev, ...newProducts])
      setPage(nextPage)
      // Ne pas se fier à data.pages : le cache Cloudflare de /api/products a
      // été observé servir un total/pages erroné (sous-compté) pour certaines
      // combinaisons de filtres mises en cache tôt (confirmé le 2026-07-23 :
      // page=1 renvoyait total=20/pages=1 alors que page=2 renvoyait bien
      // total=680/pages=34 pour les mêmes filtres). Un lot incomplet est le
      // seul signal fiable de "plus de produits".
      if (newProducts.length < PER_PAGE) setHasMore(false)
    } catch {
      setError(true)
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [page, hasMore])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    // 400px -> 1200px le 2026-07-25 : le prochain lot de produits doit être
    // déjà chargé avant que le visiteur n'atteigne le bas de la grille, pas
    // seulement déclenché à ce moment-là (même demande que pour les images,
    // cf. LazyImage.tsx).
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadNextPage()
      },
      { rootMargin: '1200px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [loadNextPage])

  return (
    <section className="py-10 border-t border-border">
      <div className="container mx-auto px-4">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-accent/10 rounded-xl">
            <PackageSearch size={20} className="text-accent" />
          </div>
          <h2 className="text-xl font-bold text-foreground">{resolvedTitle}</h2>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {products.map((product) => (
            <LinkProductCard key={product.id} product={product} />
          ))}
        </div>

        <div ref={sentinelRef} className="flex items-center justify-center py-8">
          {loading && <Loader2 size={24} className="animate-spin text-muted-foreground" />}
          {error && (
            <button type="button" onClick={loadNextPage} className="text-sm font-bold text-accent underline underline-offset-2">
              {language === 'en' ? 'Loading error — retry' : 'Erreur de chargement — réessayer'}
            </button>
          )}
          {!hasMore && !loading && products.length > 0 && (
            <p className="text-xs text-muted-foreground">{language === 'en' ? "You've seen it all 🎉" : 'Vous avez tout vu 🎉'}</p>
          )}
        </div>
      </div>
    </section>
  )
}

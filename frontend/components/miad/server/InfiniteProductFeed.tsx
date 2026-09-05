'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Loader2, PackageSearch } from 'lucide-react'
import { type WooProduct } from '@/lib/woocommerce'
import { LinkProductCard, loadedImagesCache } from '../LinkProductCard'
import { getThumbnailUrl } from '@/lib/image-utils'

const PER_PAGE = 20

// declusterNewBatch — sépare les produits d'une même boutique pour qu'au
// plus MAX_CONSECUTIVE (2) se suivent d'affilée, EN TENANT COMPTE de la
// fin du lot déjà affiché (prevTail). Nécessaire côté client en plus du
// décluster déjà fait par /api/products : ce dernier ne connaît jamais la
// fin du lot précédent (chaque appel de page est mis en cache CDN
// indépendamment, stale-while-revalidate 1 an) — sans ce passage
// supplémentaire, le motif "vendeur répété" pouvait réapparaître à
// chaque frontière de page de 20 malgré le décluster serveur par page
// (2026-08-26). Les swaps ne portent QUE sur `newBatch` (jamais sur
// prevTail/les produits déjà affichés) : réordonner des cartes déjà
// visibles à l'écran pendant que l'utilisateur scrolle créerait un saut
// visuel disruptif — seul le contenu pas encore rendu peut bouger.
const MAX_CONSECUTIVE = 2
function declusterNewBatch(prevTail: WooProduct[], newBatch: WooProduct[]): WooProduct[] {
  const out = [...newBatch]
  const vendorId = (p: WooProduct) => p.vendor?.id
  const history = [...prevTail]
  for (let i = 0; i < out.length; i++) {
    const v = vendorId(out[i])
    if (v) {
      const recentSameVendor = history.slice(-MAX_CONSECUTIVE).filter((p) => vendorId(p) === v).length
      if (recentSameVendor >= MAX_CONSECUTIVE) {
        const swapIdx = out.findIndex((p, idx) => {
          if (idx <= i) return false
          const pv = vendorId(p)
          if (!pv || pv === v) return false
          const candidateRecent = history.slice(-MAX_CONSECUTIVE).filter((p2) => vendorId(p2) === pv).length
          return candidateRecent < MAX_CONSECUTIVE
        })
        if (swapIdx !== -1) {
          ;[out[i], out[swapIdx]] = [out[swapIdx], out[i]]
        }
      }
    }
    history.push(out[i])
  }
  return out
}

// currentColumnCount / preloadRow — ajoutés le 2026-09-05, demande du
// fondateur : les cartes apparaissaient puis leurs images popaient une par
// une au fur et à mesure du chargement ("un truc pas propre") — il veut
// qu'une rangée entière (celle réellement visible à l'écran, pas juste un
// lot arbitraire de 20) n'apparaisse d'un coup qu'une fois TOUTES ses
// images prêtes.
//
// Seuils identiques à la grille CSS ci-dessous (grid-cols-2 sm:3 md:4
// lg:6) — dupliqués ici volontairement : matchMedia doit interroger
// exactement les mêmes breakpoints Tailwind pour que le découpage en
// rangées corresponde à ce qui s'affiche réellement, sinon une rangée
// pourrait apparaître visuellement incomplète (ex: 6 produits groupés
// alors que l'écran n'affiche que 4 colonnes).
function currentColumnCount(): number {
  if (typeof window === 'undefined') return 6
  if (window.matchMedia('(min-width: 1024px)').matches) return 6
  if (window.matchMedia('(min-width: 768px)').matches) return 4
  if (window.matchMedia('(min-width: 640px)').matches) return 3
  return 2
}

// preloadRow — précharge les images d'une rangée de produits (même URL de
// miniature exacte que celle que LinkProductCard affichera, via
// getThumbnailUrl — sinon le préchargement téléchargerait une URL
// différente de celle réellement utilisée, pour rien). Timeout de sécurité
// PAR IMAGE (pas juste global) : une image cassée ou très lente ne doit
// jamais bloquer indéfiniment toute la rangée suivante.
const ROW_IMAGE_TIMEOUT_MS = 2500
function preloadRow(row: WooProduct[]): Promise<void> {
  const urls = row.map((p) => getThumbnailUrl(p.image)).filter((u): u is string => !!u)
  if (urls.length === 0) return Promise.resolve()
  return Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve) => {
          if (loadedImagesCache.has(url)) { resolve(); return }
          const img = new window.Image()
          const done = () => { loadedImagesCache.add(url); resolve() }
          img.onload = done
          img.onerror = done // image cassée : on n'attend pas dessus, LazyImage gère déjà son propre repli
          img.src = url
          setTimeout(done, ROW_IMAGE_TIMEOUT_MS)
        })
    )
  ).then(() => undefined)
}

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
      const declustered = declusterNewBatch(products.slice(-MAX_CONSECUTIVE), newProducts)

      // Découpe en rangées (nombre de colonnes réel de l'écran courant) et
      // affiche rangée par rangée, chacune n'apparaissant qu'une fois ses
      // images préchargées — voir preloadRow ci-dessus. cols figé au début
      // du lot (pas re-mesuré à chaque rangée) : un redimensionnement de
      // fenêtre pendant le chargement ne doit pas faire varier la taille
      // des rangées DANS un même lot, seulement affecter le lot suivant.
      const cols = currentColumnCount()
      for (let i = 0; i < declustered.length; i += cols) {
        const row = declustered.slice(i, i + cols)
        await preloadRow(row)
        setProducts((prev) => [...prev, ...row])
      }
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
    // products ajouté aux deps : lu directement (products.slice(...)) pour
    // le décluster, plus seulement via le setter fonctionnel comme avant —
    // nécessaire pour éviter une closure périmée sur l'état déjà affiché.
  }, [page, hasMore, products])

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

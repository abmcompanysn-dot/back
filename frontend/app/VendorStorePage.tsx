"use client"
import { useMemo, useRef, useEffect, useCallback } from 'react'
import Image from 'next/image'
import useSWRInfinite from 'swr/infinite'
import { Loader2, Store, Star, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { type WooVendor, type WooProduct } from '@/lib/woocommerce'
import { Skeleton } from '@/components/ui/skeleton'
import { ProductCard } from '@/components/miad/ProductCard'
import { ShareButton } from '@/components/miad/ShareButton'
import { proxyIfLocalWp } from '@/lib/image-utils'

interface VendorStorePageProps {
  vendor: WooVendor
  allProducts?: Array<WooProduct>
  language?: 'fr' | 'en'
  onBack: () => void
  onProductClick: (product: WooProduct) => void
  onAddToCart: (product: WooProduct) => void
}

const EMPTY_PRODUCTS: WooProduct[] = []
const PER_PAGE = 100
const fetcher = (url: string): Promise<{ products: WooProduct[]; total: number }> => fetch(url).then(res => res.json())

export function VendorStorePage({ vendor, allProducts = EMPTY_PRODUCTS, language = 'fr', onBack, onProductClick, onAddToCart }: VendorStorePageProps) {
  const cachedProducts = useRef<WooProduct[]>([])
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Filtre multi-critères : ID en priorité, slug en fallback
  const localProducts = useMemo(
    () => allProducts.filter(p =>
      (p.vendor?.id !== undefined && String(p.vendor.id) === String(vendor.id)) ||
      (p.vendor?.slug && vendor.slug && p.vendor.slug === vendor.slug)
    ),
    [allProducts, vendor.id, vendor.slug]
  )

  // localProducts ne vient que du lot initial (~100 produits) chargé pour
  // l'accueil — un vendeur peut y avoir 1 ou 2 produits sans y avoir tout son
  // catalogue. On fetch donc toujours le catalogue complet et fiable du
  // vendeur (endpoint Dokan dédié, filtré côté serveur) ; localProducts ne
  // sert qu'à afficher un aperçu instantané pendant ce chargement.
  // Pas de variations=true ici : ça forçait un appel WooCommerce par produit
  // variable (N+1) pour tout le catalogue du vendeur, juste pour afficher
  // des cartes qui n'en ont pas besoin (même correctif que MiadMarketClient.tsx
  // pour l'accueil) — root cause du chargement boutique à 10+ secondes
  // constaté le 2026-07-16. ProductCard et ProductDetail récupèrent déjà
  // leurs propres variations à la demande.
  //
  // useSWRInfinite plutôt qu'un seul useSWR à per_page=100 : un vendeur avec
  // plus de 100 produits (ex: MALAÏKA'S HOUSE, 220 produits) ne montrait que
  // sa première centaine, le reste du catalogue restant invisible sans
  // aucune pagination (signalé le 2026-07-29). Chargement anticipé (sentinel
  // + IntersectionObserver rootMargin 1200px plus bas) — même stratégie que
  // InfiniteProductFeed.tsx sur l'accueil : la page suivante charge avant
  // que le visiteur n'atteigne réellement le bas de la grille.
  // Stoppe seulement sur une page réellement vide : l'API WooCommerce plafonne
  // `include=` à 50 résultats quel que soit le per_page demandé (constaté le
  // 2026-07-29 sur le vendeur 95 — 100 IDs envoyés, 50 reçus), donc comparer
  // la longueur de page à PER_PAGE (100) aurait arrêté la pagination après le
  // tout premier lot alors qu'il restait des produits.
  const getKey = useCallback(
    (index: number, previousPageData: { products: WooProduct[] } | null) => {
      if (previousPageData && previousPageData.products.length === 0) return null
      // lang doit être explicite : sans lui, WPML applique un filtre de langue
      // par défaut qui n'est pas le français, donc un vendeur avec ses
      // produits en FR+EN (paires WPML) ne voyait quasiment que la version EN
      // sur sa page boutique (ex: RicardoDesign — 3 produits publiés réels,
      // 1 seul affiché sans ce paramètre) — signalé le 2026-07-30.
      return `/api/products?vendor=${vendor.id}&page=${index + 1}&per_page=${PER_PAGE}&lang=${language}`
    },
    [vendor.id, language]
  )

  const { data, isLoading, setSize } = useSWRInfinite<{ products: WooProduct[]; total: number }>(
    getKey,
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      revalidateOnReconnect: false,
      dedupingInterval: 300000,
    }
  )

  // Repart de la page 1 quand on change de boutique — sinon la taille
  // (size) restait celle de la boutique précédente et déclenchait tout de
  // suite des pages inutiles pour la nouvelle.
  useEffect(() => {
    cachedProducts.current = []
    setSize(1)
  }, [vendor.id, setSize])

  // Ne PAS comparer à PER_PAGE : WPML filtre le résultat de `include=` sur la
  // langue courante (le tableau d'IDs du vendeur contient FR+EN), donc une
  // page renvoie rarement PER_PAGE pile (ex: 50, 50, 16 constaté sur un lot
  // de 220 IDs bruts) — seule une page réellement vide signale la fin.
  const hasMore = !data || (data[data.length - 1]?.products.length ?? 0) > 0

  const loadNextPage = useCallback(() => {
    if (hasMore) setSize(s => s + 1)
  }, [hasMore, setSize])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadNextPage() },
      { rootMargin: '1200px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [loadNextPage])

  // Priorité : cache ref → SWR data → local filtered → vide
  const vendorProducts: WooProduct[] = useMemo(() => {
    const fromSWR = data ? data.flatMap(page => page.products) : []
    if (fromSWR.length > 0) {
      // L'API WC ne filtre pas réellement par author — on filtre côté client
      const filtered = fromSWR.filter(p =>
        String(p.vendor?.id) === String(vendor.id) ||
        (p.vendor?.slug && vendor.slug && p.vendor.slug === vendor.slug)
      )
      cachedProducts.current = filtered
      return filtered
    }
    if (cachedProducts.current.length > 0) return cachedProducts.current
    return localProducts
  }, [data, localProducts, vendor.id, vendor.slug]);
  const categoriesWithProducts: Record<string, WooProduct[]> = useMemo(() => {
    const groups: Record<string, WooProduct[]> = {};
    vendorProducts.forEach((p: WooProduct) => {
      const catName = p.categories?.[0]?.name || (p.lang === 'fr' ? 'Divers' : 'Others');
      if (!groups[catName]) groups[catName] = [];
      groups[catName].push(p);
    });
    return groups;
  }, [vendorProducts]);

  return (
    <main className="min-h-screen bg-background">
      {/* Cover Header */}
      <div className="h-48 md:h-64 bg-muted relative">
        {vendor.banner && <Image src={proxyIfLocalWp(vendor.banner)!} fill sizes="100vw" className="object-cover" alt="" />}
        <div className="absolute inset-0 bg-black/20" />
      </div>

      <div className="container mx-auto px-4 -mt-12 relative z-10">
        <div className="bg-card border border-border rounded-2xl p-6 shadow-xl flex flex-col md:flex-row items-center gap-6">
          <div className="w-24 h-24 rounded-full border-4 border-background bg-white overflow-hidden shrink-0 shadow-lg relative">
            {vendor.logo ? <Image src={proxyIfLocalWp(vendor.logo)!} alt={vendor.name} fill sizes="96px" className="object-cover" /> : <div className="w-full h-full flex items-center justify-center bg-primary text-white text-2xl font-bold">{vendor.name[0]}</div>}
          </div>
          <div className="flex-1 text-center md:text-left">
            <h1 className="text-2xl font-bold">{vendor.name}</h1>
            <div className="flex items-center justify-center md:justify-start gap-3 mt-1 text-muted-foreground">
              <div className="flex items-center gap-1"><Star size={14} className="text-accent fill-accent" /> {vendor.rating || '5.0'}</div>
            </div>
          </div>
          <ShareButton
            title={vendor.name}
            description={`Découvrez la boutique ${vendor.name} sur MIAD Market`}
            url={`/vendor/${vendor.slug || vendor.id}`}
            image={vendor.banner || vendor.logo}
            variant="full"
          />
        </div>

        <div className="py-10 space-y-16">
          {isLoading && vendorProducts.length === 0 ? (
             <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
               {[...Array(12)].map((_, i) => <Skeleton key={i} className="aspect-square rounded-xl" />)}
             </div>
          ) : (
            <>
              {/* Top 10 produits vedette */}
              {vendorProducts.length > 0 && (
                <section>
                  <div className="flex items-center gap-3 mb-6">
                    <div className="h-8 w-1 bg-accent rounded-full" />
                    <h2 className="text-xl font-black uppercase tracking-tight">⭐ Top produits</h2>
                    <span className="text-xs text-muted-foreground font-medium ml-auto">{vendorProducts.length} produit{vendorProducts.length > 1 ? 's' : ''}</span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3 lg:gap-4">
                    {vendorProducts
                      .toSorted((a, b) => (b.salesCount || 0) - (a.salesCount || 0) || (b.rating || 0) - (a.rating || 0))
                      .slice(0, 10)
                      .map((product: WooProduct) => (
                        <ProductCard
                          key={product.id}
                          product={product}
                          onClick={onProductClick}
                          onAddToCart={onAddToCart}
                        />
                      ))}
                  </div>
                </section>
              )}

              {/* Tous les produits par catégorie */}
              {Object.entries(categoriesWithProducts).map(([category, products]) => (
                <section key={category}>
                  <div className="flex items-center gap-3 mb-6">
                    <div className="h-8 w-1 bg-primary/40 rounded-full" />
                    <h2 className="text-xl font-black uppercase tracking-tight">{category}</h2>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 lg:gap-4">
                    {products.map((product: WooProduct) => (
                      <ProductCard
                        key={product.id}
                        product={product}
                        onClick={onProductClick}
                        onAddToCart={onAddToCart}
                      />
                    ))}
                  </div>
                </section>
              ))}

              {/* Sentinel de chargement anticipé — déclenche la page suivante
                  bien avant que le visiteur n'atteigne le bas réel (rootMargin
                  1200px), même stratégie que InfiniteProductFeed.tsx. */}
              {vendorProducts.length > 0 && (
                <div ref={sentinelRef} className="flex items-center justify-center py-6">
                  {hasMore && <Loader2 size={22} className="animate-spin text-muted-foreground" />}
                </div>
              )}
            </>
          )}

          {vendorProducts.length === 0 && !isLoading && (
            <div className="text-center py-20 bg-muted/20 rounded-2xl border-2 border-dashed border-border">
              <Package size={48} className="mx-auto text-muted-foreground opacity-20 mb-4" />
              <p className="text-muted-foreground">Aucun produit trouvé pour cette boutique.</p>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
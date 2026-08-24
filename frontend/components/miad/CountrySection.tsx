"use client"

import { useState, useRef, useEffect } from 'react'
import Image from 'next/image'
import { mutate } from 'swr'
import { ChevronLeft, ChevronRight, ShoppingCart, Star, Store, ArrowRight, Package, Check, Truck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatPrice, type WooProduct, type Country, type WooVendor, translations } from '@/lib/woocommerce'
import { ProductSkeleton } from './ProductSkeleton'
import { ProductCard } from './ProductCard'
import { LazyImage } from './LazyImage'
import { toast } from 'sonner'

const fetcher = (url: string) => fetch(url).then((res: Response) => {
  if (!res.ok) throw new Error(`Erreur ${res.status}`);
  const contentType = res.headers.get("content-type");
  if (!contentType || !contentType.includes("application/json")) throw new TypeError("Réponse non-JSON reçue");
  return res.json();
})

interface CountrySectionProps {
  country: Country
  language?: 'fr' | 'en'
  isLoadingProducts?: boolean // Nouvelle prop pour l'état de chargement
  isHomepage?: boolean // Nouvelle prop pour savoir si c'est sur la page d'accueil
  products: WooProduct[]
  stores?: WooVendor[]
  onProductClick: (product: WooProduct) => void
  onAddToCart: (product: WooProduct) => void
  onViewAll?: (countryCode: string) => void
  onStoreClick?: (store: WooVendor) => void
}

// ── Reliable image with fallback ─────────────────────────────────────────────
function ProductImg({ src, alt, categorySlug }: { src: string; alt: string; categorySlug?: string }) {
  const [errored, setErrored] = useState(false)
  const valid = src && src !== '/placeholder.jpg' && !errored

  return valid ? (
    <LazyImage
      src={src}
      alt={alt}
      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
      onError={() => setErrored(true)}
    />
  ) : (
    <div className="relative w-full h-full flex items-center justify-center bg-white p-10">
      <Image src="/logo/logo.png" alt="" fill className="opacity-20 object-contain" />
    </div>
  )
}

function StoreImg({ src, name }: { src: string; name: string }) {
  const [errored, setErrored] = useState(false)
  const valid = src && src !== '/vendor-placeholder.png' && !errored
  return valid ? (
    <LazyImage
      src={src}
      alt={name}
      className="w-full h-full object-cover"
      onError={() => setErrored(true)}
    />
  ) : (
    <div className="w-full h-full flex items-center justify-center bg-primary text-primary-foreground font-bold text-lg">
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

function checkScrollPosition(ref: React.RefObject<HTMLDivElement | null>, setAtStart: (b: boolean) => void, setAtEnd: (b: boolean) => void) {
  if (ref.current) {
    const { scrollLeft, scrollWidth, clientWidth } = ref.current
    setAtStart(scrollLeft === 0)
    setAtEnd(scrollLeft + clientWidth >= scrollWidth)
  }
}

function scroll(ref: React.RefObject<HTMLDivElement | null>, dir: 'left' | 'right') {
  ref.current?.scrollBy({ left: dir === 'left' ? -320 : 320, behavior: 'smooth' })
}

// Précharge le catalogue du vendeur au survol de sa tuile, pour un affichage
// instantané de VendorStorePage au clic (même clé SWR que son fetch interne).
function prefetchStore(store: WooVendor) {
  // Pas de variations=true : doit matcher exactement la clé de VendorStorePage.tsx
  // (retiré le 2026-07-16, root cause du chargement boutique à 10+ secondes)
  const url = `/api/products?vendor=${store.id}&per_page=100`
  mutate(url, fetcher(url), { revalidate: false })
}

// ── Main component ────────────────────────────────────────────────────────────
export function CountrySection({
  country,
  language = 'fr',
  products,
  stores = [],
  onProductClick,
  onAddToCart,
  onViewAll,
  onStoreClick,
  isLoadingProducts = false,
  isHomepage = false,
}: CountrySectionProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const storesScrollRef = useRef<HTMLDivElement>(null)
  const t = translations[language] as any

  const [isProductsAtStart, setIsProductsAtStart] = useState(true)
  const [isProductsAtEnd, setIsProductsAtEnd] = useState(false)
  const [isStoresAtStart, setIsStoresAtStart] = useState(true)
  const [isStoresAtEnd, setIsStoresAtEnd] = useState(false)

  useEffect(() => {
    const initScroll = () => {
      checkScrollPosition(scrollRef, setIsProductsAtStart, setIsProductsAtEnd)
      checkScrollPosition(storesScrollRef, setIsStoresAtStart, setIsStoresAtEnd)
    }
    initScroll()

    const handleResize = () => {
      initScroll()
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [products.length, stores.length])

  // On n'affiche les squelettes QUE si la liste est strictement vide ET qu'on charge pour la première fois
  if (isLoadingProducts && products.length === 0 && stores.length === 0 && isHomepage) {
    // Rendre un ensemble de squelettes pour donner une impression de chargement
    return (
      <section className="py-10 bg-muted/40 border-b border-border last:border-0 container mx-auto px-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">{[...Array(5)].map((_, i) => <ProductSkeleton key={i} />)}</div>
      </section>
    );
  }

  return (
    <section className="py-10 bg-muted/40 border-b border-border last:border-0">
      <div className="container mx-auto px-4">
        {/* Country header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Image
              src={`https://flagcdn.com/w80/${country.code.toLowerCase()}.png`}
              alt={country.name}
              width={40}
              height={28}
              className="w-10 h-7 object-cover rounded shadow-sm border border-border"
              loading="lazy"
            />
            <div>
              <h2 className="text-xl font-bold text-foreground">{language === 'fr' ? 'Marché' : 'Market'} {country.name}</h2>
              <p className="text-xs text-muted-foreground">
                {[
                  stores.length > 0 && `${stores.length} ${t.shops}`,
                  products.length > 0 && `${products.length} produit${products.length > 1 ? 's' : ''} marché`,
                ].filter(Boolean).join(' · ')}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onViewAll?.(country.code)}
            className="text-accent border-accent hover:bg-accent hover:text-accent-foreground gap-1"
          >
            {t.seeAll} <ArrowRight size={14} />
          </Button>
        </div>

        {/* Stores row */}
        {stores.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-foreground text-sm flex items-center gap-2">
                <Store size={16} className="text-accent" />
                {t.shops}
              </h3>
              <div className="flex gap-1">
                {(['left', 'right'] as const).map(dir => (
                  <button
                    key={dir}
                    type="button"
                    aria-label={dir === 'left' ? (language === 'fr' ? 'Précédent' : 'Previous') : (language === 'fr' ? 'Suivant' : 'Next')}
                    onClick={() => scroll(storesScrollRef, dir)}
                    disabled={dir === 'left' ? isStoresAtStart : isStoresAtEnd}
                    className="p-1.5 rounded-full bg-muted hover:bg-accent hover:text-accent-foreground transition-colors"
                  >
                    {dir === 'left' ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
                  </button>
                ))}
              </div>
            </div>
            <div
              ref={storesScrollRef}
              onScroll={() => checkScrollPosition(storesScrollRef, setIsStoresAtStart, setIsStoresAtEnd)}
              className="flex gap-3 overflow-x-auto scrollbar-hide pb-1"
            >
              {stores.map(store => (
                <div
                  key={store.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onStoreClick?.(store)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStoreClick?.(store) } }}
                  onMouseEnter={() => prefetchStore(store)}
                  className="shrink-0 w-64 bg-card border border-border rounded-xl overflow-hidden cursor-pointer hover:shadow-md transition-all group"
                >
                  {/* Banner/Cover */}
                  <div className="h-20 bg-muted relative">
                    {store.banner ? (
                      <LazyImage src={store.banner} alt="" decoding="async" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-linear-to-r from-gray-200 to-gray-300" />
                    )}
                    {/* Profile Logo overlay */}
                    <div className="absolute -bottom-5 left-3 w-12 h-12 rounded-full border-2 border-background bg-white overflow-hidden shadow-sm">
                      <StoreImg src={store.logo} name={store.name} />
                    </div>
                  </div>

                  <div className="pt-7 px-3 pb-3">
                    <p className="font-black text-foreground text-sm truncate group-hover:text-accent transition-colors">
                      {store.name}
                    </p>
                    <div className="flex items-center justify-between mt-2">
                      <div className="flex items-center gap-0.5 text-[10px] font-bold text-orange-500">
                        <Star size={10} className="fill-orange-500" /> {typeof store.rating === 'number' ? store.rating.toFixed(1) : '5.0'}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Products row */}
        {products.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-foreground text-sm">{t.popularProducts}</h3>
              <div className="flex gap-1">
                {(['left', 'right'] as const).map(dir => (
                  <button
                    key={dir}
                    type="button"
                    aria-label={dir === 'left' ? (language === 'fr' ? 'Précédent' : 'Previous') : (language === 'fr' ? 'Suivant' : 'Next')}
                    onClick={() => scroll(scrollRef, dir)}
                    disabled={dir === 'left' ? isProductsAtStart : isProductsAtEnd}
                    className="p-1.5 rounded-full bg-muted hover:bg-accent hover:text-accent-foreground transition-colors"
                  >
                    {dir === 'left' ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
                  </button>
                ))}
              </div>
            </div>

            <div
              ref={scrollRef}
              onScroll={() => checkScrollPosition(scrollRef, setIsProductsAtStart, setIsProductsAtEnd)}
              className="flex gap-4 overflow-x-auto scrollbar-hide pb-3"
              style={{ scrollSnapType: 'x mandatory' }}
            >
              {products.map(product => (
                <div
                  key={product.id}
                  className="shrink-0 w-56"
                  style={{ scrollSnapAlign: 'start' }}
                >
                  <ProductCard
                    product={product}
                    hideVendorInfo={isHomepage}
                    onClick={(p) => onProductClick(p)}
                    onAddToCart={(p) => onAddToCart(p)}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

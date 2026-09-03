"use client"

import { useState } from 'react'
import { mutate } from 'swr'
import { Star, ShoppingCart, Truck, ShoppingBag, Heart, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { type WooProduct } from '@/lib/woocommerce'
import { getAnchorPrice } from '@/lib/coins'
import { useCurrency } from '@/contexts/CurrencyContext'
import { useWishlist } from '@/contexts/WishlistContext'
import { isLocalDelivery } from '@/lib/shipping-utils'
import { LazyImage } from './LazyImage'

// Mémorise les images déjà affichées avec succès dans cette session (évite de rejouer
// le skeleton de chargement à chaque remontage du composant pour une image déjà vue/en cache)
const loadedImagesCache = new Set<string>()

// Stratégie AliExpress : prefetch au survol (SWR garde la réponse en cache,
// prête au moment du clic).
function prefetchProduct(p: WooProduct) {
  if (p.type !== 'variable') return
  const url = `/api/products?id=${p.id}&variations=true&lang=${p.lang || 'fr'}`
  mutate(url, fetch(url).then(r => r.json()), { revalidate: false })
}

interface ProductCardProps {
  product: WooProduct
  onClick: (product: WooProduct) => void
  hideVendorInfo?: boolean
  onAddToCart: (product: WooProduct) => void
  userCountry?: string
  // Optionnel : si fourni, affiche un bouton "Aperçu rapide" (icône œil,
  // visible au survol comme le cœur favori) qui ouvre QuickViewModal au
  // lieu de naviguer vers la fiche complète. Omis → comportement
  // inchangé pour les usages existants de ProductCard qui n'ont pas
  // encore de modale à proposer.
  onQuickView?: (product: WooProduct) => void
}

export function ProductCard({ product, onClick, onAddToCart, hideVendorInfo, userCountry = '', onQuickView }: ProductCardProps) {
  const { formatPrice: fp } = useCurrency()
  const { isFavorite, toggle: toggleWishlist } = useWishlist()
  const favorite = isFavorite(product.id)
  const local = isLocalDelivery(product.countryCode || '', userCountry)
  const [imgErrored, setImgErrored] = useState(false)
  const [imgLoaded, setImgLoaded] = useState(() => !!product.image && loadedImagesCache.has(product.image))

  // Ordinateur (pas mobile) : clic simple sur une carte produit ouvre un
  // NOUVEL onglet, comme AliExpress — demande explicite du fondateur
  // 2026-09-03, malgré la réserve UX habituelle (un clic simple qui ouvre
  // un popup surprend souvent les visiteurs) : il a confirmé vouloir ce
  // comportement précis après l'avoir vu sur AliExpress desktop. Détecté
  // via `(pointer: fine)` (souris/trackpad — un vrai signal de capacité
  // d'entrée, contrairement à la largeur d'écran qui se trompe sur les
  // tablettes/grands téléphones) plutôt qu'un test de taille d'écran.
  // Mobile garde le comportement normal (navigation sur place, onClick).
  const isDesktopPointer = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches
  const productHref = product.slug ? `/?v=product&slug=${product.slug}` : undefined

  function handleCardClick(e: React.MouseEvent) {
    if (isDesktopPointer && productHref) {
      e.preventDefault()
      window.open(productHref, '_blank', 'noopener,noreferrer')
      return
    }
    onClick(product)
  }

  return (
    <div
      className="bg-card border border-border rounded-md overflow-hidden hover:shadow-lg transition-all group cursor-pointer flex flex-col h-full"
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onMouseEnter={() => prefetchProduct(product)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(product) } }}
    >
      <div className="aspect-square relative overflow-hidden bg-muted">
        {product.image && !imgErrored ? (
          <>
            {!imgLoaded && (
              <div className="absolute inset-0 bg-gradient-to-r from-muted via-background/60 to-muted animate-pulse" />
            )}
            <LazyImage src={product.image} alt={product.name}
              decoding="async"
              className={`w-full h-full object-cover group-hover:scale-105 transition-all duration-500 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
              onLoad={() => { setImgLoaded(true); if (product.image) loadedImagesCache.add(product.image) }}
              onError={() => setImgErrored(true)} />
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-muted">
            <ShoppingBag size={32} className="text-muted-foreground/40" />
          </div>
        )}
        {product.countryCode && (
          <div className="absolute top-1.5 left-1.5 bg-white/90 backdrop-blur-sm px-1.5 py-0.5 rounded text-[9px] font-black shadow-sm uppercase border border-border/50">
            {product.countryCode}
          </div>
        )}
        <button
          type="button"
          aria-label={favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
          onClick={(e) => { e.stopPropagation(); toggleWishlist(product.id) }}
          className="absolute top-1.5 right-1.5 w-7 h-7 flex items-center justify-center hover:scale-110 transition-transform"
        >
          <Heart
            size={18}
            className={favorite ? 'fill-red-500 text-red-500 drop-shadow' : 'fill-black/20 text-white drop-shadow'}
          />
        </button>
        {local && (
          <div className="absolute bottom-1.5 left-1.5 flex items-center gap-0.5 bg-emerald-500 text-white px-1.5 py-0.5 rounded text-[9px] font-black shadow">
            <Truck size={9} /><span>3$ local</span>
          </div>
        )}
        {onQuickView && (
          <button
            type="button"
            aria-label="Aperçu rapide"
            onClick={(e) => { e.stopPropagation(); onQuickView(product) }}
            className="absolute bottom-1.5 right-1.5 w-7 h-7 flex items-center justify-center rounded-full bg-white/90 backdrop-blur-sm shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:scale-110"
          >
            <Eye size={14} className="text-foreground" />
          </button>
        )}
      </div>

      <div className="p-2.5 flex flex-col flex-1">
        {!hideVendorInfo && (
          <p className="text-[10px] text-muted-foreground uppercase font-bold truncate mb-1">{product.vendor?.name || 'Boutique MIAD'}</p>
        )}
        <h3 className="text-xs font-medium line-clamp-2 leading-tight h-8 mb-1.5 group-hover:text-accent transition-colors">{product.name}</h3>
        <div className="flex items-center gap-1 mb-2">
          <Star size={10} className="fill-orange-400 text-orange-400" />
          <span className="text-[10px] font-bold">{product.rating?.toFixed(1) || '4.9'}</span>
          <span className="text-[10px] text-muted-foreground ml-1">{product.salesCount || '100'}+ vendus</span>
        </div>
        <div className="flex items-end justify-between mt-auto">
          <div>
            {(() => {
              const { anchor, discount } = getAnchorPrice(product.price, product.regularPrice ?? 0)
              return (
                <>
                  <div className="flex items-center gap-1 mb-0.5">
                    <span className="text-[9px] line-through text-muted-foreground">{fp(anchor)}</span>
                    <span className="text-[9px] font-black text-red-500 bg-red-50 px-1 rounded">-{discount}%</span>
                  </div>
                  <p className="font-black text-sm text-accent leading-none">{fp(product.price)}</p>
                </>
              )
            })()}
          </div>
          <Button size="sm" className="bg-accent hover:bg-accent/90 h-8 px-2 rounded-lg flex items-center gap-1"
            onClick={(e) => { e.stopPropagation(); onAddToCart(product) }}>
            <ShoppingCart size={14} />
            {product.type === 'variable' && <span className="text-[9px] font-black uppercase">+</span>}
          </Button>
        </div>
      </div>
    </div>
  )
}

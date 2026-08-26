"use client"

import { useState } from 'react'
import { mutate } from 'swr'
import { Star, ShoppingCart, Truck, ShoppingBag, Heart } from 'lucide-react'
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
}

export function ProductCard({ product, onClick, onAddToCart, hideVendorInfo, userCountry = '' }: ProductCardProps) {
  const { formatPrice: fp } = useCurrency()
  const { isFavorite, toggle: toggleWishlist } = useWishlist()
  const favorite = isFavorite(product.id)
  const local = isLocalDelivery(product.countryCode || '', userCountry)
  const [imgErrored, setImgErrored] = useState(false)
  const [imgLoaded, setImgLoaded] = useState(() => !!product.image && loadedImagesCache.has(product.image))

  return (
    <div
      className="bg-card border border-border rounded-md overflow-hidden hover:shadow-lg transition-all group cursor-pointer flex flex-col h-full"
      role="button"
      tabIndex={0}
      onClick={() => onClick(product)}
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

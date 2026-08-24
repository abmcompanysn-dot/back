"use client"

import { useState } from 'react'
import { toast } from 'sonner'
import { Star, ShoppingCart, Truck, ShoppingBag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { type WooProduct } from '@/lib/woocommerce'
import { getAnchorPrice } from '@/lib/coins'
import { useCurrency } from '@/contexts/CurrencyContext'
import { isLocalDelivery } from '@/lib/shipping-utils'
import { addItemToCart } from '@/lib/cart-store'
import { LazyImage } from './LazyImage'
import { useStreamedNavClick } from '@/contexts/StreamedNavClickContext'

// Clone visuel de ProductCard.tsx, utilisé dans les sections Server Component
// streamées de l'accueil. Navigue via le callback handleProductClick de
// MiadMarketClient.tsx (exposé par StreamedNavClickContext) plutôt que par
// <Link href="/?v=product&slug=...">, qui obligeait à attendre que le produit
// soit retrouvé dans le state chargé côté client — voir LinkStoreCard.tsx
// pour le détail de l'incident. "Ajouter au panier" écrit toujours
// directement dans le panier partagé (lib/cart-store.ts).
const loadedImagesCache = new Set<string>()

interface LinkProductCardProps {
  product: WooProduct
  hideVendorInfo?: boolean
  userCountry?: string
}

export function LinkProductCard({ product, hideVendorInfo, userCountry = '' }: LinkProductCardProps) {
  const { formatPrice: fp } = useCurrency()
  const nav = useStreamedNavClick()
  const local = isLocalDelivery(product.countryCode || '', userCountry)
  const [imgErrored, setImgErrored] = useState(false)
  const [imgLoaded, setImgLoaded] = useState(() => !!product.image && loadedImagesCache.has(product.image))

  const handleAddToCart = (e: React.MouseEvent) => {
    // Produit variable : QuickSelectModal (choix des options) vit dans
    // MiadMarketClient, inaccessible depuis une section serveur — on laisse
    // le clic naviguer vers la fiche produit au lieu d'ajouter directement.
    if (product.type === 'variable') return
    e.preventDefault()
    e.stopPropagation()
    addItemToCart(product, 1)
    toast.success('Ajouté au panier', { description: product.name })
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => nav?.onProductClick(product)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav?.onProductClick(product) } }}
      className="bg-card border border-border rounded-md overflow-hidden hover:shadow-lg transition-all group flex flex-col h-full cursor-pointer"
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
            onClick={handleAddToCart}>
            <ShoppingCart size={14} />
            {product.type === 'variable' && <span className="text-[9px] font-black uppercase">+</span>}
          </Button>
        </div>
      </div>
    </div>
  )
}

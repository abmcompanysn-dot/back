"use client"

import { useEffect, useState } from 'react'
import { Star, ShoppingCart, X, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { type WooProduct } from '@/lib/woocommerce'
import { getAnchorPrice } from '@/lib/coins'
import { useCurrency } from '@/contexts/CurrencyContext'
import { LazyImage } from './LazyImage'

// QuickViewModal — "Aperçu rapide" (2026-09-03, demande du fondateur après
// un guide de bonnes pratiques e-commerce collé en conversation). Ouvre les
// infos essentielles d'un produit (image, prix, description courte, ajout
// panier direct) sans quitter la liste/grille où le visiteur navigue —
// évite l'aller-retour complet vers la fiche produit pour un simple coup
// d'œil.
//
// Volontairement SIMPLE pour un produit variable (taille/couleur...) :
// plutôt que de dupliquer ici toute la logique de sélection de variation
// de ProductDetail.tsx (état de chaque attribut, matching de variation,
// stock par variation...) — un vrai risque de bugs pour une fonctionnalité
// annexe — la modale affiche le produit tel quel et propose "Voir tous les
// détails" pour ouvrir la vraie fiche. Un produit simple (le cas le plus
// fréquent du catalogue) reste, lui, entièrement utilisable depuis la
// modale : ajout au panier direct sans quitter la liste.

interface QuickViewModalProps {
  product: WooProduct | null
  onClose: () => void
  onAddToCart: (product: WooProduct) => void
  onViewFull: (product: WooProduct) => void
}

export function QuickViewModal({ product, onClose, onAddToCart, onViewFull }: QuickViewModalProps) {
  const { formatPrice: fp } = useCurrency()
  const [imgLoaded, setImgLoaded] = useState(false)

  // Réinitialise l'état de chargement d'image à chaque nouveau produit
  // affiché (sinon l'image du produit précédent resterait "loaded" et la
  // nouvelle image apparaîtrait sans transition de fondu).
  useEffect(() => { setImgLoaded(false) }, [product?.id])

  if (!product) return null
  const isVariable = product.type === 'variable'
  const { anchor, discount } = getAnchorPrice(product.price, product.regularPrice ?? 0)

  return (
    <Dialog open={!!product} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl p-0 gap-0 overflow-hidden">
        {/* DialogTitle requis par Radix pour l'accessibilité (lecteurs
            d'écran) — visuellement redondant avec le <h2> plus bas, donc
            masqué à l'écran plutôt que dupliqué visuellement. */}
        <DialogTitle className="sr-only">{product.name}</DialogTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2">
          <div className="relative aspect-square bg-muted">
            {!imgLoaded && (
              <div className="absolute inset-0 bg-gradient-to-r from-muted via-background/60 to-muted animate-pulse" />
            )}
            {product.image && (
              <LazyImage
                src={product.image}
                alt={product.name}
                thumbnail={false}
                className={`w-full h-full object-cover transition-opacity duration-300 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
                onLoad={() => setImgLoaded(true)}
              />
            )}
          </div>

          <div className="p-5 flex flex-col overflow-y-auto max-h-[70vh] sm:max-h-none">
            <p className="text-[10px] text-muted-foreground uppercase font-bold mb-1">
              {product.vendor?.name || 'Boutique MIAD'}
            </p>
            <h2 className="text-base font-bold leading-snug mb-2">{product.name}</h2>
            <div className="flex items-center gap-1 mb-3">
              <Star size={12} className="fill-orange-400 text-orange-400" />
              <span className="text-xs font-bold">{product.rating?.toFixed(1) || '4.9'}</span>
              <span className="text-xs text-muted-foreground ml-1">{product.salesCount || '100'}+ vendus</span>
            </div>

            <div className="mb-4">
              {discount > 0 && (
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs line-through text-muted-foreground">{fp(anchor)}</span>
                  <span className="text-xs font-black text-red-500 bg-red-50 px-1.5 py-0.5 rounded">-{discount}%</span>
                </div>
              )}
              <p className="font-black text-2xl text-accent leading-none">{fp(product.price)}</p>
            </div>

            {product.shortDescription && (
              <p className="text-sm text-muted-foreground mb-4 line-clamp-4">{product.shortDescription}</p>
            )}

            <div className="mt-auto flex flex-col gap-2 pt-3">
              {isVariable ? (
                // Taille/couleur à choisir : pas de logique de variation
                // dupliquée ici (voir commentaire en tête de fichier) — on
                // dirige directement vers la vraie fiche.
                <Button className="w-full h-11" onClick={() => onViewFull(product)}>
                  Choisir les options
                </Button>
              ) : (
                <Button
                  className="w-full h-11 bg-accent hover:bg-accent/90 flex items-center gap-2"
                  onClick={() => { onAddToCart(product); onClose() }}
                >
                  <ShoppingCart size={16} />
                  Ajouter au panier
                </Button>
              )}
              <Button variant="outline" className="w-full h-10 flex items-center gap-2" onClick={() => onViewFull(product)}>
                <ExternalLink size={14} />
                Voir tous les détails
              </Button>
            </div>
          </div>
        </div>

        <button
          type="button"
          aria-label="Fermer"
          onClick={onClose}
          className="absolute top-3 right-3 w-8 h-8 flex items-center justify-center rounded-full bg-background/80 hover:bg-background shadow"
        >
          <X size={16} />
        </button>
      </DialogContent>
    </Dialog>
  )
}

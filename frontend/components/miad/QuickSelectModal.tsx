"use client"

import { useState, useMemo } from 'react'
import Image from 'next/image'
import { X, ShoppingCart, Check, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import useSWR from 'swr'
import { Skeleton } from '@/components/ui/skeleton'
import { type WooProduct, type WooProductVariation, type WooProductAttribute } from '@/lib/woocommerce'
import { useCurrency } from '@/contexts/CurrencyContext'

interface QuickSelectModalProps {
  product: WooProduct
  onClose: () => void
  onConfirm: (product: WooProduct, quantity: number, variation?: WooProductVariation) => void
}

export function QuickSelectModal({ product, onClose, onConfirm }: QuickSelectModalProps) {
  const { formatPrice: fp } = useCurrency()
  const [quantity, setQuantity] = useState(1)
  const [selectedAttributes, setSelectedAttributes] = useState<Record<string, string>>({})

  // "Deuxième hit" pour compléter les données si les variations manquent
  // BUG FIX: On détecte si product.variations ne contient que des IDs
  const { data: enrichedData, isLoading } = useSWR<any>(
    product.type === 'variable' && 
    (!product.variations || product.variations.length === 0 || typeof product.variations[0] === 'number')
      ? `/api/products?id=${product.id}&variations=true`
      : null,
    async (url: string) => {
      console.log(`[QuickSelectModal] Hit de complétion lancé pour: ${product.name}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error("Erreur réseau");
      const data = await res.json();
      if (data && data.products && data.products.length > 0) {
        console.log(`[QuickSelectModal] Hit réussi. Données complètes chargées.`);
        return data.products[0];
      }
      return null;
    }
  )

  const variations = useMemo(() => enrichedData?.variations || product.variations || [], [product.variations, enrichedData])
  const attributes = useMemo(() => enrichedData?.attributes || product.attributes || [], [product.attributes, enrichedData])

  const completeProduct = useMemo(() => ({
    ...product,
    variations,
    attributes
  }), [product, variations, attributes])

  const activeVariation = useMemo(() => {
    if (product.type !== 'variable' || variations.length === 0) return null
    
    const isSelectionComplete = attributes.length === Object.keys(selectedAttributes).length;
    if (!isSelectionComplete) return null;

    return variations.find((v: WooProductVariation) => {
      if (!v.attributes || v.attributes.length === 0) return false
      
      return attributes.every((pAttr: WooProductAttribute) => {
        const userValue = String(selectedAttributes[pAttr.name] || "").toLowerCase().trim();
        
        const vAttr = v.attributes.find((a: any) => {
          const vNameClean = a.name.toLowerCase().replace('pa_', '').trim();
          const pNameClean = pAttr.name.toLowerCase().replace('pa_', '').trim();
          return vNameClean === pNameClean;
        });
        
        if (!vAttr || !vAttr.option || vAttr.option === "" || vAttr.option.toLowerCase() === "any") return true;

        const variationValue = String(vAttr.option).toLowerCase().trim();

        return variationValue === userValue || 
               variationValue === userValue.replace(/\s+/g, '-') ||
               variationValue.replace(/-/g, ' ') === userValue;
      })
    })
  }, [variations, attributes, selectedAttributes, product.type]);

  const currentPrice = useMemo(() => {
    if (activeVariation) return Number(activeVariation.price);
    if (product.type === 'variable' && variations.length > 0) {
      const minPrice = variations.reduce((min: number, v: any) => {
        const p = Number(v.price);
        return !isNaN(p) && p > 0 && p < min ? p : min;
      }, Infinity);
      if (minPrice !== Infinity) {
        return minPrice; // On affiche le prix "à partir de"
      }
    }
    return Number(product.price);
  }, [activeVariation, product, variations]);

  const currentImage = activeVariation?.image || product.image

  const handleConfirm = () => {
    onConfirm(product, quantity, activeVariation || undefined);

    const variantLabel = activeVariation 
      ? ` (${activeVariation.attributes.map((a: any) => a.option).join(' / ')})` 
      : '';

    toast.success("Ajouté au panier", {
      description: `${product.name}${variantLabel}`,
      position: 'top-center',
      style: {
        background: '#1f2937',
        color: '#ffffff',
        borderRadius: '1rem',
      }
    });
  }

  return (
    <div className="fixed inset-0 z-100 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        role="button"
        tabIndex={0}
        aria-label="Fermer"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') onClose() }}
      />

      <div className="relative w-full max-w-md bg-background rounded-t-4xl sm:rounded-4xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom duration-300">
        <button type="button" onClick={onClose} aria-label="Fermer" className="absolute top-4 right-4 p-2 rounded-full bg-muted hover:bg-muted/80 z-10">
          <X size={20} />
        </button>

        <div className="p-6">
          {/* Header Produit */}
          <div className="flex gap-4 mb-6">
            <div className="relative w-24 h-24 rounded-2xl bg-muted overflow-hidden shrink-0 border border-border">
              <Image src={currentImage} alt={product.name} fill className="object-cover" />
            </div>
            <div className="flex-1 pt-1">
              <h3 className="font-bold text-foreground leading-tight line-clamp-1">{product.name}</h3>
              
              {/* Titre de la variante sélectionnée */}
              <div className="mt-1 h-4">
                {activeVariation ? (
                  <p className="text-[10px] font-black text-accent uppercase tracking-widest animate-in fade-in duration-300">
                    {activeVariation.attributes.map((a: any) => a.option).join(' / ')}
                  </p>
                ) : (
                  <p className="text-[10px] font-bold text-muted-foreground uppercase">Choisissez vos options</p>
                )}
              </div>

              <p className="text-2xl font-black text-accent mt-2">
                {!activeVariation && product.type === 'variable' && "Dès "}
                {fp(currentPrice)}
              </p>
              {activeVariation && (
                <p className="text-[10px] text-green-600 font-bold uppercase mt-1 flex items-center gap-1">
                  <Check size={10} /> En stock
                </p>
              )}
            </div>
          </div>

          {/* Attributs (Tailles, Couleurs) */}
          <div className="space-y-5 max-h-[40vh] overflow-y-auto pr-2 scrollbar-hide">
            {attributes.map((attr: WooProductAttribute) => (
              <div key={attr.name} className="space-y-3">
                <span className="text-xs font-black uppercase tracking-widest text-muted-foreground">{attr.name}</span>
                <div className="flex flex-wrap gap-2">
                  {attr.options.map((opt: string) => {
                    const isSelected = selectedAttributes[attr.name] === opt
                    return (
                      <button
                        type="button"
                        key={opt}
                        onClick={() => setSelectedAttributes(prev => ({ ...prev, [attr.name]: opt }))}
                        className={`px-4 py-2 rounded-xl border-2 text-xs font-bold transition-all ${
                          isSelected 
                            ? 'border-accent bg-accent text-white shadow-lg shadow-accent/20' 
                            : 'border-border hover:border-muted-foreground text-foreground'
                        }`}
                      >
                        {opt}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}

            {/* Quantité */}
            <div className="flex items-center justify-between pt-2">
              <span className="text-xs font-black uppercase tracking-widest text-muted-foreground">Quantité</span>
              <div className="flex items-center gap-3 bg-muted rounded-xl p-1">
                <button
                  type="button"
                  onClick={() => setQuantity(q => Math.max(1, q - 1))}
                  aria-label="Diminuer la quantité"
                  className="w-8 h-8 flex items-center justify-center hover:bg-background rounded-lg transition-colors"
                >
                  <Minus size={14} />
                </button>
                <span className="w-8 text-center font-bold">{quantity}</span>
                <button
                  type="button"
                  onClick={() => setQuantity(q => q + 1)}
                  aria-label="Augmenter la quantité"
                  className="w-8 h-8 flex items-center justify-center hover:bg-background rounded-lg transition-colors"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          </div>

          {/* Action */}
          <Button 
            className="w-full mt-8 h-14 bg-accent hover:bg-accent/90 text-white font-black text-sm uppercase tracking-widest rounded-2xl shadow-xl shadow-accent/20"
            disabled={isLoading || (product.type === 'variable' && !activeVariation)}
            onClick={handleConfirm}
          >
            <ShoppingCart size={18} className="mr-2" />
            {isLoading 
              ? "Chargement..." 
              : (product.type === 'variable' && !activeVariation) 
                ? "Sélectionner les options" 
                : "Ajouter au panier"}
          </Button>
        </div>
      </div>
    </div>
  )
}

import { useState, useEffect, useMemo, useCallback } from 'react'
import { type WooProduct, type WooProductVariation, type WooProductAttribute } from '@/lib/woocommerce'
import { cn } from '@/lib/utils'
import { Check } from 'lucide-react'
import { formatPrice } from '@/lib/woocommerce'

interface ProductVariationsProps {  product: WooProduct
  onVariationChange: (variation: WooProductVariation | null) => void
}

// Helper pour comparer les textes (ignore casse, tirets, underscores, espaces et encodage URI)
const normalizeString = (str: any) => {
  if (str === null || str === undefined) return '';
  const s = String(str).toLowerCase().trim();
  try {
    // Gère les espaces encodés (%20) et transforme les séparateurs en espaces simples
    return decodeURIComponent(s).replace(/[_-]/g, ' ').replace(/\s+/g, ' ');
  } catch (e) {
    return s.replace(/[_-]/g, ' ').replace(/\s+/g, ' ');
  }
};

export function ProductVariations({ product, onVariationChange }: ProductVariationsProps) {
  // État pour stocker les choix actuels de l'utilisateur (ex: { "Taille": "M", "Couleur": "Rouge" })
  // On garde le productId associé pour détecter un changement de produit sans effet de reset dédié
  const [selection, setSelection] = useState<{ productId: WooProduct['id']; options: Record<string, string> }>({
    productId: product.id,
    options: {},
  })

  // 1. Extraire les attributs disponibles depuis le produit
  const availableAttributes = useMemo(() => {
    // On ne garde que les attributs marqués comme servant aux variantes
    const attrs = product.attributes || [];
    const variationAttrs = attrs.filter(a => a.variation === true);
    const targetAttrs = variationAttrs.length > 0 ? variationAttrs : (product.type === 'variable' ? attrs : []);

    return targetAttrs.map(attr => {
      const options = Array.isArray(attr.options) && attr.options.length > 0
        ? attr.options 
        : (attr as any).value?.split(',').map((v: string) => v.trim()) || [];
        
      return {
        name: attr.name,
        slug: attr.slug || attr.name,
        options: options.filter((opt: string) => opt !== "")
      };
    }) || []
  }, [product.attributes, product.type])

  // Sélection par défaut, dérivée du produit : attributs par défaut WP,
  // sinon première variation (en stock de préférence), pour achat immédiat.
  const defaultSelection = useMemo(() => {
    if (!product.variations || product.variations.length === 0) return {}

    const initialSelection: Record<string, string> = {}

    // 1. Tenter d'utiliser les attributs par défaut configurés dans WooCommerce
    if (product.defaultAttributes && product.defaultAttributes.length > 0) {
      product.defaultAttributes.forEach((defAttr: any) => {
        // On cherche l'attribut UI correspondant pour utiliser la clé exacte (ex: "Couleur")
        const uiAttr = availableAttributes.find(a =>
          normalizeString(a.name).replace(/^pa\s+/, '') === normalizeString(defAttr.name).replace(/^pa\s+/, '')
        );
        if (uiAttr && defAttr.option) {
          initialSelection[uiAttr.name] = defAttr.option;
        }
      });
    }

    // 2. Sinon, présélectionner la première variation (en stock de préférence) pour achat immédiat
    if (Object.keys(initialSelection).length === 0) {
      const firstVar = product.variations.find(v => v.inStock) || product.variations[0]
      firstVar?.attributes?.forEach((attr: any) => {
        const uiAttr = availableAttributes.find(a =>
          normalizeString(a.name).replace(/^pa\s+/, '') === normalizeString(attr.name).replace(/^pa\s+/, '')
        );
        if (uiAttr && attr.option && attr.option.toLowerCase() !== 'any') {
          initialSelection[uiAttr.name] = attr.option;
        }
      })
    }

    return initialSelection
  }, [product.variations, product.defaultAttributes, availableAttributes])

  // Choix actifs : ceux de l'utilisateur pour CE produit s'il y en a, sinon la sélection par défaut.
  // Le productId stocké permet de retomber automatiquement sur les défauts quand le produit change,
  // sans effet dédié pour "réinitialiser" l'état.
  const selectedOptions =
    selection.productId === product.id && Object.keys(selection.options).length > 0
      ? selection.options
      : defaultSelection

  // 2. Chercher la variation qui correspond exactement à la sélection
  const matchedVariation = useMemo(() => {
    if (!product.variations || product.variations.length === 0) return null

    const isSelectionComplete = availableAttributes.length === Object.keys(selectedOptions).length;
    if (!isSelectionComplete) return null

    return product.variations.find((v: any) => {
      // EXTRACTION INTELLIGENTE : les variations peuvent arriver sous 3 formes :
      //  - tableau [{name,option}]            (ancien format WooCommerce)
      //  - objet {"Pointure":"40"}            (catalog-svc Go — format actuel)
      //  - clés à plat attribute_pa_taille=…  (fallback legacy)
      let vAttrs: { name: string; option: string }[] = [];

      if (Array.isArray(v.attributes)) {
        vAttrs = v.attributes;
      } else if (v.attributes && typeof v.attributes === 'object' && Object.keys(v.attributes).length > 0) {
        vAttrs = Object.entries(v.attributes).map(([name, option]) => ({ name, option: String(option) }));
      } else {
        // Si .attributes est absent, on scanne les clés (ex: attribute_pa_taille ou taille)
        vAttrs = Object.keys(v).map(k => ({
          name: k.replace('attribute_', '').replace('pa_', ''),
          option: String(v[k])
        }));
      }

      if (vAttrs.length === 0) return false;

      return availableAttributes.every(attr => {
        const userValue = String(selectedOptions[attr.name] || "").toLowerCase().trim();
        const attrNameClean = normalizeString(attr.name).replace(/^pa\s+/, '');

        // On cherche une correspondance dans vAttrs (jamais v.attributes
        // directement : ce n'est pas toujours un tableau — cf. ci-dessus).
        const vAttr = vAttrs.find((a: any) =>
          normalizeString(a.name).includes(attrNameClean) ||
          normalizeString(a.name) === normalizeString(attr.slug)
        );

        // Match "Any" de WooCommerce
        if (!vAttr || vAttr.option === "" || vAttr.option.toLowerCase() === "any" || vAttr.option === "undefined") {
          return true;
        }

        const variationValue = String(vAttr.option).toLowerCase().trim();

        // Comparaison flexible (valeur directe ou version slugifiée)
        return variationValue === userValue ||
               variationValue === userValue.replace(/\s+/g, '-') ||
               variationValue === userValue.replace(/\s+/g, '');
      })
    }) || null
  }, [selectedOptions, product.variations, availableAttributes])

  // On notifie le parent de la variante active dès qu'elle change (calcul dérivé côté enfant).
  useEffect(() => {
    onVariationChange(matchedVariation)
  }, [matchedVariation, onVariationChange])

  const handleSelect = (attrName: string, option: string) => {
    setSelection({
      productId: product.id,
      options: { ...selectedOptions, [attrName]: option },
    })
  }

  if (availableAttributes.length === 0) return null

  return (
    <div className="space-y-6 py-4">
      {availableAttributes.map((attr) => (
        <div key={attr.name} className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="font-bold text-foreground uppercase tracking-wider">
              {attr.name}
            </span>
            {selectedOptions[attr.name] && (
              <span className="text-muted-foreground font-medium">
                {selectedOptions[attr.name]}
              </span>
            )}
          </div>
         
          <div className="flex flex-wrap gap-2">
            {attr.options.map((option: string) => {
              const isSelected = selectedOptions[attr.name] === option
              
              return (
                <button
                  type="button"
                  key={option}
                  onClick={() => handleSelect(attr.name, option)}
                  className={cn(
                    "relative h-10 min-w-12 px-4 rounded-md border text-sm font-medium whitespace-nowrap transition-all flex items-center justify-center",
                    isSelected
                      ? "border-primary bg-primary/5 text-primary ring-2 ring-primary/20"
                      : "border-input bg-background hover:border-primary/50 text-foreground"
                  )}
                >
                  {option}
                  {isSelected && (
                    <div className="absolute -top-1 -right-1 bg-primary text-white rounded-full p-0.5 shadow-sm">
                      <Check size={10} strokeWidth={4} />
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

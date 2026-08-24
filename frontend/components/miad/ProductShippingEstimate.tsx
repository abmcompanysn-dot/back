"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, Truck, Clock } from 'lucide-react';
import { type WooProduct, type WooProductVariation } from '@/lib/woocommerce';
import { useCurrency } from '@/contexts/CurrencyContext'
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils'; // Assuming cn is still used for styling
import { getCountryZone, isLocalDelivery, COUNTRY_TO_ZONE } from '@/lib/shipping-utils'
import { useShippingRates, calcShipping } from '@/hooks/useShippingRates';
import { isSenegalDomestic, SENEGAL_DOMESTIC_FALLBACK_USD } from '@/lib/domestic-shipping-estimate';

interface ShippingOption {
  methodId: string;
  provider: string;
  cost: number;
  duration: string;
  description: string;
}

interface ProductShippingEstimateProps {
  product: WooProduct;
  selectedVariation?: WooProductVariation;
  quantity?: number;
  userCountryCode: string;
  onLoadingChange?: (isLoading: boolean) => void;
  onShippingCostCalculated?: (cost: number) => void;
  onShippingMethodChange?: (method: string) => void;
  onShippingDurationChange?: (duration: string) => void;
  globalShippingRates?: Record<string, any>; // NOUVELLE PROP
  customTrigger?: React.ReactNode; // Permet de rendre n'importe quel bloc cliquable
  selectedMethodId?: string;
  onMethodSelect?: (methodId: string) => void;
  onAllOptionsCalculated?: (options: ShippingOption[]) => void;
}

export function ProductShippingEstimate({
  product,
  selectedVariation,
  quantity = 1,
  userCountryCode,
  onLoadingChange,
  onShippingCostCalculated,
  onShippingMethodChange,
  onShippingDurationChange,
  globalShippingRates = {},
  customTrigger,
  selectedMethodId,
  onMethodSelect,
  onAllOptionsCalculated
}: ProductShippingEstimateProps) {
  const { formatPrice: fp } = useCurrency()
  const shippingConfig = useShippingRates()
  const [shippingOptions, setShippingOptions] = useState<ShippingOption[]>([]);
  const [internalMethodId, setInternalMethodId] = useState<string>('miad_standard');
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const activeMethodId = selectedMethodId || internalMethodId;

  const lastSentCost = useRef<number | null>(null);
  const lastSentMethod = useRef<string | null>(null);
  const lastSentDuration = useRef<string | null>(null);
  const isCalculating = useRef(false);

  const ratesKey = `${shippingConfig.local}-${shippingConfig.zone_africa}`;

  const fetchShippingEstimate = useCallback(async () => {
    if (isCalculating.current) return;
    isCalculating.current = true;
    onLoadingChange?.(true);

    try {
      const isLocal      = isLocalDelivery(product.countryCode || '', userCountryCode);
      const countryUpper = userCountryCode.toUpperCase();
      const zone         = getCountryZone(userCountryCode) || 'AF';
      const standardDuration = isLocal ? '1-3 jours ouvrés' : '15 jours ouvrés';
      const expressDuration  = isLocal ? '24-48h' : '3-5 jours ouvrés';

      let standardCostPerUnit: number;
      let expressCostPerUnit: number;

      if (isLocal && isSenegalDomestic(product.countryCode || '', userCountryCode)) {
        // Vendeur ET acheteur au Sénégal — le tarif "local" générique n'a
        // pas de sens ici, le module de livraison nationale (checkout)
        // calculera un vrai prix par distance une fois l'adresse connue.
        // Ici, avant adresse : même estimation de repli que le checkout
        // utilise lui-même tant que la ville du client n'est pas connue.
        standardCostPerUnit = SENEGAL_DOMESTIC_FALLBACK_USD;
        expressCostPerUnit  = SENEGAL_DOMESTIC_FALLBACK_USD;
      } else if (isLocal) {
        // Livraison locale (autre pays) — tarif dynamique WordPress
        standardCostPerUnit = shippingConfig.local;
        expressCostPerUnit  = shippingConfig.local;
      } else {
        // Priorité 1 : prix DHL par pays/zone dans les métadonnées du produit
        const productMeta      = Array.isArray(product.meta_data) ? product.meta_data : [];
        const metaCountryPrice = productMeta.find((m: any) => m.key === `_miad_ship_price_${countryUpper}`)?.value;
        const metaZonePrice    = productMeta.find((m: any) => m.key === `_miad_ship_price_zone_${zone}`)?.value;
        const metaPrice        = Number(metaCountryPrice ?? metaZonePrice);

        if (!isNaN(metaPrice) && metaPrice > 0) {
          // Meta = prix express DHL, standard = 40 % de l'express
          expressCostPerUnit  = metaPrice;
          standardCostPerUnit = metaPrice * 0.40;
        } else {
          // Priorité 2 : tarifs globaux depuis WordPress admin
          standardCostPerUnit = calcShipping(product.countryCode || '', userCountryCode, 'standard', shippingConfig, COUNTRY_TO_ZONE);
          expressCostPerUnit  = calcShipping(product.countryCode || '', userCountryCode, 'express',  shippingConfig, COUNTRY_TO_ZONE);
        }
      }

      const finalStandard = standardCostPerUnit * quantity;
      const finalExpress  = expressCostPerUnit  * quantity;

      console.log(`[DEBUG SHIPPING] Calcul final -> Express: ${finalExpress}$, Standard: ${finalStandard}$`);

      const options: ShippingOption[] = [
        {
          methodId: 'miad_standard',
          provider: 'MIAD Standard',
          cost: finalStandard,
          duration: standardDuration,
          description: 'Livraison économique standard.'
        },
        {
          methodId: 'miad_express',
          provider: 'MIAD Express',
          cost: finalExpress,
          duration: expressDuration,
          description: 'Livraison ultra-rapide MIAD Express.'
        }
      ];

      setShippingOptions(options);
      onAllOptionsCalculated?.(options);

      // On récupère l'option correspondant au choix mémorisé (ou Standard par défaut)
      const activeOption = options.find(o => o.methodId === activeMethodId) || options[0];

      // PROTECTION ANTI-BOUCLE : On ne notifie le parent que si les données ont changé
      if (activeOption.cost !== lastSentCost.current) {
        lastSentCost.current = activeOption.cost;
        onShippingCostCalculated?.(activeOption.cost);
      }
      if (activeOption.provider !== lastSentMethod.current) {
        lastSentMethod.current = activeOption.provider;
        onShippingMethodChange?.(activeOption.provider);
      }
      if (activeOption.duration !== lastSentDuration.current) {
        lastSentDuration.current = activeOption.duration;
        onShippingDurationChange?.(activeOption.duration);
      }

    } catch (error) {
      console.error("[ProductShippingEstimate] Erreur critique:", error);
      // Fallback pour éviter le "Cannot load"
      onShippingCostCalculated?.(10); 
      onShippingMethodChange?.('Indisponible');
    } finally {
      onLoadingChange?.(false);
      isCalculating.current = false;
    }
  }, [product.id, product.countryCode, product.meta_data, selectedVariation?.id, quantity, userCountryCode, ratesKey, shippingConfig, activeMethodId, onShippingCostCalculated, onShippingMethodChange, onShippingDurationChange, onAllOptionsCalculated, onLoadingChange]);

  useEffect(() => {
    fetchShippingEstimate();
  }, [fetchShippingEstimate]);

  const handleOptionSelect = (option: ShippingOption) => {
    if (onMethodSelect) {
      onMethodSelect(option.methodId);
    } else {
      setInternalMethodId(option.methodId);
    }
    setIsPopoverOpen(false);
    onShippingCostCalculated?.(option.cost);
    onShippingMethodChange?.(option.provider);
    onShippingDurationChange?.(option.duration);
  };

  const selectedOption = shippingOptions.find(o => o.methodId === activeMethodId) || shippingOptions[0];
  const isLocal = isLocalDelivery(product.countryCode || '', userCountryCode);

  if (!selectedOption) {
    return <div className="animate-pulse h-6 w-20 bg-muted rounded" />;
  }

  return (
    <Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
      <PopoverTrigger asChild onClick={() => setIsPopoverOpen(true)}>
        {customTrigger ? (
          customTrigger
        ) : (
          <Button variant="ghost" size="sm" className="h-auto p-0 text-xl font-black text-accent hover:text-accent/80">
            {isLocal && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-black bg-emerald-500 text-white px-1.5 py-0.5 rounded mr-1.5">
                <Truck size={9} /> Local
              </span>
            )}
            {selectedOption ? fp(selectedOption.cost) : '...'}
            <span className="text-xs text-muted-foreground ml-1">({selectedOption?.duration})</span>
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-lg">Options de livraison</h3>
          {isLocal && (
            <span className="inline-flex items-center gap-1 text-[10px] font-black bg-emerald-500/10 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full">
              <Truck size={9} /> Livraison locale
            </span>
          )}
        </div>
        <div className="space-y-3">
          {shippingOptions.map((option) => (
            <button
              type="button"
              key={option.methodId}
              onClick={() => handleOptionSelect(option)}
              className={cn(
                "w-full p-3 border rounded-lg text-left transition-all",
                activeMethodId === option.methodId
                  ? "border-accent bg-accent/5 ring-1 ring-accent"
                  : "border-gray-200 hover:border-gray-300"
              )}
            >
              <div className="flex items-center justify-between">
                <p className="font-semibold text-sm">{option.provider}</p>
                <p className={`font-bold text-sm ${isLocal ? 'text-emerald-600' : ''}`}>{fp(option.cost)}</p>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{option.description}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                <Clock size={12} /> {option.duration}
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
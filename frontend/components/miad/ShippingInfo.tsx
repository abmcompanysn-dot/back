"use client"
import React, { useMemo, useState } from 'react'
import { Truck, MapPin, ShieldCheck, Info, MessageCircle, Calendar, PackageCheck, Globe } from 'lucide-react'
import { type WooProduct, translations, type WooProductVariation, Country } from '@/lib/woocommerce'
import { useCurrency } from '@/contexts/CurrencyContext'
import { ProductShippingEstimate } from './ProductShippingEstimate'; // Import the new component
import { ALL_WORLD_COUNTRIES, getCountryZone } from '@/lib/shipping-utils';

interface ShippingInfoProps {
  product: WooProduct
  userCountry?: string
  language: 'fr' | 'en'
  onWhatsAppClick: () => void
  selectedVariation?: WooProductVariation;
  onLoadingChange?: (loading: boolean) => void;
  quantity?: number;
  onCountryChange?: (code: string) => void;
  globalShippingRates?: Record<string, any>;
  shippingCost: number | null; // Changed from optional to required, as it's always passed from ProductDetail
  onShippingCostCalculated?: (cost: number) => void;
  onShippingMethodChange?: (method: string) => void;
  onShippingDurationChange?: (duration: string) => void;
  selectedShippingMethod?: string;
  selectedShippingDuration?: string;
  selectedMethodId?: string;
  onMethodSelect?: (id: string) => void;
  availableOptions?: any[];
}

export function ShippingInfo({  
  product, 
  userCountry, 
  language, 
  onWhatsAppClick, 
  selectedVariation,
  onLoadingChange,
  quantity,
  onCountryChange,
  globalShippingRates,
  shippingCost,
  onShippingCostCalculated,
  onShippingMethodChange,
  onShippingDurationChange,
  selectedShippingMethod,

  selectedShippingDuration,
  selectedMethodId,
  onMethodSelect,
  availableOptions
}: ShippingInfoProps) {
  const t = (translations[language] || translations['fr']) as any;
  const { formatPrice: fp } = useCurrency()
  const [showCountrySelector, setShowCountrySelector] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState(userCountry || 'SN');

  // Calcul dynamique des dates de livraison (Style AliExpress)
  const deliveryDates = useMemo(() => {
    const today = new Date();
    const minDate = new Date(today);
    minDate.setDate(today.getDate() + 3);
    const maxDate = new Date(today);
    maxDate.setDate(today.getDate() + 7);

    const formatDate = (date: Date) => 
      date.toLocaleDateString(language === 'fr' ? 'fr-FR' : 'en-US', { day: 'numeric', month: 'short' });

    return {
      min: formatDate(minDate),
      max: formatDate(maxDate),
      days: language === 'fr' ? '3-7 jours' : '3-7 days'
    };
  }, [language]);
  
  const fromCountry = product.country || (language === 'fr' ? 'Afrique' : 'Africa');
  const countryName = ALL_WORLD_COUNTRIES.find((c: Country) => c.code.toLowerCase() === selectedCountry.toLowerCase())?.name || selectedCountry;
  const currentZone = getCountryZone(selectedCountry);

  return (
    <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm space-y-6 sticky top-24">
      {/* Section Logistique */}
      <div className="space-y-5">
        <div className="flex justify-between items-center">
          <h3 className="font-black uppercase text-[10px] tracking-widest text-slate-400">
            {t.shippingLogistics || (language === 'fr' ? 'Expédition & Logistique' : 'Shipping & Logistics')}
          </h3>
          <button
            type="button"
            onClick={() => setShowCountrySelector(!showCountrySelector)}
            className="text-[10px] font-bold text-accent flex items-center gap-1 hover:underline"
          >
            <Globe size={10} /> {language === 'fr' ? 'Changer pays' : 'Change country'}
          </button>
        </div>

        {showCountrySelector && (
          <select
            aria-label={language === 'fr' ? 'Choisir un pays' : 'Choose a country'}
            value={selectedCountry}
            onChange={(e) => { const code = e.target.value; setSelectedCountry(code); onCountryChange?.(code); setShowCountrySelector(false); }}
            className="w-full p-2 text-xs border rounded-lg bg-slate-50 font-bold"
          >
            {ALL_WORLD_COUNTRIES.map((c: Country) => <option key={c.code} value={c.code}>{c.flag} {c.name}</option>)}
          </select>
        )}
        
        {/* Bloc interactif pour choisir le mode de livraison */}
        <ProductShippingEstimate
          product={product}
          selectedVariation={selectedVariation}
          quantity={quantity}
          userCountryCode={selectedCountry}
          onLoadingChange={onLoadingChange}
          globalShippingRates={globalShippingRates}
          onShippingCostCalculated={onShippingCostCalculated}
          onShippingMethodChange={onShippingMethodChange}
          onShippingDurationChange={onShippingDurationChange}
          selectedMethodId={selectedMethodId}
          onMethodSelect={onMethodSelect}
          customTrigger={
            <button type="button" className="w-full flex items-start text-left gap-4 p-3 rounded-2xl bg-slate-50 border border-slate-200 hover:border-accent transition-all cursor-pointer group">
              <div className="w-10 h-10 rounded-xl bg-accent text-white flex items-center justify-center shrink-0">
                <Truck size={20} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-center mb-1">
                  <p className="text-sm font-black">{selectedShippingMethod || 'Livraison'}</p>
                  <span className="text-[9px] bg-accent/10 text-accent px-1.5 py-0.5 rounded font-black uppercase">Changer</span>
                </div>
                <p className="text-[11px] text-muted-foreground">Dest. <span className="text-slate-900 font-bold">{countryName}</span></p>
                <div className="mt-1">
                  <p className="text-xs font-black text-accent">
                    {shippingCost !== null && Number(shippingCost) > 0 
                      ? fp(shippingCost)
                      : "Calcul en cours..."}
                    <span className="text-[9px] font-bold text-muted-foreground">
                      / commande {currentZone ? ` (Zone ${currentZone})` : ''}
                    </span>
                  </p>
                  <p className="text-[9px] text-slate-400 font-medium">Délai : {selectedShippingDuration}</p>
                  {availableOptions && availableOptions.length > 1 && (
                    <div className="mt-2 flex gap-2 overflow-hidden">
                      {availableOptions.map(opt => (
                        <div key={opt.methodId} className={`text-[8px] px-1.5 py-0.5 rounded border ${opt.methodId === selectedMethodId ? 'bg-accent/10 border-accent/20 text-accent' : 'bg-white border-slate-200 text-slate-400'}`}>
                          {opt.methodId.includes('express') ? 'EXPRESS' : 'STD'}: {fp(opt.cost)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </button>
          }
        />

        {/* Info Arrivée prévue */}
        <div className="flex items-start gap-4 px-3">
          <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center shrink-0">
            <Calendar className="text-slate-400" size={18} />
          </div>
          <div className="flex-1">
            <p className="text-xs font-bold text-slate-700">{language === 'fr' ? 'Livraison prévue' : 'Delivery expected'}</p>
            <p className="text-[11px] text-slate-500 font-medium">
              {deliveryDates.min} - {deliveryDates.max} ({deliveryDates.days})
            </p>
          </div>
        </div>

        {/* Info Expédition */}
        <div className="flex items-start gap-4 px-3">
          <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center shrink-0">
            <MapPin className="text-slate-400" size={18} />
          </div>
          <div className="flex-1">
            <p className="text-xs font-bold text-slate-700">{language === 'fr' ? 'Expédié depuis' : 'Shipped from'}</p>
            <p className="text-[11px] text-slate-500 font-medium">{fromCountry}</p>
          </div>
        </div>

        {/* Info Suivi */}
        <div className="flex items-start gap-4 px-3">
          <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center shrink-0">
            <PackageCheck className="text-slate-400" size={18} />
          </div>
          <div className="flex-1">
            <p className="text-xs font-bold text-slate-700">{language === 'fr' ? 'Suivi de colis' : 'Tracking'}</p>
            <p className="text-[11px] text-slate-500 font-medium">{language === 'fr' ? 'Numéro de suivi disponible' : 'Tracking number provided'}</p>
          </div>
        </div>
      </div>

      <div className="pt-6 border-t border-slate-100">
        <div className="flex items-center gap-2 text-green-600 mb-2 font-bold">
          <ShieldCheck size={18} />
          <span className="text-[10px] font-black uppercase tracking-tighter">
            {t.buyerProtection || (language === 'fr' ? 'Protection Acheteur' : 'Buyer Protection')}
          </span>
        </div>
        <p className="text-[11px] text-slate-500 leading-relaxed font-medium">
          {language === 'fr' 
            ? "Garantie de remboursement de 7 jours si l'article n'est pas conforme à la description."
            : "7-day money-back guarantee if the item is not as described."}
        </p>
      </div>

      <div className="bg-slate-50 p-4 rounded-2xl flex items-center gap-3 border border-slate-100 shadow-inner">
         <div className="p-1.5 bg-white rounded-lg shadow-sm">
           <Info size={14} className="text-slate-400" />
         </div>
         <p className="text-[10px] text-slate-500 font-bold leading-tight">
           {language === 'fr' ? 'Paiement sécurisé' : 'Secure payment'} : Wave, Orange Money, Visa, Mastercard.
         </p>
      </div>

      <button
        type="button"
        onClick={onWhatsAppClick}
        className="w-full h-14 bg-green-500 hover:bg-green-600 text-white font-black uppercase text-xs tracking-widest rounded-2xl shadow-xl shadow-green-500/20 flex items-center justify-center gap-3 transition-all active:scale-95 group"
      >
        <MessageCircle size={20} className="group-hover:rotate-12 transition-transform" /> 
        {language === 'fr' ? 'Négocier sur WhatsApp' : 'Negotiate on WhatsApp'}
      </button>
    </div>
  )
}
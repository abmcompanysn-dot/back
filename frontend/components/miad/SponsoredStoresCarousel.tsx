"use client"

import { useState } from 'react'
import { Star, ChevronRight, Check, ArrowRight, Package } from 'lucide-react'
import { type WooVendor, type WooProduct, translations } from '@/lib/woocommerce'
import { LazyImage } from './LazyImage'
import { useStreamedNavClick } from '@/contexts/StreamedNavClickContext'

// Carrousel "flip" entre vendeurs sponsorisés — contrairement à un simple
// défilement (ScrollRow), ici on bascule l'affichage complet entre des
// vendeurs différents (état `current`), ce qui a besoin de TOUTES les
// données déjà chargées côté client. Reçoit donc les données déjà fetchées
// côté serveur (SponsoredStoresServer.tsx) en props sérialisables, plutôt
// que d'être lui-même un Server Component. Le bouton "Acheter" navigue via
// StreamedNavClickContext (voir LinkStoreCard.tsx) plutôt que par <Link>.
interface SponsoredVendor extends WooVendor {
  topProducts: WooProduct[]
}

export function SponsoredStoresCarousel({ sponsored, lang = 'fr' }: { sponsored: SponsoredVendor[]; lang?: 'fr' | 'en' }) {
  const nav = useStreamedNavClick()
  const [current, setCurrent] = useState(0)
  const [broken, setBroken] = useState<Set<string | number>>(new Set())
  const t = translations[lang]

  if (sponsored.length === 0) return null
  const vendor = sponsored[current]
  const vendorProducts = vendor.topProducts.filter(p => !broken.has(p.id))

  const prev = () => setCurrent(i => (i - 1 + sponsored.length) % sponsored.length)
  const next = () => setCurrent(i => (i + 1) % sponsored.length)

  return (
    <section className="py-6 bg-white border-b border-border/30">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-accent flex items-center justify-center shadow-md shadow-accent/30">
              <Star size={16} className="text-white fill-white" />
            </div>
            <h2 className="text-lg font-black uppercase tracking-tighter">{t.sponsoredStores}</h2>
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden relative">
          <div className="flex items-center gap-3 px-4 pt-4 pb-3">
            <div className="w-14 h-14 rounded-full bg-gray-900 overflow-hidden border-2 border-border shrink-0 flex items-center justify-center">
              {vendor.logo && vendor.logo !== '' ? (
                <LazyImage src={vendor.logo} alt={vendor.name} className="w-full h-full object-cover" decoding="async" />
              ) : (
                <span className="text-white font-black text-lg">{vendor.name.charAt(0)}</span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-black text-sm uppercase tracking-tight truncate">{vendor.name}</span>
                <div className="w-4 h-4 rounded-full bg-blue-500 flex items-center justify-center shrink-0">
                  <Check size={9} className="text-white stroke-[3]" />
                </div>
              </div>
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <span className="text-[11px] font-bold border border-accent text-accent rounded-full px-2.5 py-0.5 flex items-center gap-1">
                  <ArrowRight size={10} /> {t.sponsoredBadge}
                </span>
                <span className="text-[11px] font-bold bg-orange-50 text-orange-500 border border-orange-200 rounded-full px-2.5 py-0.5 flex items-center gap-1">
                  <Star size={9} className="fill-orange-500" /> {t.recommendedStore}
                </span>
              </div>
            </div>
          </div>
          <div className="px-4 pb-3 relative">
            <div className="grid grid-cols-3 gap-2">
              {vendorProducts.length > 0 ? vendorProducts.slice(0, 3).map(p => (
                <div key={p.id} className="aspect-square rounded-xl overflow-hidden bg-muted">
                  {p.image && p.image !== '/placeholder.jpg' ? (
                    <LazyImage src={p.image} alt={p.name} className="w-full h-full object-cover"
                      onError={() => setBroken(prev => new Set(prev).add(p.id))} />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-muted">
                      <Package size={20} className="text-muted-foreground" />
                    </div>
                  )}
                </div>
              )) : (
                <>
                  <div className="aspect-square rounded-xl bg-muted" />
                  <div className="aspect-square rounded-xl bg-muted/70" />
                  <div className="aspect-square rounded-xl bg-muted/50" />
                </>
              )}
            </div>
            {sponsored.length > 1 && (
              <>
                <button type="button" onClick={prev} aria-label={lang === 'en' ? 'Previous sponsored store' : 'Boutique sponsorisée précédente'} className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/90 border border-border shadow-md flex items-center justify-center hover:bg-accent hover:text-white hover:border-accent transition-all">
                  <ChevronRight size={18} className="rotate-180" />
                </button>
                <button type="button" onClick={next} aria-label={lang === 'en' ? 'Next sponsored store' : 'Boutique sponsorisée suivante'} className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/90 border border-border shadow-md flex items-center justify-center hover:bg-accent hover:text-white hover:border-accent transition-all">
                  <ChevronRight size={18} />
                </button>
              </>
            )}
          </div>
          <div className="flex items-center justify-between px-4 py-3 border-t border-border/50">
            <div className="flex-1 min-w-0 pr-3">
              <p className="text-sm font-bold text-foreground truncate">{t.nevoRecommends}</p>
              <p className="text-xs text-muted-foreground">{t.fastDeliveryQuality}</p>
            </div>
            <button
              type="button"
              onClick={() => nav?.onVendorClick(vendor)}
              className="shrink-0 px-4 py-2 bg-teal-400/20 text-teal-700 font-bold text-sm rounded-full hover:bg-teal-400/30 transition-colors"
            >
              {t.buyNow}
            </button>
          </div>
          {sponsored.length > 1 && (
            <div className="flex justify-center gap-1.5 pb-3">
              {sponsored.map((s, i) => (
                <button type="button" key={s.id} onClick={() => setCurrent(i)} aria-label={lang === 'en' ? `View store ${s.name}` : `Voir la boutique ${s.name}`} className={`w-1.5 h-1.5 rounded-full transition-all ${i === current ? 'bg-accent w-4' : 'bg-border'}`} />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

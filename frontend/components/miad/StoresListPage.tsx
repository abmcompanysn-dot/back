"use client"

import { useState, useMemo } from 'react'
import Image from 'next/image'
import { ArrowLeft, Store, Star, MapPin } from 'lucide-react'
import { type WooVendor, countries } from '@/lib/woocommerce'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { LazyImage } from './LazyImage'

interface StoresListPageProps {
  stores: WooVendor[]
  isLoading: boolean
  onBack: () => void
  onStoreClick: (vendor: WooVendor) => void
}

export function StoresListPage({ stores, isLoading, onBack, onStoreClick }: StoresListPageProps) {
  const [filterCountry, setFilterCountry] = useState<string | null>(null)

  // Extraction des pays qui possèdent au moins une boutique
  const existingCountryCodes = useMemo(() => {
    return new Set(stores.flatMap(s => {
      const code = s.countryCode?.toLowerCase()
      return code ? [code] : []
    }))
  }, [stores])

  const countriesWithStores = useMemo(() => {
    return countries.filter(c => existingCountryCodes.has(c.code.toLowerCase()))
  }, [existingCountryCodes])

  const filteredStores = useMemo(() => {
    if (!filterCountry) return stores
    return stores.filter(s => s.countryCode?.toLowerCase() === filterCountry.toLowerCase())
  }, [stores, filterCountry])

  // Groupement des boutiques par pays pour le "classement" visuel
  const storesGroupedByCountry = useMemo(() => {
    const grouped: Record<string, WooVendor[]> = {}
    filteredStores.forEach(s => {
      const code = s.countryCode?.toLowerCase() || 'other'
      if (!grouped[code]) grouped[code] = []
      grouped[code].push(s)
    })
    return grouped
  }, [filteredStores])

  return (
    <main className="min-h-screen bg-muted/10 pb-20">
      <div className="container mx-auto px-4 py-10">
        {/* Header */}
        <div className="flex flex-col gap-6 mb-10">
          <div className="flex items-center gap-4">
            <button type="button" onClick={onBack} aria-label="Retour" className="p-2 hover:bg-muted rounded-full transition-colors">
              <ArrowLeft size={24} />
            </button>
            <h1 className="text-3xl font-black uppercase tracking-tighter italic">Répertoire des Boutiques</h1>
          </div>

          {/* Filtre par Pays (Flags) */}
          <div className="flex gap-3 overflow-x-auto pb-4 scrollbar-hide">
            <Button 
              variant={filterCountry === null ? "default" : "outline"}
              size="sm"
              onClick={() => setFilterCountry(null)}
              className="rounded-full font-bold uppercase text-[10px] tracking-widest h-10 px-6"
            >
              Toutes
            </Button>
            {countriesWithStores.map((c) => (
              <Button
                key={c.code}
                variant={filterCountry === c.code ? "default" : "outline"}
                size="sm"
                onClick={() => setFilterCountry(c.code)}
                className="rounded-full gap-2 font-bold uppercase text-[10px] tracking-widest h-10 px-5 shrink-0"
              >
                <span className="text-lg">{c.flag}</span> {c.name}
              </Button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {[...Array(12)].map((_, i) => <Skeleton key={i} className="aspect-square rounded-2xl" />)}
          </div>
        ) : (
          <div className="space-y-16">
            {Object.entries(storesGroupedByCountry).map(([code, countryStores]) => {
              const country = countries.find(c => c.code.toLowerCase() === code)
              return (
                <section key={code} className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="flex items-center gap-3 mb-8">
                    <div className="relative w-10 h-7 rounded overflow-hidden shadow-sm border border-border shrink-0">
                      <Image src={`https://flagcdn.com/w80/${code === 'other' ? 'un' : code}.png`} fill sizes="40px" className="object-cover" alt="" />
                    </div>
                    <h2 className="text-sm font-black uppercase tracking-[0.2em] text-muted-foreground">
                      Marché {country?.name || 'International'}
                    </h2>
                    <div className="h-px bg-border flex-1 ml-4" />
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
                    {countryStores.map((vendor) => (
                      <div
                        key={vendor.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => onStoreClick(vendor)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStoreClick(vendor) } }}
                        className="bg-card border border-border rounded-3xl p-6 text-center hover:shadow-2xl transition-all cursor-pointer group relative overflow-hidden block"
                      >
                        <div className="absolute top-0 left-0 right-0 h-14 bg-accent/5 group-hover:bg-accent/10 transition-colors" />
                        <div className="w-20 h-20 mx-auto mb-4 rounded-full overflow-hidden bg-white border-4 border-white shadow-lg relative z-10">
                          {vendor.logo ? (
                            <LazyImage src={vendor.logo} decoding="async" className="w-full h-full object-cover" alt={vendor.name} />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-muted text-muted-foreground/30">
                              <Store size={32} />
                            </div>
                          )}
                        </div>
                        <h3 className="text-sm font-black truncate mb-1 uppercase tracking-tight text-foreground group-hover:text-accent transition-colors">
                          {vendor.name}
                        </h3>
                        <div className="flex items-center justify-center gap-2 mt-2">
                          <div className="flex items-center gap-0.5 text-[10px] font-bold text-orange-500">
                            <Star size={10} className="fill-orange-500" /> {Number(vendor.rating || 5.0).toFixed(1)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )
            })}

            {filteredStores.length === 0 && (
              <div className="text-center py-32 opacity-30">
                <Store size={64} className="mx-auto mb-6" />
                <p className="font-black uppercase text-xs tracking-widest">Aucune boutique trouvée dans cette région</p>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  )
}
"use client"

import { useState } from 'react'
import { X, ChevronDown } from 'lucide-react'
import { ALL_WORLD_COUNTRIES } from '@/lib/shipping-utils'
import { translations } from '@/lib/woocommerce'

interface CountryDetectionBannerProps {
  countryCode: string
  onChangeCountry: (code: string) => void
  language?: 'fr' | 'en'
}

// Rend visible et corrigeable en un clic la détection automatique du pays
// (IP), au lieu qu'une mauvaise détection fausse silencieusement le tarif de
// livraison affiché — incident signalé le 2026-07-17 (client au Canada
// facturé au tarif "livraison locale" à cause d'une détection IP erronée).
export function CountryDetectionBanner({ countryCode, onChangeCountry, language = 'fr' }: CountryDetectionBannerProps) {
  const [dismissed, setDismissed] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const country = ALL_WORLD_COUNTRIES.find(c => c.code === countryCode.toLowerCase())
  const t = translations[language]

  if (dismissed || !country) return null

  return (
    <div className="relative bg-accent/10 border-b border-accent/20 text-xs sm:text-sm">
      <div className="container mx-auto px-4 py-2 flex items-center justify-center gap-2 flex-wrap text-foreground/80">
        <span>
          {t.estimatedDeliveryFor} {country.flag} <strong>{country.name}</strong> — {t.wrongCountry}
        </span>
        <button
          type="button"
          onClick={() => setPickerOpen(o => !o)}
          className="font-black text-accent underline underline-offset-2 flex items-center gap-1 shrink-0"
        >
          {t.change} <ChevronDown size={14} className={pickerOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label={t.close}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:opacity-70"
        >
          <X size={14} />
        </button>
      </div>

      {pickerOpen && (
        <div className="absolute z-50 left-1/2 -translate-x-1/2 top-full mt-1 max-h-72 w-72 overflow-y-auto bg-white border border-border rounded-xl shadow-xl py-1">
          {ALL_WORLD_COUNTRIES.map(c => (
            <button
              key={c.code}
              type="button"
              onClick={() => {
                onChangeCountry(c.code.toUpperCase())
                setPickerOpen(false)
                setDismissed(true)
              }}
              className="w-full text-left px-4 py-2 text-sm hover:bg-muted flex items-center gap-2 text-foreground"
            >
              <span>{c.flag}</span><span>{c.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

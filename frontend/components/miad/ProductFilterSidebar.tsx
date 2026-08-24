"use client"

import { Check } from 'lucide-react'
import { countries } from '@/lib/woocommerce'
import { PRICE_RANGES, MIN_RATINGS } from '@/lib/product-filters'

interface ProductFilterSidebarProps {
  selectedCountries: string[]
  onSelectedCountriesChange: (codes: string[]) => void
  priceRange: [number, number]
  onPriceRangeChange: (range: [number, number]) => void
  minRating: number
  onMinRatingChange: (rating: number) => void
}

export function ProductFilterSidebar({
  selectedCountries,
  onSelectedCountriesChange,
  priceRange,
  onPriceRangeChange,
  minRating,
  onMinRatingChange,
}: ProductFilterSidebarProps) {
  const selectedSet = new Set(selectedCountries)
  return (
    <div className="space-y-10">
      <div>
        <h3 className="font-black text-[10px] uppercase tracking-[0.2em] mb-6 text-muted-foreground">Origine</h3>
        <div className="grid grid-cols-1 gap-1">
          {countries.map(country => {
            const code = country.code.toLowerCase()
            const active = selectedSet.has(code)
            return (
              <button
                type="button"
                key={country.code}
                onClick={() => onSelectedCountriesChange(
                  active ? selectedCountries.filter(c => c !== code) : [...selectedCountries, code]
                )}
                className={`flex items-center justify-between w-full p-3 rounded-2xl text-sm transition-all ${
                  active ? 'bg-accent text-white font-bold shadow-lg shadow-accent/20' : 'hover:bg-muted text-foreground'
                }`}
              >
                <span className="flex items-center gap-3">
                  <span className="text-xl">{country.flag}</span>
                  {country.name}
                </span>
                {active && <Check size={14} />}
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <h3 className="font-black text-[10px] uppercase tracking-[0.2em] mb-6 text-muted-foreground">Budget</h3>
        <div className="space-y-1">
          {PRICE_RANGES.map(range => (
            <button
              type="button"
              key={range.label}
              onClick={() => onPriceRangeChange([range.min, range.max])}
              className={`block w-full text-left p-3 rounded-2xl text-sm transition-all ${
                priceRange[0] === range.min && priceRange[1] === range.max ? 'bg-accent/10 text-accent font-bold border border-accent/20' : 'hover:bg-muted text-muted-foreground'
              }`}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="font-black text-[10px] uppercase tracking-[0.2em] mb-6 text-muted-foreground">Note</h3>
        <div className="space-y-1">
          {MIN_RATINGS.map(r => (
            <button
              type="button"
              key={r.label}
              onClick={() => onMinRatingChange(r.value)}
              className={`block w-full text-left p-3 rounded-2xl text-sm transition-all ${
                minRating === r.value ? 'bg-accent/10 text-accent font-bold border border-accent/20' : 'hover:bg-muted text-muted-foreground'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

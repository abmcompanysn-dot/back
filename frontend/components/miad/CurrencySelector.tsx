"use client"

import { useCurrency, type Currency } from '@/contexts/CurrencyContext'
import { ChevronDown } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'

const OPTIONS: { value: Currency; symbol: string; label: string }[] = [
  { value: 'USD',  symbol: '$',    label: 'Dollar US'       },
  { value: 'CAD',  symbol: 'CA$',  label: 'Dollar canadien' },
  { value: 'EUR',  symbol: '€',    label: 'Euro'            },
  { value: 'GBP',  symbol: '£',    label: 'Livre sterling'  },
  { value: 'FCFA', symbol: 'XOF',  label: 'Franc CFA'       },
  { value: 'MAD',  symbol: 'MAD',  label: 'Dirham marocain' },
  { value: 'GHS',  symbol: 'GH₵',  label: 'Cedi ghanéen'   },
  { value: 'GNF',  symbol: 'GNF',  label: 'Franc guinéen'   },
]

export function CurrencySelector({ className = '' }: { className?: string }) {
  const { currency, setCurrency } = useCurrency()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const current = OPTIONS.find(o => o.value === currency) ?? OPTIONS[0]

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 px-2.5 py-1.5 rounded-full border border-border bg-white hover:bg-muted/40 text-xs font-black transition-colors"
        aria-label="Changer de devise"
      >
        <span className="text-sm font-black text-foreground">{current.symbol}</span>
        <ChevronDown size={11} className={`text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 mt-1.5 w-44 bg-white border border-border rounded-2xl shadow-xl z-80 overflow-hidden">
          {OPTIONS.map(opt => (
            <button
              type="button"
              key={opt.value}
              onClick={() => { setCurrency(opt.value); setOpen(false) }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 text-xs transition-colors hover:bg-muted/50 ${currency === opt.value ? 'text-accent font-black bg-accent/5' : 'text-foreground font-bold'}`}
            >
              <span className="text-sm font-black w-10 text-center shrink-0">{opt.symbol}</span>
              <div className="text-left min-w-0">
                <p className="text-[11px] font-black">{opt.value === 'FCFA' ? 'XOF' : opt.value}</p>
                <p className="text-[10px] text-muted-foreground font-medium truncate">{opt.label}</p>
              </div>
              {currency === opt.value && <span className="ml-auto text-accent text-xs shrink-0">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

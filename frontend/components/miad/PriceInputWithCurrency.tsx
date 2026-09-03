"use client"

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { useCurrency, type Currency } from '@/contexts/CurrencyContext'

// PriceInputWithCurrency — champ de saisie de prix pour le dashboard
// vendeur (Dashboard.tsx). Ajouté le 2026-09-03 : jusqu'ici un vendeur
// devait toujours calculer lui-même la conversion en dollars US avant de
// taper un prix (le catalogue est stocké en USD réel, voir CLAUDE.md
// racine) — pénible pour un vendeur qui pense en XOF/GHS/CAD. Ce champ
// laisse le vendeur choisir SA devise et taper le prix dedans ; la
// conversion en USD se fait ici avec les mêmes taux à jour que le reste
// du site (useCurrency), et c'est TOUJOURS la valeur USD qui est renvoyée
// au parent via onUsdChange — le contrat de données (prix stocké en USD)
// ne change pas, seule la saisie devient plus confortable.
//
// Le vendeur peut changer de devise à tout moment sans perdre son prix :
// on reconvertit l'affichage depuis la valeur USD déjà connue, jamais
// depuis le texte tapé (qui pourrait être partiel/invalide pendant la
// frappe).

interface Props {
  id: string
  usdValue: string // valeur USD actuelle (contrôlée par le parent, comme un <Input> normal)
  onUsdChange: (usd: string) => void
  placeholder?: string
  required?: boolean
  className?: string
}

// Sous-ensemble de devises pertinentes pour un vendeur (pas EUR/GBP/MAD,
// peu probables pour un vendeur africain de cette marketplace — et de
// toute façon non suivies par le vrai système de taux, voir
// CurrencyContext.tsx). USD explicitement inclus en premier : certains
// vendeurs préfèrent continuer à taper directement en dollars.
const VENDOR_CURRENCIES: Currency[] = ['USD', 'FCFA', 'GHS', 'CAD']

export function PriceInputWithCurrency({ id, usdValue, onUsdChange, placeholder, required, className }: Props) {
  const { rates } = useCurrency()
  const [displayCurrency, setDisplayCurrency] = useState<Currency>('USD')
  // Texte affiché dans le champ — distinct de usdValue quand displayCurrency
  // != USD, pour ne pas reformater agressivement pendant que l'utilisateur tape.
  const [localText, setLocalText] = useState(usdValue)

  // Si le prix USD change depuis l'extérieur (ex: bascule promo qui
  // recopie regularPrice), on resynchronise l'affichage dans la devise
  // courante — sans ça le champ garderait un texte périmé.
  useEffect(() => {
    const usdNum = parseFloat(usdValue)
    if (!isFinite(usdNum)) { setLocalText(usdValue); return }
    if (displayCurrency === 'USD') {
      setLocalText(usdValue)
    } else {
      const rate = rates[displayCurrency] || 1
      setLocalText((usdNum * rate).toFixed(2))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usdValue])

  function handleTextChange(text: string) {
    setLocalText(text)
    const num = parseFloat(text)
    if (!isFinite(num)) { onUsdChange(''); return }
    if (displayCurrency === 'USD') {
      onUsdChange(text)
    } else {
      const rate = rates[displayCurrency] || 1
      onUsdChange((num / rate).toFixed(2))
    }
  }

  function handleCurrencyChange(next: Currency) {
    setDisplayCurrency(next)
    // Reconvertit l'affichage depuis la valeur USD connue (source de
    // vérité), pas depuis localText — évite d'accumuler des arrondis à
    // chaque changement de devise.
    const usdNum = parseFloat(usdValue)
    if (!isFinite(usdNum)) return
    if (next === 'USD') {
      setLocalText(usdValue)
    } else {
      const rate = rates[next] || 1
      setLocalText((usdNum * rate).toFixed(2))
    }
  }

  return (
    <div className={`flex gap-1.5 ${className || ''}`}>
      <Input
        id={id}
        type="number"
        step="0.01"
        placeholder={placeholder}
        required={required}
        value={localText}
        onChange={(e) => handleTextChange(e.target.value)}
        className="flex-1"
      />
      <select
        aria-label="Devise du prix saisi"
        value={displayCurrency}
        onChange={(e) => handleCurrencyChange(e.target.value as Currency)}
        className="h-10 px-2 rounded-md border border-input bg-background text-xs font-bold shrink-0"
      >
        {VENDOR_CURRENCIES.map((c) => (
          <option key={c} value={c}>{c === 'FCFA' ? 'XOF' : c}</option>
        ))}
      </select>
    </div>
  )
}

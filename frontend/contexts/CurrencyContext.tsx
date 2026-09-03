"use client"

import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import useSWR from 'swr'

export type Currency = 'USD' | 'EUR' | 'FCFA' | 'GHS' | 'GNF' | 'CAD' | 'GBP' | 'MAD'

interface CurrencyRates {
  USD:  number
  EUR:  number
  FCFA: number
  GHS:  number
  GNF:  number
  CAD:  number
  GBP:  number
  MAD:  number
}

interface CurrencyContextValue {
  currency:    Currency
  setCurrency: (c: Currency) => void
  rates:       CurrencyRates
  formatPrice: (usdAmount: number) => string
  symbol:      string
}

// Taux codés en dur = fallback si l'API est injoignable
const FALLBACK_RATES: CurrencyRates = {
  USD:  1,
  EUR:  0.92,
  FCFA: 600,
  GHS:  12.5,
  GNF:  8600,
  CAD:  1.36,
  GBP:  0.79,
  MAD:  10.0,
}

const SYMBOLS: Record<Currency, string> = {
  USD:  '$',
  EUR:  '€',
  FCFA: 'XOF',
  GHS:  'GH₵',
  GNF:  'GNF',
  CAD:  'CA$',
  GBP:  '£',
  MAD:  'MAD',
}

const LS_KEY = 'miad_currency'
const fetcher = (url: string) => fetch(url).then(r => r.json())

// Devise par pays détecté (IP) — un visiteur voyait toujours du $ par défaut
// tant qu'il n'avait jamais touché au sélecteur, même en arrivant du
// Sénégal ou du Ghana (demandé le 2026-08-17 : "les devis en fonction de la
// localisation du client"). Zone CFA (XOF + XAF) unifiée sous FCFA, comme le
// reste du site (voir CurrencyRates ci-dessus, une seule entrée FCFA).
const COUNTRY_TO_CURRENCY: Record<string, Currency> = {
  // Zone Franc CFA
  SN: 'FCFA', BJ: 'FCFA', BF: 'FCFA', CI: 'FCFA', GW: 'FCFA', ML: 'FCFA', NE: 'FCFA', TG: 'FCFA',
  CM: 'FCFA', CF: 'FCFA', TD: 'FCFA', CG: 'FCFA', GQ: 'FCFA', GA: 'FCFA',
  GH: 'GHS',
  GN: 'GNF',
  MA: 'MAD',
  CA: 'CAD',
  GB: 'GBP',
  // Zone euro
  FR: 'EUR', BE: 'EUR', DE: 'EUR', NL: 'EUR', IT: 'EUR', ES: 'EUR', PT: 'EUR',
  LU: 'EUR', AT: 'EUR', IE: 'EUR', FI: 'EUR', GR: 'EUR',
}

function currencyForCountry(countryCode: string): Currency {
  return COUNTRY_TO_CURRENCY[countryCode.toUpperCase()] || 'USD'
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null)

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<Currency>('USD')

  // Taux de change — /api/exchange-rates relaie shipping-svc GET
  // /exchange-rates, LA source unique déjà utilisée par payment-svc pour
  // convertir les prix au moment du paiement mobile money, rafraîchie
  // automatiquement chaque jour (voir shipping-svc/exchange-rates-refresh.go)
  // et modifiable manuellement dans le back-office (page Devises). Avant
  // le 2026-09-03, ce contexte lisait `/api/shipping-rates` → un champ
  // `currency_rates` qui n'existait dans AUCUNE réponse (ni le payload
  // réel, ni son fallback) : le sélecteur de devise du site tournait donc
  // en permanence sur FALLBACK_RATES codé en dur, jamais un vrai taux à
  // jour ni synchronisé avec ce qu'un client paie réellement.
  //
  // Le backend suit les devises par CODE ISO précis (XOF, XAF, GHS, CAD…)
  // alors que ce contexte fusionne toute la zone Franc CFA sous un seul
  // "FCFA" (voir COUNTRY_TO_CURRENCY plus haut) — XOF sert de taux
  // représentatif pour FCFA (Sénégal et la plupart des pays de la zone
  // sont en XOF ; l'écart avec XAF est historiquement nul, parité fixe
  // 1:1 entre les deux francs CFA). EUR/GNF/GBP/MAD ne sont pas suivies
  // côté paiement (PawaPay/PayDunya ne les utilisent pas) : elles gardent
  // leur taux codé en dur (FALLBACK_RATES), personne d'autre ne les alimente.
  const { data } = useSWR('/api/exchange-rates', fetcher, {
    fallbackData:      { rates: {} as Record<string, number> },
    revalidateOnFocus: false,
    dedupingInterval:  300_000, // 5 min
  })

  // Taux actifs : priorité aux valeurs backend (payment-svc/admin), sinon
  // fallback codé pour les devises non suivies côté paiement.
  const rates: CurrencyRates = useMemo(() => ({
    USD:  1,
    EUR:  FALLBACK_RATES.EUR,
    FCFA: data?.rates?.XOF ?? FALLBACK_RATES.FCFA,
    GHS:  data?.rates?.GHS ?? FALLBACK_RATES.GHS,
    GNF:  FALLBACK_RATES.GNF,
    CAD:  data?.rates?.CAD ?? FALLBACK_RATES.CAD,
    GBP:  FALLBACK_RATES.GBP,
    MAD:  FALLBACK_RATES.MAD,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [data?.rates?.XOF, data?.rates?.GHS, data?.rates?.CAD])

  useEffect(() => {
    const saved = localStorage.getItem(LS_KEY) as Currency | null
    if (saved && saved in FALLBACK_RATES) {
      setCurrencyState(saved)
      return
    }
    // Pas de préférence enregistrée : devise déduite du pays détecté par IP,
    // pas persistée en localStorage (sinon un premier passage depuis un
    // aéroport/VPN figerait la devise pour toujours — l'auto-détection doit
    // rester active tant que le client n'a jamais choisi lui-même).
    fetch('/api/detect-country')
      .then(r => r.json())
      .then(data => {
        if (data?.countryCode) setCurrencyState(currencyForCountry(data.countryCode))
      })
      .catch(() => {})
  }, [])

  const setCurrency = useCallback((c: Currency) => {
    setCurrencyState(c)
    localStorage.setItem(LS_KEY, c)
  }, [])

  const formatPrice = useCallback((usdAmount: number): string => {
    const rate = rates[currency] ?? 1
    const converted = usdAmount * rate

    if (currency === 'FCFA') return Math.round(converted).toLocaleString('fr-FR') + ' XOF'
    if (currency === 'GNF')  return Math.round(converted).toLocaleString('fr-FR') + ' GNF'
    if (currency === 'GHS')  return 'GH₵ ' + converted.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    if (currency === 'EUR')  return converted.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
    if (currency === 'CAD')  return 'CA$ ' + converted.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    if (currency === 'GBP')  return '£' + converted.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    if (currency === 'MAD')  return converted.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' MAD'
    // USD
    return converted.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' $'
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency, rates.EUR, rates.FCFA, rates.GHS, rates.GNF, rates.CAD, rates.GBP, rates.MAD])

  const value = useMemo(
    () => ({ currency, setCurrency, rates, formatPrice, symbol: SYMBOLS[currency] }),
    [currency, setCurrency, rates, formatPrice]
  )

  return (
    <CurrencyContext.Provider value={value}>
      {children}
    </CurrencyContext.Provider>
  )
}

export function useCurrency(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext)
  if (!ctx) throw new Error('useCurrency must be used inside CurrencyProvider')
  return ctx
}

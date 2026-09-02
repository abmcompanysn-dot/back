import useSWR from 'swr'

export interface ShippingRatesConfig {
  local:       number
  zone_africa: number
  // Seuil de sous-total à partir duquel la livraison est offerte (0 = jamais).
  // Vient de shipping-svc /shipping/config (avant : constante en dur
  // FREE_SHIPPING_THRESHOLD dans CheckoutPage).
  free_threshold?: number
  // Repli livraison nationale SN quand le calcul par distance échoue
  // (avant : SENEGAL_DOMESTIC_FALLBACK_USD en dur).
  domestic_fallback_usd?: number
  zones: Record<string, { standard: number; express: number }>
}

const FALLBACK: ShippingRatesConfig = {
  local:       3,
  zone_africa: 6,
  free_threshold: 150,
  domestic_fallback_usd: 8.33,
  zones: {
    AF: { standard: 12, express: 30 },
    EU: { standard: 25, express: 45 },
    NA: { standard: 25, express: 50 },
    SA: { standard: 25, express: 55 },
    AS: { standard: 25, express: 55 },
    OC: { standard: 30, express: 60 },
  },
}

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function useShippingRates() {
  const { data } = useSWR<ShippingRatesConfig>('/api/shipping-rates', fetcher, {
    fallbackData:       FALLBACK,
    revalidateOnFocus:  false,
    dedupingInterval:   300_000, // 5 min
  })
  return data ?? FALLBACK
}

/** Calcule le coût de livraison en utilisant les tarifs dynamiques */
export function calcShipping(
  productCountryCode: string,
  userCountryCode:    string,
  method:             'standard' | 'express',
  rates:              ShippingRatesConfig,
  COUNTRY_TO_ZONE:    Record<string, string>
): number {
  const pc = (productCountryCode || '').toLowerCase()
  const uc = (userCountryCode || '').toLowerCase()

  // Un produit sans pays vendeur renseigné (pc vide) ne doit jamais être
  // traité comme une correspondance "livraison locale" juste parce que les
  // deux chaînes vides sont égales — ça facturait 3 $ (tarif local) à des
  // clients internationaux (ex: Canada) au lieu du vrai tarif de zone.
  if (pc && pc === uc) return rates.local

  const pZone = pc ? COUNTRY_TO_ZONE[pc.toUpperCase()] : undefined
  const uZone = COUNTRY_TO_ZONE[uc.toUpperCase()]
  if (pZone === 'AF' && uZone === 'AF') return rates.zone_africa

  const zoneRates = rates.zones[uZone] ?? rates.zones['AF']
  return method === 'express' ? zoneRates.express : zoneRates.standard
}

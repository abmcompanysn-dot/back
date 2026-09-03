import { NextResponse } from 'next/server'
import { SHIPPING_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';
export const revalidate = 300 // ISR 5 min — mêmes réglages que /api/shipping-rates

// Taux de change — relais de shipping-svc GET /exchange-rates, LA source
// unique déjà utilisée par payment-svc pour convertir les prix USD en
// devise locale au moment du paiement (voir CLAUDE.md racine). Ajouté le
// 2026-09-03 : CurrencyContext.tsx (sélecteur de devise du site) lisait
// jusqu'ici un champ `currency_rates` qui n'existe dans AUCUNE réponse
// de /api/shipping-rates (ni le vrai payload shipping-svc, ni son
// fallback) — il tournait donc en permanence sur des taux codés en dur
// dans le frontend, jamais synchronisés avec les vrais taux (eux-mêmes
// rafraîchis chaque jour depuis 2026-09-03, voir shipping-svc/
// exchange-rates-refresh.go). Ce endpoint relie enfin les deux :
// l'affichage des prix sur le site utilise désormais la même vérité que
// le paiement mobile money.
//
// Format shipping-svc : { rates: [{currency, rate_per_usd, updated_at}] }
// Reformaté ici en objet plat { XOF: 566, CAD: 1.41, ... } — plus simple
// à consommer côté CurrencyContext (un objet, pas un tableau à parcourir).

const FALLBACK: Record<string, number> = {
  XOF: 600, XAF: 600, CAD: 1.41, GHS: 12.5, KES: 129, NGN: 1550,
  TZS: 2500, UGX: 3700, RWF: 1300, ZMW: 27, MWK: 1740, MZN: 64, CDF: 2850, SLE: 22.7,
}

export async function GET() {
  try {
    const res = await fetch(`${SHIPPING_SVC_URL}/exchange-rates`, {
      next: { revalidate: 300, tags: ['exchange-rates'] },
    })
    if (!res.ok) throw new Error(`shipping-svc returned ${res.status}`)
    const data = await res.json()
    const rates: Record<string, number> = { ...FALLBACK }
    for (const r of data?.rates || []) {
      if (r?.currency && typeof r?.rate_per_usd === 'number' && r.rate_per_usd > 0) {
        rates[r.currency] = r.rate_per_usd
      }
    }
    return NextResponse.json(
      { rates },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' } }
    )
  } catch {
    return NextResponse.json({ rates: FALLBACK })
  }
}

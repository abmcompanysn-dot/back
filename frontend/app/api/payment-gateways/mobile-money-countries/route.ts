import { NextResponse } from 'next/server'
import { PAYMENT_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// Relais de GET /pawapay/countries (payment-svc) — liste pays/opérateurs
// PawaPay avec authType par provider (ajouté le 2026-08-28, flux sans
// redirection). Nom de route volontairement agrégateur-agnostique
// (mobile-money-countries, pas pawapay-countries) : si un second
// agrégateur mobile money est ajouté un jour, cette route reste le seul
// point d'entrée que le frontend checkout connaît.
export async function GET() {
  try {
    const res = await fetch(`${PAYMENT_SVC_URL}/pawapay/countries`, {
      next: { revalidate: 3600 },
    })
    if (!res.ok) {
      return NextResponse.json({ countries: [], default_iso2: 'SN' }, { status: 200 })
    }
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ countries: [], default_iso2: 'SN' }, { status: 200 })
  }
}

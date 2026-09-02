import { NextRequest, NextResponse } from 'next/server'
import { PAYMENT_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// Relais de GET /payments/routing (payment-svc) — table de routage
// PawaPay ⇄ PayDunya par pays/opérateur, éditée en admin (PaymentRouting.tsx)
// mais jamais consultée jusqu'ici par le checkout réel : le formulaire
// mobile money basculait TOUT en bloc sur un seul agrégateur (le toggle
// global Configuration → Paiements), ignorant les choix par opérateur
// (ex. Wave réglé sur PayDunya, mais le client atterrissait quand même
// sur PawaPay). Bug remonté 2026-09-02 — ce relais permet à
// MobileMoneyDirectForm de lire le bon agrégateur opérateur par opérateur.
export async function GET(req: NextRequest) {
  try {
    const country = req.nextUrl.searchParams.get('country_iso2')
    const res = await fetch(`${PAYMENT_SVC_URL}/payments/routing`, {
      next: { revalidate: 300 },
    })
    if (!res.ok) {
      return NextResponse.json({ routes: [] }, { status: 200 })
    }
    const data = await res.json()
    const routes = country
      ? (data.routes || []).filter((r: any) => r.country_iso2 === country.toUpperCase())
      : data.routes || []
    return NextResponse.json({ routes })
  } catch {
    return NextResponse.json({ routes: [] }, { status: 200 })
  }
}

import { NextResponse } from 'next/server'
import { PAYMENT_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// Relais de GET /paydunya/softpay-providers — équivalent PayDunya de
// mobile-money-countries/route.ts (PawaPay). Nom de route distinct
// volontairement (pas encore fusionné en un seul point d'entrée générique
// agrégateur-agnostique) — MobileMoneyDirectForm.tsx interroge les deux
// et combine selon l'agrégateur actif.
export async function GET() {
  try {
    const res = await fetch(`${PAYMENT_SVC_URL}/paydunya/softpay-providers`, {
      next: { revalidate: 3600 },
    })
    if (!res.ok) {
      return NextResponse.json({ providers: [] }, { status: 200 })
    }
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ providers: [] }, { status: 200 })
  }
}

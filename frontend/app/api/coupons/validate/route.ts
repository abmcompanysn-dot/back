import { NextResponse } from 'next/server'
import { LOYALTY_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

// Migré depuis l'appel client direct à l'ancien wp-json/miad/v1/coupons/validate
// (lib/coins.ts, validateCouponAPI — jamais réellement appelée jusqu'ici,
// voir lib/coupons.ts qui utilise encore DEMO_COUPONS en dur pour le
// checkout réel). loyalty-svc a de vrais coupons en base (table coupons)
// mais un contrat différent de l'ancien WordPress : {code} en entrée (pas
// de subtotal côté serveur), {type, amount, valid} en sortie — le calcul
// de la réduction (et la vérification minPurchase) reste donc côté client.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { code } = body
  if (!code) return NextResponse.json({ error: 'code requis' }, { status: 400 })

  const res = await fetch(`${LOYALTY_SVC_URL}/coupons/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: (data as any)?.error?.message || 'Code invalide' }, { status: res.status })

  const amount = Number(data.amount) || 0
  const discount = data.type === 'percent' ? undefined : amount // pourcentage : calculé côté appelant sur le subtotal réel
  return NextResponse.json({
    valid: true, type: data.type, amount, discount,
    message: 'Code appliqué',
  })
}

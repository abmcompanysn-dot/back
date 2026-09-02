import { NextResponse } from 'next/server'
import { PAYMENT_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// reinit-payment — relais de POST /payments/init (payment-svc), appelé
// SANS mobile_money_provider (juste order_id) pour (re)créer la facture
// de paiement — même appel que POST /api/orders fait normalement à la
// création de commande. Nécessaire après switch-payment-provider
// (2026-09-02) : ce dernier vide provider_ref pour forcer une nouvelle
// facture, mais ne la recrée pas lui-même — sans ce rappel explicite,
// paydunyaSoftpayDepositHandler/initiateMobileMoneyDeposit échouaient en
// 404 "invoice_not_found" faute de facture existante (bug repéré via une
// vraie tentative de paiement Wave, commande #421, 2026-09-02).
export async function POST(request: Request) {
  try {
    const auth = request.headers.get('Authorization')
    if (!auth || !auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
    }
    const user = await fetchWpUser(auth.slice(7))
    if (!user?.sub) return NextResponse.json({ error: 'Session invalide' }, { status: 401 })

    const { order_id } = await request.json()
    if (!order_id) {
      return NextResponse.json({ error: 'order_id obligatoire' }, { status: 400 })
    }

    const res = await fetch(`${PAYMENT_SVC_URL}/payments/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: Number(order_id) }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return NextResponse.json({ error: data?.error?.message || 'Préparation du paiement impossible' }, { status: res.status })
    }

    return NextResponse.json({ success: true, payment: data?.payment })
  } catch (e: any) {
    console.error('[reinit-payment]', e.message)
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

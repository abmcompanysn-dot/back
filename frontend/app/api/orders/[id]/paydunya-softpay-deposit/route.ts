import { NextResponse } from 'next/server'
import { PAYMENT_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// paydunya-softpay-deposit — étape 2 du flux PayDunya SoftPay
// (2026-08-28). Suppose que POST /api/orders a déjà créé la commande
// avec payment_method='paydunya' (l'invoice PayDunya classique existe
// déjà, provider_ref en base côté payment-svc) — cette route relaie
// juste vers POST /payments/paydunya/softpay-deposit qui réutilise ce
// token, ne recrée jamais d'invoice.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const auth = request.headers.get('Authorization')
    if (!auth || !auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
    }
    const user = await fetchWpUser(auth.slice(7))
    if (!user?.sub) return NextResponse.json({ error: 'Session invalide' }, { status: 401 })

    const { provider, customerName, customerEmail, phone, otp } = await request.json()
    if (!provider || !phone) {
      return NextResponse.json({ error: 'provider et phone sont obligatoires' }, { status: 400 })
    }

    const res = await fetch(`${PAYMENT_SVC_URL}/payments/paydunya/softpay-deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: Number(params.id),
        provider,
        customer_name: customerName || user.name || 'Client MIAD',
        customer_email: customerEmail || user.email || '',
        phone,
        otp: otp || '',
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return NextResponse.json({ error: data?.error?.message || 'Paiement impossible' }, { status: res.status })
    }

    return NextResponse.json({
      success: true,
      redirectUrl: data?.redirect_url || undefined,
      wizallTxId: data?.wizall_tx_id || undefined,
    })
  } catch (e: any) {
    console.error('[paydunya-softpay-deposit]', e.message)
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

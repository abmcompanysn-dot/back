import { NextResponse } from 'next/server'
import { PAYMENT_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// switch-payment-provider — relais de POST /payments/order/{id}/switch-provider
// (payment-svc, 2026-09-02). Appelé par MobileMoneyDirectForm.tsx quand
// l'opérateur choisi par le client a un agrégateur effectif (routing par
// opérateur, écran admin PaymentRouting.tsx) différent de celui déjà
// engagé à la création de commande — sinon le dépôt réel (mobile-money-
// deposit / paydunya-softpay-deposit) agirait sur le mauvais provider.
//
// `id` = PARENT order id, même convention que mobile-money-deposit.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const auth = request.headers.get('Authorization')
    if (!auth || !auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
    }
    const user = await fetchWpUser(auth.slice(7))
    if (!user?.sub) return NextResponse.json({ error: 'Session invalide' }, { status: 401 })

    const { provider } = await request.json()
    if (provider !== 'pawapay' && provider !== 'paydunya') {
      return NextResponse.json({ error: 'provider doit être pawapay ou paydunya' }, { status: 400 })
    }

    const res = await fetch(`${PAYMENT_SVC_URL}/payments/order/${Number(params.id)}/switch-provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return NextResponse.json({ error: data?.error?.message || "Changement d'agrégateur impossible" }, { status: res.status })
    }

    return NextResponse.json({ success: true, provider: data?.provider })
  } catch (e: any) {
    console.error('[switch-payment-provider]', e.message)
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

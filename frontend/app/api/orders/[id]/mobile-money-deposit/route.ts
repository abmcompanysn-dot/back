import { NextResponse } from 'next/server'
import { PAYMENT_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// mobile-money-deposit — déclenche le paiement mobile money SANS
// redirection (2026-08-28) : le client a déjà choisi son opérateur +
// saisi son numéro sur MobileMoneyDirectForm.tsx (checkout), cette route
// relaie vers payment-svc (POST /payments/init avec mobile_money_provider)
// qui route en interne vers un dépôt direct ou une Payment Page selon
// l'authType de l'opérateur — voir initiateMobileMoneyDeposit côté Go.
//
// `id` = PARENT order id (commande déjà créée par POST /api/orders,
// payment_method='pawapay' — le paiement 'initiated' existe déjà en
// base, ce endpoint le fait juste réellement démarrer côté agrégateur).
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const auth = request.headers.get('Authorization')
    if (!auth || !auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
    }
    const user = await fetchWpUser(auth.slice(7))
    if (!user?.sub) return NextResponse.json({ error: 'Session invalide' }, { status: 401 })

    const { provider, phone, country } = await request.json()
    if (!provider || !phone || !country) {
      return NextResponse.json({ error: 'provider, phone et country sont obligatoires' }, { status: 400 })
    }

    const res = await fetch(`${PAYMENT_SVC_URL}/payments/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: Number(params.id),
        buyer_country: country,
        buyer_phone: phone,
        mobile_money_provider: provider,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return NextResponse.json({ error: data?.error?.message || 'Paiement impossible' }, { status: res.status })
    }

    return NextResponse.json({
      success: true,
      redirectUrl: data?.redirect_url || undefined, // présent seulement si l'opérateur exige REDIRECT_AUTH
      depositId: data?.payment?.provider_ref,
    })
  } catch (e: any) {
    console.error('[mobile-money-deposit]', e.message)
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

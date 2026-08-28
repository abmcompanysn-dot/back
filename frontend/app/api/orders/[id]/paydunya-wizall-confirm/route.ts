import { NextResponse } from 'next/server'
import { PAYMENT_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// paydunya-wizall-confirm — étape 3 spécifique à Wizall (le seul
// opérateur SoftPay à 3 étapes, 2026-08-28) : OTP reçu par SMS après
// paydunya-softpay-deposit, à soumettre ici pour finaliser le paiement.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const auth = request.headers.get('Authorization')
    if (!auth || !auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
    }
    const user = await fetchWpUser(auth.slice(7))
    if (!user?.sub) return NextResponse.json({ error: 'Session invalide' }, { status: 401 })

    const { phone, transactionId, authCode } = await request.json()
    if (!transactionId || !authCode) {
      return NextResponse.json({ error: 'transactionId et authCode sont obligatoires' }, { status: 400 })
    }

    const res = await fetch(`${PAYMENT_SVC_URL}/payments/paydunya/wizall-confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, transaction_id: transactionId, auth_code: authCode }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return NextResponse.json({ error: data?.error?.message || 'Confirmation impossible' }, { status: res.status })
    }
    return NextResponse.json({ success: data?.success === true, message: data?.message })
  } catch (e: any) {
    console.error('[paydunya-wizall-confirm]', e.message)
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

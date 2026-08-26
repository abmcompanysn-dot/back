import { NextResponse } from 'next/server'
import { PAYMENT_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// GET /api/vendor/wallet — solde + historique du vendeur connecté.
// POST /api/vendor/wallet — demande de retrait (payout_request).
// vendor_id toujours résolu depuis le JWT, jamais depuis le body (même
// pattern que /api/vendor/products — voir la faille corrigée le 2026-08-26
// sur /api/products).
async function authenticate(request: Request) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return null
  const user = await fetchWpUser(auth.slice(7))
  if (!user?.vendor_id) return null
  return user
}

export async function GET(request: Request) {
  const user = await authenticate(request)
  if (!user) return NextResponse.json({ error: 'Accès réservé aux vendeurs' }, { status: 403 })

  const [walletRes, txRes, payoutsRes] = await Promise.all([
    fetch(`${PAYMENT_SVC_URL}/wallet/${user.vendor_id}`, { cache: 'no-store' }),
    fetch(`${PAYMENT_SVC_URL}/wallet/${user.vendor_id}/transactions`, { cache: 'no-store' }),
    fetch(`${PAYMENT_SVC_URL}/payout-requests?vendor_id=${user.vendor_id}`, { cache: 'no-store' }),
  ])

  const wallet = walletRes.ok ? await walletRes.json() : { balance_usd: 0 }
  const transactions = txRes.ok ? await txRes.json() : { items: [] }
  const payouts = payoutsRes.ok ? await payoutsRes.json() : { items: [] }

  return NextResponse.json({
    balance_usd: wallet.balance_usd || 0,
    transactions: transactions.items || [],
    payout_requests: payouts.items || [],
  })
}

export async function POST(request: Request) {
  const user = await authenticate(request)
  if (!user) return NextResponse.json({ error: 'Accès réservé aux vendeurs' }, { status: 403 })

  const body = await request.json().catch(() => null)
  const amount = Number(body?.amount_usd)
  const method = String(body?.method || '')
  if (!amount || amount <= 0 || !method) {
    return NextResponse.json({ error: 'amount_usd (>0) et method requis' }, { status: 400 })
  }

  const res = await fetch(`${PAYMENT_SVC_URL}/payout-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vendor_id: user.vendor_id, amount_usd: amount, method }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    return NextResponse.json({ error: data?.error?.message || 'Erreur payment-svc' }, { status: res.status })
  }
  return NextResponse.json(data, { status: 201 })
}

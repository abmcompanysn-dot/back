import { NextResponse } from 'next/server'

export const runtime = 'edge';

const WOO_URL         = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')
const WOO_KEY         = process.env.WOO_CONSUMER_KEY
const WOO_SECRET      = process.env.WOO_CONSUMER_SECRET
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    if (!INTERNAL_SECRET) {
      console.error('[confirm-stripe] INTERNAL_API_SECRET manquant')
      return NextResponse.json({ error: 'Configuration serveur incomplète' }, { status: 500 })
    }

    const orderId = params.id
    if (!orderId) return NextResponse.json({ error: 'Order ID manquant' }, { status: 400 })

    const body = await req.json().catch(() => ({}))
    const { payment_intent_id } = body
    if (!payment_intent_id) {
      return NextResponse.json({ error: 'payment_intent_id requis' }, { status: 400 })
    }

    // Déléguer la vérification Stripe + mise à jour WC à WordPress,
    // qui dispose déjà de la clé secrète Stripe côté serveur.
    const wpRes = await fetch(`${WOO_URL}/wp-json/miad/v1/confirm-stripe-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Headless-Secret': INTERNAL_SECRET,
        'User-Agent': 'MIAD-Headless-Client',
      },
      body: JSON.stringify({ payment_intent_id, order_id: Number(orderId) }),
    })

    const data = await wpRes.json().catch(() => ({}))

    if (!wpRes.ok) {
      console.error(`[confirm-stripe] WP error ${wpRes.status}:`, data)
      return NextResponse.json(
        { error: data?.message || 'Erreur de confirmation du paiement' },
        { status: wpRes.status >= 500 ? 502 : wpRes.status }
      )
    }

    // Récupère le total + les articles pour que /order-received affiche les
    // mêmes détails de commande que pour un paiement PayDunya (même format
    // de réponse, indépendamment du mode de paiement utilisé).
    let total: string | null = null
    let items: Array<{ productId: number; name: string; quantity: number; image: string }> = []
    if (WOO_KEY && WOO_SECRET) {
      try {
        const orderRes = await fetch(
          `${WOO_URL}/wp-json/wc/v3/orders/${orderId}?consumer_key=${WOO_KEY}&consumer_secret=${WOO_SECRET}`,
          { headers: { 'User-Agent': 'MIAD-Headless-Client' }, cache: 'no-store' }
        )
        if (orderRes.ok) {
          const order = await orderRes.json().catch(() => null)
          if (order) {
            total = order.total ?? null
            items = (order.line_items || []).map((li: any) => ({
              productId: li.product_id,
              name: li.name,
              quantity: li.quantity,
              image: li.image?.src || '',
            }))
          }
        }
      } catch {
        // Non-bloquant : la confirmation du paiement a déjà réussi ci-dessus,
        // ces détails ne font qu'enrichir l'affichage.
      }
    }

    return NextResponse.json({ success: true, status: 'completed', orderId, total, items })
  } catch (e: any) {
    console.error('[confirm-stripe]', e.message)
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

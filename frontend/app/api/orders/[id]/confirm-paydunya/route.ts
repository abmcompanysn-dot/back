import { NextResponse } from 'next/server'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')
const WOO_KEY = process.env.WOO_CONSUMER_KEY
const WOO_SECRET = process.env.WOO_CONSUMER_SECRET
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET

const PAID_STATUSES = ['processing', 'completed']
const WAITING_STATUSES = ['pending', 'on-hold']

/**
 * Confirme le paiement PayDunya en relisant directement le statut de la commande
 * WooCommerce, déjà mis à jour de façon fiable par le webhook serveur-à-serveur
 * PayDunya (IPN). On n'appelle plus l'API PayDunya nous-mêmes depuis ici : un
 * pare-feu WordPress bloque l'en-tête interne nécessaire pour ce second appel,
 * alors que le statut de la commande, lui, est déjà la source de vérité fiable.
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    if (!WOO_KEY || !WOO_SECRET) {
      console.error('[confirm-paydunya] Clés WooCommerce manquantes côté serveur')
      return NextResponse.json({ error: 'Configuration serveur incomplète' }, { status: 500 })
    }

    const orderId = params.id

    const headers: Record<string, string> = { 'User-Agent': 'MIAD-Headless-Client' }
    if (INTERNAL_SECRET) headers['X-Headless-Secret'] = INTERNAL_SECRET

    const orderRes = await fetch(
      `${WOO_URL}/wp-json/wc/v3/orders/${orderId}?consumer_key=${WOO_KEY}&consumer_secret=${WOO_SECRET}`,
      { headers, cache: 'no-store' }
    )

    if (!orderRes.ok) {
      return NextResponse.json({ success: false, status: 'failed', orderId }, { status: 200 })
    }

    const order = await orderRes.json().catch(() => null)
    if (!order?.status) {
      return NextResponse.json({ success: false, status: 'failed', orderId }, { status: 200 })
    }

    if (PAID_STATUSES.includes(order.status) || order.date_paid) {
      const items = (order.line_items || []).map((li: any) => ({
        productId: li.product_id,
        name: li.name,
        quantity: li.quantity,
        image: li.image?.src || '',
      }))
      return NextResponse.json({ success: true, status: 'completed', orderId, total: order.total, items })
    }

    if (WAITING_STATUSES.includes(order.status)) {
      return NextResponse.json({ success: false, status: 'pending', orderId })
    }

    return NextResponse.json({ success: false, status: 'failed', orderId })
  } catch (e: any) {
    console.error('[confirm-paydunya]', e.message)
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

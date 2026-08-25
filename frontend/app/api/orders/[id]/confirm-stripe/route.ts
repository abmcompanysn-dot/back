import { NextResponse } from 'next/server'
import { ORDER_SVC_URL, CATALOG_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

const PAID_STATUSES = ['paid', 'processing', 'shipped', 'delivered']

// order-svc ne stocke pas d'image produit sur la ligne de commande (juste
// product_id/name/quantity/price) — on enrichit avec catalog-svc, même
// logique que /api/orders/[id]/items.
async function enrichLineItemImages(lineItems: any[]): Promise<Array<{ productId: number; name: string; quantity: number; image: string }>> {
  const productIds = [...new Set(lineItems.map((li: any) => li.product_id).filter(Boolean))]
  const imagesByProduct: Record<string, string> = {}
  if (productIds.length) {
    try {
      const res = await fetch(`${CATALOG_SVC_URL}/products?include=${productIds.join(',')}`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        for (const p of data.items || []) imagesByProduct[String(p.id)] = p.images?.[0]?.src || ''
      }
    } catch {
      // Non-bloquant.
    }
  }
  return lineItems.map((li: any) => ({
    productId: li.product_id,
    name: li.name,
    quantity: li.quantity,
    image: imagesByProduct[String(li.product_id)] || '',
  }))
}

/**
 * Confirme le paiement Stripe en relisant le statut agrégé de la commande
 * (order-svc) — même logique que confirm-paydunya. payment-svc vérifie déjà
 * la signature Stripe côté serveur sur son propre webhook
 * (POST payments/webhook/stripe → confirmPayment → order-svc/orders/{id}/confirm),
 * donc il n'y a plus besoin ici d'un aller-retour applicatif WordPress avec
 * la clé secrète Stripe : on relit simplement l'état déjà mis à jour.
 *
 * Limite connue : si le navigateur revient sur /order-received juste après
 * la vérification 3D Secure mais AVANT que le webhook Stripe n'ait atteint
 * payment-svc, ce endpoint renverra encore "pending" — c'est le comportement
 * attendu (webhook = source de vérité), le frontend affiche déjà un état
 * "en attente" dans ce cas (voir app/order-received/page.tsx).
 *
 * `id` ici est le PARENT order id (commande groupée), voir confirm-paydunya
 * pour le détail du modèle parent/sous-commandes.
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const orderId = params.id
    if (!orderId) return NextResponse.json({ error: 'Order ID manquant' }, { status: 400 })

    const body = await req.json().catch(() => ({}))
    const { payment_intent_id } = body
    if (!payment_intent_id) {
      return NextResponse.json({ error: 'payment_intent_id requis' }, { status: 400 })
    }

    const orderRes = await fetch(`${ORDER_SVC_URL}/orders/parent/${orderId}`, { cache: 'no-store' })

    if (!orderRes.ok) {
      return NextResponse.json({ success: false, status: 'failed', orderId }, { status: 200 })
    }

    const order = await orderRes.json().catch(() => null)
    if (!order?.status) {
      return NextResponse.json({ success: false, status: 'failed', orderId }, { status: 200 })
    }

    if (PAID_STATUSES.includes(order.status)) {
      const items = await enrichLineItemImages(order.line_items || [])
      return NextResponse.json({ success: true, status: 'completed', orderId, total: order.total, items })
    }

    if (order.status === 'pending_payment' || order.status === 'partially_paid') {
      return NextResponse.json({ success: false, status: 'pending', orderId })
    }

    return NextResponse.json({ success: false, status: 'failed', orderId })
  } catch (e: any) {
    console.error('[confirm-stripe]', e.message)
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

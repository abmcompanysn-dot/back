import { NextResponse } from 'next/server'
import { ORDER_SVC_URL, CATALOG_SVC_URL, PAYMENT_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

const PAID_STATUSES = ['paid', 'processing', 'shipped', 'delivered']
const WAITING_STATUSES = ['pending_payment']

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
 * Confirme le paiement PayDunya en relisant directement le statut agrégé de
 * la commande (order-svc), déjà mis à jour de façon fiable par le webhook
 * serveur-à-serveur PayDunya (paydunyaCallback → payment-svc.confirmPayment
 * → POST order-svc/orders/{sub_order_id}/confirm, voir services/payment-svc
 * et services/order-svc/main.go). On n'appelle plus PayDunya nous-mêmes
 * depuis ici : le statut de la commande est déjà la source de vérité
 * fiable — même logique que sous WooCommerce, juste une autre source.
 *
 * `id` ici est le PARENT order id (commande groupée multi-vendeur créée au
 * checkout) — order-svc expose sa vue agrégée sur GET /orders/parent/{id}
 * (statut "paid" seulement si TOUTES les sous-commandes sont payées,
 * "partially_paid"/"mixed" sinon, voir aggregateStatus côté order-svc).
 */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const orderId = params.id

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

    if (WAITING_STATUSES.includes(order.status) || order.status === 'partially_paid') {
      return NextResponse.json({ success: false, status: 'pending', orderId })
    }

    // Paiement échoué — relit payments.failure_code (payment-svc) pour que
    // MobileMoneyDirectForm.tsx affiche un message précis plutôt qu'un
    // "échec" générique, même logique que confirm-pawapay. PayDunya ne
    // fournit pas de code structuré comme PawaPay (voir paydunyaCallback,
    // failure_code y stocke le status brut PayDunya, ex. "cancelled") —
    // FAILURE_MESSAGES côté frontend retombe sur son message générique
    // pour tout code qu'il ne reconnaît pas explicitement.
    let failureCode: string | undefined
    try {
      const payRes = await fetch(`${PAYMENT_SVC_URL}/payments/order/${orderId}`, { cache: 'no-store' })
      if (payRes.ok) {
        const pay = await payRes.json()
        failureCode = pay?.failure_code || undefined
      }
    } catch {
      // Non-bloquant — le client voit quand même l'échec, juste sans détail.
    }

    return NextResponse.json({ success: false, status: 'failed', orderId, failureCode })
  } catch (e: any) {
    console.error('[confirm-paydunya]', e.message)
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

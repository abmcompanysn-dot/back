import { NextResponse } from 'next/server'
import { ORDER_SVC_URL, CATALOG_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

/**
 * Liste légère des articles d'une commande (nom, image, quantité) — utilisée par
 * les pages de confirmation (/success, /order-received) pour afficher ce qui a
 * été acheté, sans exposer les données sensibles (adresse, total payé, etc.).
 *
 * `id` ici est le PARENT order id (commande groupée multi-vendeur créée au
 * checkout, voir services/order-svc getParentOrder) — c'est ce que le
 * frontend passe dans l'URL après paiement (order_id du checkout). Le
 * modèle parent/sous-commandes est documenté dans confirm-paydunya/route.ts.
 *
 * order-svc ne stocke pas d'image produit sur la ligne de commande (juste
 * product_id/name/quantity/price) — on enrichit donc avec un second appel
 * catalog-svc pour récupérer les miniatures, comme le faisait auparavant
 * `line_items[].image.src` côté WooCommerce.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const orderId = params.id

    const orderRes = await fetch(`${ORDER_SVC_URL}/orders/parent/${orderId}`, { cache: 'no-store' })
    if (!orderRes.ok) return NextResponse.json({ items: [] }, { status: 200 })

    const order = await orderRes.json().catch(() => null)
    const lines: any[] = Array.isArray(order?.line_items) ? order.line_items : []
    if (!lines.length) return NextResponse.json({ items: [] })

    const productIds = [...new Set(lines.map((l: any) => l.product_id).filter(Boolean))]
    const imagesByProduct: Record<string, string> = {}
    if (productIds.length) {
      try {
        const prodRes = await fetch(`${CATALOG_SVC_URL}/products?include=${productIds.join(',')}`, { cache: 'no-store' })
        if (prodRes.ok) {
          const data = await prodRes.json()
          for (const p of data.items || []) {
            imagesByProduct[String(p.id)] = p.images?.[0]?.src || ''
          }
        }
      } catch {
        // Non-bloquant : afficher les articles sans image plutôt que rien.
      }
    }

    const items = lines.map((l: any) => ({
      productId: l.product_id,
      name: l.name,
      quantity: l.quantity,
      image: imagesByProduct[String(l.product_id)] || '',
    }))

    return NextResponse.json({ items })
  } catch {
    return NextResponse.json({ items: [] }, { status: 200 })
  }
}

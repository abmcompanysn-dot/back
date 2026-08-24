import { NextResponse } from 'next/server'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')
const WOO_KEY = process.env.WOO_CONSUMER_KEY
const WOO_SECRET = process.env.WOO_CONSUMER_SECRET
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET

/**
 * Liste légère des articles d'une commande (nom, image, quantité) — utilisée par
 * les pages de confirmation (/success, /order-received) pour afficher ce qui a
 * été acheté, sans exposer les données sensibles (adresse, total payé, etc.).
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    if (!WOO_KEY || !WOO_SECRET) {
      return NextResponse.json({ items: [] }, { status: 200 })
    }

    const orderId = params.id
    const headers: Record<string, string> = { 'User-Agent': 'MIAD-Headless-Client' }
    if (INTERNAL_SECRET) headers['X-Headless-Secret'] = INTERNAL_SECRET

    const orderRes = await fetch(
      `${WOO_URL}/wp-json/wc/v3/orders/${orderId}?consumer_key=${WOO_KEY}&consumer_secret=${WOO_SECRET}`,
      { headers, cache: 'no-store' }
    )

    if (!orderRes.ok) return NextResponse.json({ items: [] }, { status: 200 })

    const order = await orderRes.json().catch(() => null)
    const items = (order?.line_items || []).map((li: any) => ({
      productId: li.product_id,
      name: li.name,
      quantity: li.quantity,
      image: li.image?.src || '',
    }))

    return NextResponse.json({ items })
  } catch {
    return NextResponse.json({ items: [] }, { status: 200 })
  }
}

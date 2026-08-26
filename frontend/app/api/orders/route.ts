import { NextResponse } from 'next/server'
import { ORDER_SVC_URL, PAYMENT_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

export async function GET(request: Request) {
  try {
    const auth = request.headers.get('Authorization')
    if (!auth || !auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
    }

    const user = await fetchWpUser(auth.slice(7))
    if (!user?.sub) {
      return NextResponse.json({ error: 'Session invalide' }, { status: 401 })
    }

    const res = await fetch(`${ORDER_SVC_URL}/orders?customer_id=${user.sub}&page_size=50`, {
      cache: 'no-store',
    })
    if (!res.ok) {
      return NextResponse.json({ error: 'Erreur backend', status: res.status }, { status: res.status })
    }
    const data = await res.json()
    return NextResponse.json({ orders: data.items || [] })
  } catch {
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

/**
 * Checkout en une requête : crée la commande groupée (order-svc éclate par
 * vendeur) puis initie le paiement (payment-svc). Chaque ligne du panier
 * doit porter vendor_id et unit_price_usd (le prix affiché au client) —
 * order-svc ne recalcule pas les prix, il fait confiance à ce qui est
 * envoyé (source de vérité : catalog-svc au moment où le panier a été
 * constitué côté client).
 */
export async function POST(request: Request) {
  try {
    const auth = request.headers.get('Authorization')
    if (!auth || !auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
    }

    const user = await fetchWpUser(auth.slice(7))
    if (!user?.sub) return NextResponse.json({ error: 'Session invalide' }, { status: 401 })

    const body = await request.json()
    const { lines, shipping, billing, coupon_code, payment_method } = body

    if (!Array.isArray(lines) || lines.length === 0) {
      return NextResponse.json({ error: 'Le panier est vide' }, { status: 400 })
    }
    if (payment_method !== 'stripe' && payment_method !== 'paydunya') {
      return NextResponse.json({ error: 'payment_method doit être stripe ou paydunya' }, { status: 400 })
    }

    const orderRes = await fetch(`${ORDER_SVC_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: user.sub,
        lines,
        shipping_address: shipping,
        billing_address: billing,
        coupon_code: coupon_code || '',
        payment_method,
      }),
    })

    if (!orderRes.ok) {
      const errData = await orderRes.json().catch(() => ({ error: { message: 'Erreur inconnue' } }))
      return NextResponse.json({ error: errData?.error?.message || 'Erreur lors de la création de la commande' }, { status: 400 })
    }

    const order = await orderRes.json()
    const parentOrderId = order.parent_order_id
    const vendorOrders: Array<{ id: number }> = order.vendor_orders || []

    if (!parentOrderId || vendorOrders.length === 0) {
      return NextResponse.json({ error: 'Réponse de création de commande invalide' }, { status: 502 })
    }

    // Une sous-commande par vendeur, chacune avec son propre paiement
    // (payment-svc précrée l'enregistrement en consommant order.created —
    // léger délai possible, d'où le retry court avant d'abandonner).
    const payments = await Promise.all(
      vendorOrders.map(async (vo) => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const res = await fetch(`${PAYMENT_SVC_URL}/payments/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_id: vo.id }),
          })
          if (res.ok) return { order_id: vo.id, ...(await res.json()) }
          if (attempt < 4) await new Promise((r) => setTimeout(r, 400))
        }
        return { order_id: vo.id, error: 'Paiement non initialisé' }
      })
    )

    return NextResponse.json({
      success: true,
      parentOrderId,
      orderId: vendorOrders[0]?.id,
      payments,
      // Compat immédiate pour le flux mono-vendeur (le cas le plus fréquent) :
      clientSecret: payments[0]?.client_secret,
      redirectUrl: payments[0]?.redirect_url,
      // CheckoutPage.tsx (paiement PayDunya) lit ces deux noms précis, pas
      // clientSecret/redirectUrl ci-dessus — décalage jamais remarqué avant
      // car PayDunya était cassé côté backend (payment_svc renvoyait
      // toujours une erreur avant d'atteindre ce point). paydunyaToken =
      // provider_ref (le token de facture PayDunya, pas client_secret qui
      // est un concept Stripe), paydunyaUrl = redirect_url.
      paydunyaToken: payments[0]?.payment?.provider_ref,
      paydunyaUrl: payments[0]?.redirect_url,
    })
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Erreur lors de l'initialisation du processus de paiement" },
      { status: 500 }
    )
  }
}

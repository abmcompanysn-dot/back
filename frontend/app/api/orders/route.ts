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
    // order-svc renvoie le format Go (total_usd, created_at) ; le
    // ClientDashboard attend le format WooCommerce (total, date_created,
    // line_items). Sans ce mapping : "NaN XOF" (Number(order.total) sur un
    // champ absent) et "Invalid Date" (new Date(order.date_created)) —
    // constaté le 2026-08-28 sur la page Mon compte. On mappe ici plutôt
    // que de patcher chaque accès du dashboard.
    const mapped = (data.items || []).map((o: any) => ({
      ...o,
      total: o.total_usd ?? o.total ?? 0,
      date_created: o.created_at ?? o.date_created ?? null,
      date_modified: o.updated_at ?? o.created_at ?? o.date_modified ?? null,
      line_items: o.line_items ?? [],
    }))

    // Regroupement par commande PARENT : order-svc listOrders filtre
    // customer_id sur vendor_id>0, donc renvoie une ligne par SOUS-commande
    // vendeur. Le client voyait "Commande #123" ET "Commande #124" pour un
    // même achat multi-boutiques (signalé le 2026-09-01). On agrège ici :
    // une entrée par parent_order_id, total sommé, statut du groupe
    // ("mixed" si les sous-commandes divergent), et l'id AFFICHÉ devient
    // celui du parent (le détail — /api/orders/[id] — n'accepte que lui).
    const byParent = new Map<number, any>()
    for (const o of mapped) {
      const pid = o.parent_order_id || o.id
      const g = byParent.get(pid)
      if (!g) {
        byParent.set(pid, {
          ...o,
          id: pid,
          parent_order_id: pid,
          total: Number(o.total) || 0,
          _statuses: new Set([o.status]),
          _vendorCount: 1,
        })
      } else {
        g.total += Number(o.total) || 0
        g._statuses.add(o.status)
        g._vendorCount += 1
        // garder la date la plus ancienne (création du panier)
        if (o.date_created && (!g.date_created || o.date_created < g.date_created)) g.date_created = o.date_created
      }
    }
    const orders = Array.from(byParent.values())
      .map(({ _statuses, _vendorCount, ...g }: any) => ({
        ...g,
        status: _statuses.size === 1 ? [..._statuses][0] : 'mixed',
        vendor_count: _vendorCount,
      }))
      .sort((a: any, b: any) => (b.id ?? 0) - (a.id ?? 0))

    return NextResponse.json({ orders })
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
    // mobile_money_provider — opérateur choisi directement sur notre
    // checkout (flux sans redirection, 2026-08-28) ; absent = comportement
    // historique (Payment Page hébergée PawaPay).
    const { lines, shipping, billing, coupon_code, payment_method, mobile_money_provider } = body

    if (!Array.isArray(lines) || lines.length === 0) {
      return NextResponse.json({ error: 'Le panier est vide' }, { status: 400 })
    }
    if (payment_method !== 'stripe' && payment_method !== 'paydunya' && payment_method !== 'pawapay') {
      return NextResponse.json({ error: 'payment_method doit être stripe, paydunya ou pawapay' }, { status: 400 })
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

    // UN SEUL paiement pour toute la commande groupée, peu importe le
    // nombre de boutiques dedans (changé le 2026-08-26 : avant, une
    // facture Stripe/PayDunya PAR sous-commande vendeur — le client ne
    // payait jamais que la première, les autres restaient orphelines en
    // pending_payment indéfiniment ; payment-svc route maintenant lui-même
    // vers /orders/parent/{id}/confirm à la confirmation pour créditer
    // chaque vendeur séparément). payments.order_id est désormais indexé
    // sur parentOrderId, donc l'appel se fait directement avec lui — plus
    // besoin d'itérer sur vendorOrders ici.
    // PawaPay : payment-svc a besoin du pays de l'acheteur (devise + URL de
    // retour) et, en valeur par défaut facultative, de son téléphone —
    // repris de l'adresse de livraison déjà saisie au checkout. Ignorés
    // pour Stripe/PayDunya.
    const initBody: Record<string, unknown> = { order_id: parentOrderId }
    if (payment_method === 'pawapay') {
      initBody.buyer_country = shipping?.country || billing?.country || ''
      initBody.buyer_phone = shipping?.phone || billing?.phone || ''
      initBody.buyer_email = billing?.email || ''
      // mobile_money_provider — présent seulement si le client a choisi son
      // opérateur directement sur notre checkout (flux sans redirection,
      // 2026-08-28). Absent = comportement historique (Payment Page).
      if (mobile_money_provider) initBody.mobile_money_provider = mobile_money_provider
    }

    let payment: any = null
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`${PAYMENT_SVC_URL}/payments/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initBody),
      })
      if (res.ok) {
        payment = await res.json()
        break
      }
      if (attempt < 4) await new Promise((r) => setTimeout(r, 400))
    }

    return NextResponse.json({
      success: true,
      parentOrderId,
      orderId: parentOrderId,
      payment,
      clientSecret: payment?.client_secret,
      redirectUrl: payment?.redirect_url,
      // CheckoutPage.tsx (paiement PayDunya) lit ces deux noms précis, pas
      // clientSecret/redirectUrl ci-dessus. paydunyaToken = provider_ref
      // (le token de facture PayDunya, pas client_secret qui est un
      // concept Stripe), paydunyaUrl = redirect_url.
      paydunyaToken: payment?.payment?.provider_ref,
      paydunyaUrl: payment?.redirect_url,
      // PawaPay : page de paiement hébergée — on redirige simplement le
      // navigateur vers cette URL (PawaPay y collecte l'opérateur + le
      // numéro mobile money du client et déclenche le push USSD). Vide
      // dans le flux SANS redirection (mobile_money_provider fourni,
      // authType PROVIDER_AUTH/PREAUTH) — dans ce cas le frontend passe
      // en polling sur pawapayDepositId via GET /api/orders/{id}/payment-status.
      pawapayUrl: payment_method === 'pawapay' ? payment?.redirect_url : undefined,
      pawapayDepositId: payment_method === 'pawapay' ? payment?.payment?.provider_ref : undefined,
    })
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Erreur lors de l'initialisation du processus de paiement" },
      { status: 500 }
    )
  }
}

import { NextResponse } from 'next/server';
import { WOO_URL, INTERNAL_SECRET, fetchWpUser, wpHeaders } from '@/lib/miad-server-auth';

export const runtime = 'edge';

const WOO_KEY = process.env.WOO_CONSUMER_KEY;
const WOO_SECRET = process.env.WOO_CONSUMER_SECRET;

// PayDunya n'accepte que des montants en XOF (FCFA) → conversion depuis la devise du store
const FX: Record<string, number> = { USD: 600, EUR: 655, CAD: 445, GBP: 780, GHS: 48 }

export async function GET(request: Request) {
  try {
    const auth = request.headers.get('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
    }

    const token = auth.slice(7);

    // Validate session — miad_ tokens use X-Miad-Session (bypasses JWT Auth plugin)
    const wpUser = await fetchWpUser(token);
    if (!wpUser?.id) {
      return NextResponse.json({ error: 'Session invalide' }, { status: 401 });
    }

    const user = { id: wpUser.id as number };

    // 2. Récupérer les commandes réelles de ce client sur WooCommerce
    const apiUrl = `${WOO_URL}/wp-json/wc/v3/orders?customer=${user.id}&per_page=50&consumer_key=${WOO_KEY}&consumer_secret=${WOO_SECRET}`;
    const ordersRes = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'MIAD-Headless-Client',
        'X-Headless-Secret': INTERNAL_SECRET,
        'Accept': 'application/json',
      }
    });
    
    if (!ordersRes.ok) {
      return NextResponse.json({ error: "Erreur WooCommerce", status: ordersRes.status }, { status: ordersRes.status });
    }

    const ordersText = await ordersRes.text();
    let orders: any[];
    try {
      orders = JSON.parse(ordersText);
    } catch (e) {
      return NextResponse.json({ error: "Format de réponse invalide", details: "HTML reçu au lieu de JSON" }, { status: 502 });
    }

    return NextResponse.json({ orders: Array.isArray(orders) ? orders : [] });

  } catch (error: any) {
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = request.headers.get('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
    }

    // 1. Valider la session WordPress pour identifier le client
    const postToken = auth.slice(7)
    const user = await fetchWpUser(postToken)
    if (!user?.id) return NextResponse.json({ error: 'Session invalide' }, { status: 401 });

    const body = await request.json();
    const {
      line_items,
      shipping,
      billing,
      customer_note,
      orderId,
      amount,
      shipping_total,
      currency,
      payment_method,
      shipping_method_id,
      savePaymentMethod,
      paymentMethodId
    } = body;

    let finalOrderId = orderId;
    let finalAmount = amount;
    let finalCurrency = currency || 'usd';
    let order: any = null; // Initialisation pour éviter ReferenceError

    // 2. Création de la commande WooCommerce si elle n'existe pas encore (mode checkout direct)
    if (!finalOrderId && line_items) {
      let orderShipping = shipping;
      let orderBilling = billing;

      // Si les infos de livraison sont manquantes dans la requête, on les récupère du profil WC (Auto-remplissage)
      if (!orderShipping || !orderBilling) {
        const customerRes = await fetch(`${WOO_URL}/wp-json/wc/v3/customers/${user.id}?consumer_key=${WOO_KEY}&consumer_secret=${WOO_SECRET}`, {
            headers: { 'X-Headless-Secret': INTERNAL_SECRET, 'User-Agent': 'MIAD-Headless-Client' }
        });
        if (customerRes.ok) {
          const customerText = await customerRes.text();
          let customerData: any;
          try {
            customerData = JSON.parse(customerText);
          } catch (e) {
            customerData = null;
          }
          orderShipping = orderShipping || customerData.shipping;
          orderBilling = orderBilling || customerData.billing;
        }
      }

      const orderRes = await fetch(`${WOO_URL}/wp-json/wc/v3/orders?consumer_key=${WOO_KEY}&consumer_secret=${WOO_SECRET}`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Headless-Secret': INTERNAL_SECRET,
          'User-Agent': 'MIAD-Headless-Client'
        },
        body: JSON.stringify({
          customer_id: user.id,
          line_items,
          shipping: orderShipping,
          billing: orderBilling,
          customer_note: customer_note || '',
          payment_method: payment_method || 'stripe',
          payment_method_title: payment_method === 'stripe' ? 'Carte Bancaire / Stripe' : 'Autre mode de paiement',
          set_paid: false,
          shipping_lines: [
            {
              method_id: shipping_method_id || 'miad_standard',
              method_title: shipping_method_id === 'miad_express' ? 'MIAD Express' : 'MIAD Standard',
              total: shipping_total != null ? shipping_total.toString() : "0"
            }
          ]
        })
      });

      if (!orderRes.ok) {
        const errData = await orderRes.json().catch(() => ({ message: "Erreur inconnue" }));
        
        // On renvoie l'erreur spécifique (ex: "Désolé, ce produit est en rupture de stock")
        if (errData.message) {
          return NextResponse.json({ error: errData.message }, { status: 400 });
        }
        return NextResponse.json({ error: "Erreur lors de la création de la commande" }, { status: 400 });
      }
      
      const orderText = await orderRes.text();
      try {
        order = JSON.parse(orderText);
      } catch (e) {
        return NextResponse.json({ error: "Réponse WooCommerce invalide", details: "HTML reçu" }, { status: 502 });
      }

      // Enregistre l'adresse sur le profil client (1er achat ou mise à jour) pour que
      // les prochaines commandes se pré-remplissent automatiquement — meilleur effort,
      // ne doit jamais faire échouer la commande déjà créée.
      if (orderShipping || orderBilling) {
        try {
          await fetch(`${WOO_URL}/wp-json/wc/v3/customers/${user.id}?consumer_key=${WOO_KEY}&consumer_secret=${WOO_SECRET}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Headless-Secret': INTERNAL_SECRET, 'User-Agent': 'MIAD-Headless-Client' },
            body: JSON.stringify({ shipping: orderShipping, billing: orderBilling }),
          });
        } catch {
          // Non bloquant
        }
      }

      // Fallback si order n'est pas créé (cas où finalOrderId était déjà présent)
      if (!order && finalOrderId) {
        const checkRes = await fetch(`${WOO_URL}/wp-json/wc/v3/orders/${finalOrderId}?consumer_key=${WOO_KEY}&consumer_secret=${WOO_SECRET}`, {
          headers: { 'X-Headless-Secret': INTERNAL_SECRET, 'User-Agent': 'MIAD-Headless-Client' }
        });
        order = await checkRes.json().catch(() => null);
      }

      finalOrderId = order?.id || finalOrderId;
      finalAmount = order?.total || finalAmount;
      finalCurrency = order?.currency || finalCurrency;
    }

    if (!finalOrderId) throw new Error("Échec de la création de la commande sur WooCommerce.");

    // 3. Initialisation du paiement (Stripe ou PayDunya) via le backend WordPress
    if (payment_method === 'paydunya') {
      const cur    = (finalCurrency || 'USD').toUpperCase()
      const amtNum = parseFloat(String(finalAmount)) || 0
      const amtXof = (cur === 'XOF' || cur === 'FCFA')
        ? Math.round(amtNum)
        : Math.round(amtNum * (FX[cur] ?? 600))

      const paydunyaRes = await fetch(`${WOO_URL}/wp-json/miad/v1/create-paydunya-payment`, {
        method: 'POST',
        headers: wpHeaders(postToken),
        body: JSON.stringify({
          amount:   amtXof,
          currency: 'XOF',
          order_id: finalOrderId,
          email:    user.email || user.user_email || order?.billing?.email
        })
      });

      if (!paydunyaRes.ok) {
        const errBody = await paydunyaRes.text().catch(() => '')
        console.error('[PayDunya init]', paydunyaRes.status, errBody)
        // Extraire le message WordPress si JSON
        let wpMsg = ''
        try { wpMsg = JSON.parse(errBody)?.message || errBody } catch { wpMsg = errBody }
        return NextResponse.json(
          { error: `PayDunya ${paydunyaRes.status}: ${wpMsg.slice(0, 200)}` },
          { status: paydunyaRes.status === 400 ? 400 : 502 }
        )
      }

      const paydunyaData = await paydunyaRes.json();
      // PayDunya renvoie un token pour la modal JS
      return NextResponse.json({
        success: true,
        orderId: finalOrderId,
        paydunyaToken: paydunyaData.paydunyaToken,
        paydunyaUrl: paydunyaData.paydunyaUrl
      });
    }

    if (payment_method !== 'stripe') {
      // On renvoie l'ID et l'URL de paiement WC (qui redirige vers Wave/OM si configuré)
      return NextResponse.json({ 
        success: true, 
        orderId: finalOrderId,
        payment_url: order?.payment_url || null 
      });
    }

    // Appel au nouveau endpoint WordPress personnalisé
    const stripeRes = await fetch(`${WOO_URL}/wp-json/miad/v1/create-payment-intent`, {
      method: 'POST',
      headers: wpHeaders(postToken),
      body: JSON.stringify({
        amount: finalAmount,
        currency: finalCurrency,
        order_id: finalOrderId,
        email: user.email || user.user_email || order?.billing?.email,
        user_id: user.id,
        savePaymentMethod: !!savePaymentMethod,
        paymentMethodId: paymentMethodId || undefined,
      })
    });

    if (!stripeRes.ok) {
      const errorText = await stripeRes.text();
      throw new Error("Le serveur de paiement a renvoyé une erreur : " + (errorText.substring(0, 100)));
    }

    const stripeData = await stripeRes.json();

    return NextResponse.json({
      success: true,
      orderId: finalOrderId,
      clientSecret: stripeData.clientSecret,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Erreur lors de l'initialisation du processus de paiement" },
      { status: 500 }
    );
  }
}

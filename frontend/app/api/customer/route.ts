import { NextResponse } from 'next/server';
import { AUTH_SVC_URL, ORDER_SVC_URL, fetchWpUser, isAdmin } from '@/lib/miad-server-auth'
import { requireEnv } from '@/lib/require-env'

export const runtime = 'edge';

const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const queryId = searchParams.get('id');

    const auth = request.headers.get('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const token = auth.slice('Bearer '.length);

    // 1. Identifier l'utilisateur via le JWT auth-svc (vérifié côté edge, pas d'appel réseau)
    const user = await fetchWpUser(token);
    if (!user) {
      return NextResponse.json({
        error: 'Session invalide',
        message: 'Échec de la validation de session.',
      }, { status: 401 });
    }

    // Sécurité : Seul un admin peut voir un autre profil que le sien
    const targetCustomerId = (isAdmin(user) && queryId) ? queryId : String(user.sub);

    if (!targetCustomerId || targetCustomerId === '0') {
      return NextResponse.json({
        error: 'Invalid ID',
        message: "L'identifiant utilisateur est introuvable ou invalide.",
      }, { status: 400 });
    }

    // 2. Profil + commandes en parallèle (auth-svc / order-svc)
    // X-Customer-JWT transmet le token d'origine à auth-svc (2026-08-26) :
    // le secret interne prouve que l'appel vient bien de ce serveur, mais
    // ne dit rien sur la révocation du token client lui-même (changement
    // de mot de passe, déconnexion forcée) — voir checkCustomerSessionHeader.
    const [customerRes, ordersRes] = await Promise.all([
      fetch(`${AUTH_SVC_URL}/customer/${targetCustomerId}`, {
        cache: 'no-store',
        headers: { 'X-Internal-Secret': INTERNAL_SECRET, 'X-Customer-JWT': token },
      }),
      fetch(`${ORDER_SVC_URL}/orders?customer_id=${targetCustomerId}&page_size=20`, { cache: 'no-store' }),
    ]);

    if (!customerRes.ok) {
      return NextResponse.json({
        error: 'Customer not found',
        message: "Le compte client est introuvable.",
        debug_status: customerRes.status,
      }, { status: customerRes.status });
    }

    const c = await customerRes.json().catch(() => null);
    if (!c) {
      return NextResponse.json({ error: 'Parse Error', message: "Réponse auth-svc invalide" }, { status: 502 });
    }

    let ordersData: any = null;
    try {
      ordersData = await ordersRes.json();
    } catch {
      ordersData = null;
    }
    const ordersArray: any[] = Array.isArray(ordersData?.items) ? ordersData.items : [];

    // Calcul des statistiques pour les badges du Dashboard (AliExpress Style)
    // order-svc utilise des statuts différents de l'ancien WooCommerce
    // (pending_payment/paid/processing/shipped/delivered/cancelled/refunded/
    // payment_expired au lieu de pending/on-hold/processing/completed) — voir
    // validOrderStatuses dans services/order-svc/main.go.
    const orderStats = {
      toPay: ordersArray.filter((o) => o.status === 'pending_payment' || o.status === 'payment_expired').length,
      toShip: ordersArray.filter((o) => o.status === 'paid' || o.status === 'processing').length,
      shipped: ordersArray.filter((o) => o.status === 'shipped').length,
      completed: ordersArray.filter((o) => o.status === 'delivered').length,
      totalOrders: ordersArray.length,
    };

    const formatCustomer = (c: any) => {
      // auth-svc stocke `addresses` comme une LISTE d'adresses (JSONB
      // array, une entrée par type billing/shipping — voir
      // updateCustomerAddress dans auth-svc), pas des objets billing/
      // shipping distincts comme sous WooCommerce. Corrigé le 2026-08-26 :
      // ce GET renvoyait TOUJOURS billing/shipping vides même après un
      // PATCH réussi (qui écrit correctement dans addresses), donc l'UI
      // du dashboard client affichait "aucune adresse" indéfiniment.
      const addressList: any[] = Array.isArray(c.addresses) ? c.addresses : [];
      const billing = addressList.find((a) => a?.type === 'billing') || {};
      const shipping = addressList.find((a) => a?.type === 'shipping') || {};
      return {
        id: c.id,
        firstName: (c.full_name || '').split(' ')[0] || '',
        lastName: (c.full_name || '').split(' ').slice(1).join(' ') || '',
        name: c.full_name || c.email || 'Membre MIAD',
        email: c.email,
        role: isAdmin(user) ? 'administrator' : 'customer',
        username: c.email,
        ordersCount: orderStats.totalOrders,
        totalSpent: '0', // order-svc n'expose pas encore de total dépensé agrégé côté customer
        isPayingCustomer: orderStats.totalOrders > 0,
        avatar: `https://www.gravatar.com/avatar/${Buffer.from((c.email || '').toLowerCase()).toString('hex')}?s=96&d=mm`,
        dateCreated: c.created_at,
        billing,
        shipping,
        addresses: addressList,
        phone: c.phone || '',
        orderStats,
        recentOrders: ordersArray.slice(0, 5),
      };
    };

    return NextResponse.json({ success: true, data: formatCustomer(c) });

  } catch (error: any) {
    console.error("Fetch customers error:", error);
    return NextResponse.json({ message: error.message || "Erreur lors de la récupération des clients" }, { status: 500 });
  }
}

// PATCH /api/customer — Update billing or shipping address
//
// Relaie vers auth-svc PATCH /customer/{id}/address (secret interne),
// comblant le trou qui renvoyait un 501 explicite depuis la migration —
// voir la route Go pour le détail (addresses = array JSONB, upsert par
// type plutôt que d'écraser billing quand on modifie shipping).
export async function PATCH(request: Request) {
  try {
    const auth = request.headers.get('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const user = await fetchWpUser(auth.slice(7));
    if (!user) {
      return NextResponse.json({ error: 'Session invalide' }, { status: 401 });
    }

    const body = await request.json();
    const { type, address, id: queryId } = body; // type: 'billing' | 'shipping'

    if (!type || !address || !['billing', 'shipping'].includes(type)) {
      return NextResponse.json({ error: 'Données manquantes' }, { status: 400 });
    }

    // Même règle que GET : seul un admin peut modifier un autre profil que le sien.
    const targetCustomerId = (isAdmin(user) && queryId) ? queryId : String(user.sub);

    const res = await fetch(`${AUTH_SVC_URL}/customer/${targetCustomerId}/address`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET, 'X-Customer-JWT': auth.slice(7) },
      body: JSON.stringify({ type, address }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json({ error: err?.error?.message || 'Erreur backend' }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json({ success: true, addresses: data.addresses });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Erreur serveur' }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { AUTH_SVC_URL, ORDER_SVC_URL, fetchWpUser, isAdmin } from '@/lib/miad-server-auth'

export const runtime = 'edge';

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
    const [customerRes, ordersRes] = await Promise.all([
      fetch(`${AUTH_SVC_URL}/customer/${targetCustomerId}`, { cache: 'no-store' }),
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

    const formatCustomer = (c: any) => ({
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
      // auth-svc stocke `addresses` comme une LISTE d'adresses (JSONB array),
      // pas des objets billing/shipping distincts comme sous WooCommerce —
      // pas de mapping fiable vers billing/shipping ici (voir PATCH plus bas,
      // qui n'a de toute façon aucun endpoint backend pour écrire dessus).
      billing: {},
      shipping: {},
      addresses: c.addresses || [],
      phone: c.phone || '',
      orderStats,
      recentOrders: ordersArray.slice(0, 5),
    });

    return NextResponse.json({ success: true, data: formatCustomer(c) });

  } catch (error: any) {
    console.error("Fetch customers error:", error);
    return NextResponse.json({ message: error.message || "Erreur lors de la récupération des clients" }, { status: 500 });
  }
}

// PATCH /api/customer — Update billing or shipping address
//
// GAP BACKEND CONNU : auth-svc n'expose aujourd'hui AUCUN endpoint pour
// écrire une adresse sur un compte client (GET /customer/{id} existe,
// rien en PUT/PATCH — voir services/auth-svc/main.go, table `customers`
// avec une colonne `addresses` JSONB mais pas de route pour la modifier).
// Plutôt que de simuler un succès silencieux (ce qui ferait croire à
// l'utilisateur que son adresse est enregistrée alors qu'elle ne l'est
// nulle part), cette route renvoie explicitement une erreur 501 tant que
// l'endpoint n'existe pas côté auth-svc.
export async function PATCH(request: Request) {
  try {
    const auth = request.headers.get('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { type, address } = body; // type: 'billing' | 'shipping'

    if (!type || !address) {
      return NextResponse.json({ error: 'Données manquantes' }, { status: 400 });
    }

    return NextResponse.json({
      error: 'Not implemented',
      message: "La mise à jour d'adresse client n'est pas encore supportée par le backend Go (auth-svc n'a pas d'endpoint d'écriture pour customers.addresses). Voir le rapport de migration.",
    }, { status: 501 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Erreur serveur' }, { status: 500 });
  }
}

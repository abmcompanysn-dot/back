import { NextResponse } from 'next/server';

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com/').replace(/\/$/, '');
const WOO_KEY = process.env.WOO_CONSUMER_KEY;
const WOO_SECRET = process.env.WOO_CONSUMER_SECRET;
import { requireEnv } from '@/lib/require-env'
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

const fetchOptions = {
  headers: {
    'User-Agent': 'MIAD-Headless-Client',
    'X-Headless-Secret': INTERNAL_SECRET,
    'Accept': 'application/json',
  }
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const queryId = searchParams.get('id');

    const auth = request.headers.get('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 1. Identifier l'utilisateur via WordPress (récupère l'ID réel)
    const meRes = await fetch(`${WOO_URL}/wp-json/wp/v2/users/me?context=edit`, {
      method: 'GET',
 headers: {
        'Authorization': auth,
        'User-Agent': 'MIAD-Headless-Client',
        'X-Headless-Secret': INTERNAL_SECRET,
        'Accept': 'application/json',
      },
      cache: 'no-store'
    });

    if (!meRes.ok) {
      const errorText = await meRes.text().catch(() => "Aucun corps de réponse");

      // Aide au diagnostic du 403
      if (meRes.status === 403) {
        let errorJson: any = {};
        try { errorJson = JSON.parse(errorText); } catch(e) {}

        if (errorJson.code === 'jwt_auth_bad_config') {
          return NextResponse.json({ error: 'Config Error', message: 'JWT_AUTH_SECRET_KEY manquante dans wp-config.php' }, { status: 403 });
        }
        if (errorText.includes('<!DOCTYPE html>')) {
          return NextResponse.json({ error: 'Firewall Block', message: 'Le WAF de WordPress bloque la requête. Désactivez Anti-Bot AI.' }, { status: 403 });
        }
      }

      return NextResponse.json({ 
        error: 'Session invalide', 
        message: 'Échec de la validation de session WordPress.' 
      }, { status: meRes.status });
    }
    
    const meText = await meRes.text();
    let wpUser: any;
    try {
      wpUser = JSON.parse(meText);
    } catch (e) {
      return NextResponse.json({ error: "Réponse WordPress invalide", details: "Le serveur a renvoyé du HTML au lieu de JSON" }, { status: 502 });
    }

    // Sécurité : Seul un admin peut voir un autre profil que le sien
    const roles = wpUser.roles || [];
    const isAdmin = roles.includes('administrator');
    
    // Si on demande un ID spécifique mais qu'on n'est pas admin, on force notre propre ID
    const targetCustomerId = (isAdmin && queryId) ? queryId : wpUser.id;

    // Correction du 404 : Si l'ID est invalide, on ne lance pas la requête
    if (!targetCustomerId || targetCustomerId === '0') {
       return NextResponse.json({ 
         error: 'Invalid ID', 
         message: "L'identifiant utilisateur est introuvable ou invalide." 
       }, { status: 400 });
    }

    if (!WOO_KEY || !WOO_SECRET) {
      return NextResponse.json({ message: "Clés API WooCommerce manquantes dans le fichier .env" }, { status: 500 });
    }

    // Récupération avec les headers complets (identique aux produits qui marchent)
    const fetchOptions = {
      headers: {
        'User-Agent': 'MIAD-Headless-Client',
        'X-Headless-Secret': INTERNAL_SECRET,
        'Accept': 'application/json',
      }
    };

    const [customerRes, ordersRes] = await Promise.all([
      fetch(`${WOO_URL}/wp-json/wc/v3/customers/${targetCustomerId}?consumer_key=${WOO_KEY}&consumer_secret=${WOO_SECRET}`, fetchOptions),
      fetch(`${WOO_URL}/wp-json/wc/v3/orders?customer=${targetCustomerId}&per_page=20&consumer_key=${WOO_KEY}&consumer_secret=${WOO_SECRET}`, fetchOptions)
    ]);

    if (!customerRes.ok) {
      const errText = await customerRes.text().catch(() => "Aucun corps de réponse");
      return NextResponse.json({ 
        error: 'WooCommerce Block', 
        message: "Le serveur MIAD a renvoyé une erreur ou un blocage.",
        debug_status: customerRes.status 
      }, { status: customerRes.status });
    }

    // Lecture sécurisée du JSON pour éviter "Unexpected token <"
    const customerText = await customerRes.text();
    let c: any;
    try {
      c = JSON.parse(customerText);
    } catch (e) {
      return NextResponse.json({ error: 'Parse Error', message: "Le serveur a renvoyé du HTML au lieu de JSON" }, { status: 502 });
    }

    const ordersText = await ordersRes.text();
    let orders: any[] = [];
    try {
      orders = JSON.parse(ordersText);
    } catch (e) {
      orders = [];
    }

    // Calcul des statistiques pour les badges du Dashboard (AliExpress Style)
    const ordersArray = Array.isArray(orders) ? orders : [];
    const orderStats = {
      toPay: ordersArray.filter((o: any) => o.status === 'pending' || o.status === 'on-hold').length,
      toShip: ordersArray.filter((o: any) => o.status === 'processing').length,
      shipped: ordersArray.filter((o: any) => o.status === 'completed' && o.date_completed).length, // Ou un statut spécifique à ton transporteur
      completed: ordersArray.filter((o: any) => o.status === 'completed').length,
      totalOrders: ordersArray.length
    };

    const formatCustomer = (c: any) => ({
      id: c.id,
      // On utilise la structure exacte de ton JSON (Company ABM)
      firstName: c.first_name,
      lastName: c.last_name,
      name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.username || "Membre MIAD",
      email: c.email,
      role: c.role,
      username: c.username,
      // On récupère les stats de commandes calculées
      ordersCount: orderStats.totalOrders,
      totalSpent: c.total_spent || "0",
      isPayingCustomer: c.is_paying_customer,
      // Utilisation de l'avatar Gravatar renvoyé par WooCommerce
      avatar: c.avatar_url || `https://www.gravatar.com/avatar/${Buffer.from(c.email.toLowerCase()).toString('hex')}?s=96&d=mm`,
      dateCreated: c.date_created,
      billing: c.billing || {},
      shipping: c.shipping || {},
      phone: c.billing?.phone || '',
      orderStats, 
      recentOrders: ordersArray.slice(0, 5) 
    });
    return NextResponse.json({ success: true, data: formatCustomer(c) });

  } catch (error: any) {
    console.error("Fetch customers error:", error);
    return NextResponse.json({ message: error.message || "Erreur lors de la récupération des clients" }, { status: 500 });
  }
}

// PATCH /api/customer — Update billing or shipping address
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

    // Get user ID from WordPress
    const meRes = await fetch(`${WOO_URL}/wp-json/wp/v2/users/me?context=edit`, {
      headers: { Authorization: auth, 'User-Agent': 'MIAD-Headless-Client', 'X-Headless-Secret': INTERNAL_SECRET },
      cache: 'no-store',
    });

    if (!meRes.ok) {
      return NextResponse.json({ error: 'Session invalide' }, { status: meRes.status });
    }

    const wpUser = await meRes.json();
    const customerId = wpUser.id;

    if (!WOO_KEY || !WOO_SECRET) {
      return NextResponse.json({ error: 'Configuration manquante' }, { status: 500 });
    }

    const updateRes = await fetch(
      `${WOO_URL}/wp-json/wc/v3/customers/${customerId}?consumer_key=${WOO_KEY}&consumer_secret=${WOO_SECRET}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'MIAD-Headless-Client',
          'X-Headless-Secret': INTERNAL_SECRET,
        },
        body: JSON.stringify({ [type]: address }),
      }
    );

    if (!updateRes.ok) {
      const err = await updateRes.text().catch(() => '');
      return NextResponse.json({ error: 'Erreur WooCommerce', detail: err }, { status: updateRes.status });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Erreur serveur' }, { status: 500 });
  }
}

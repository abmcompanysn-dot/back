import { NextResponse } from 'next/server';
import { rateLimit, getIp, tooManyRequests } from '@/lib/rate-limit'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com/').replace(/\/$/, '');
const WOO_CK = process.env.WOO_CONSUMER_KEY;
const WOO_CS = process.env.WOO_CONSUMER_SECRET;
import { requireEnv } from '@/lib/require-env'
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

export async function POST(request: Request) {
  const ip = getIp(request)
  const rl = rateLimit(`register:${ip}`, 5, 60 * 60 * 1000) // 5 / heure
  if (!rl.allowed) return tooManyRequests(rl.resetAt)

  try {
    const body = await request.json();
    const { email, password, name, phone, accountType, storeName } = body;

    if (!email || !password) {
      return NextResponse.json({ message: 'Email et mot de passe requis' }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ message: 'Le nom est requis' }, { status: 400 });
    }
    if (accountType === 'vendor' && !storeName) {
      return NextResponse.json({ message: 'Le nom de la boutique est requis pour les vendeurs' }, { status: 400 });
    }
    // Ajout d'une validation simple pour le format de l'email
    if (!/\S+@\S+\.\S+/.test(email)) return NextResponse.json({ message: 'Format d\'email invalide' }, { status: 400 });

    // Préparation des données pour WooCommerce REST API
    // Le rôle 'seller' est celui par défaut pour Dokan
    const userData = {
      email: email,
      password: password,
      first_name: name.split(' ')[0] || '',
      last_name: name.split(' ').slice(1).join(' ') || '',
      username: email.split('@')[0], // Identifiant basé sur l'email
      role: accountType === 'vendor' ? 'seller' : 'customer',
      meta_data: accountType === 'vendor' ? [
        {
          key: 'dokan_store_name',
          value: storeName || name
        },
        {
          key: 'dokan_enable_selling',
          value: 'yes'
        }
      ] : [],
      billing: {
        phone: phone || ''
      }
    };

    const apiUrl = new URL(`${WOO_URL}/wp-json/wc/v3/customers`);
    apiUrl.searchParams.append('consumer_key', WOO_CK || '');
    apiUrl.searchParams.append('consumer_secret', WOO_CS || '');

    const response = await fetch(apiUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Headless-Secret': INTERNAL_SECRET,
        'User-Agent': 'MIAD-Headless-Client'
      },
      body: JSON.stringify(userData)
    });

    const data = await response.json();

    if (!response.ok) {
      // Log la réponse complète pour les erreurs 5xx afin de faciliter le diagnostic côté WordPress
      if (response.status >= 500 && response.status < 600) {
        console.error(`[API Register] Erreur 5xx détectée (Status: ${response.status}). Réponse complète:`, JSON.stringify(data, null, 2));
      }
      // Gestion des erreurs WordPress (ex: utilisateur déjà existant)
      return NextResponse.json(
        { message: data.message || 'Erreur lors de la création du compte' },
        { status: response.status }
      );
    }

    // Si c'est un vendeur, on pourrait ici appeler une API Dokan spécifique 
    // pour configurer le nom de la boutique (storeName), mais la création du rôle 'seller'
    // suffit généralement à déclencher le wizard Dokan côté WordPress.

    return NextResponse.json({
      success: true,
      message: "Compte créé avec succès",
      user_id: data.id
    });

  } catch (error: any) {
    console.error('Registration Error:', error);
    return NextResponse.json({ message: 'Erreur serveur lors de l\'inscription' }, { status: 500 });
  }
}

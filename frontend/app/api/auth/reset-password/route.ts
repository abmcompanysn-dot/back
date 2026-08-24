import { NextResponse } from 'next/server';

export const runtime = 'edge';

const FIREBASE_API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '');
const WOO_CK  = process.env.WOO_CONSUMER_KEY  || '';
const WOO_CS  = process.env.WOO_CONSUMER_SECRET || '';

// Messages Firebase traduits en français
const FIREBASE_ERROR_TRANSLATIONS: Record<string, string> = {
  'INVALID_OOB_CODE': 'Ce lien est invalide ou a déjà été utilisé.',
  'EXPIRED_OOB_CODE': 'Ce lien a expiré. Veuillez refaire une demande de réinitialisation.',
  'USER_DISABLED':    'Ce compte est désactivé.',
};

export async function POST(request: Request) {
  try {
    const { oobCode, newPassword } = await request.json();

    if (!oobCode || !newPassword) {
      return NextResponse.json({ message: 'Données manquantes' }, { status: 400 });
    }

    // 1. Firebase : confirme le reset et retourne l'email du compte
    const fbRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oobCode, newPassword }),
      }
    );

    const fbData = await fbRes.json();

    if (!fbRes.ok) {
      const msg = fbData.error?.message || 'Lien invalide ou expiré';
      return NextResponse.json(
        { message: FIREBASE_ERROR_TRANSLATIONS[msg] || msg },
        { status: fbRes.status }
      );
    }

    const userEmail: string = fbData.email || '';

    // 2. WooCommerce : synchronise le nouveau mot de passe
    if (userEmail && WOO_CK && WOO_CS) {
      try {
        const auth = Buffer.from(`${WOO_CK}:${WOO_CS}`).toString('base64');

        // Trouver le customer WooCommerce par email
        const searchRes = await fetch(
          `${WOO_URL}/wp-json/wc/v3/customers?email=${encodeURIComponent(userEmail)}`,
          { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } }
        );
        const customers = await searchRes.json();

        if (Array.isArray(customers) && customers.length > 0) {
          const customerId: number = customers[0].id;
          await fetch(
            `${WOO_URL}/wp-json/wc/v3/customers/${customerId}`,
            {
              method: 'PUT',
              headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: newPassword }),
            }
          );
        }
      } catch {
        // La mise à jour WooCommerce a échoué — on continue quand même
        console.error('[reset-password] WooCommerce sync failed for', userEmail);
      }
    }

    return NextResponse.json({ success: true, message: 'Mot de passe réinitialisé avec succès' });
  } catch {
    return NextResponse.json({ message: 'Erreur serveur' }, { status: 500 });
  }
}

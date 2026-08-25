import { NextResponse } from 'next/server';
import { requireEnv } from '@/lib/require-env'
import { AUTH_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

const FIREBASE_API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

// Messages Firebase traduits en français
const FIREBASE_ERROR_TRANSLATIONS: Record<string, string> = {
  'INVALID_OOB_CODE': 'Ce lien est invalide ou a déjà été utilisé.',
  'EXPIRED_OOB_CODE': 'Ce lien a expiré. Veuillez refaire une demande de réinitialisation.',
  'USER_DISABLED':    'Ce compte est désactivé.',
};

// Firebase reste la preuve de possession de l'email (oobCode envoyé par
// mail) ; le nouveau mot de passe est ensuite appliqué côté auth-svc
// (backend Go, seul propriétaire réel de password_hash) via une route
// protégée par secret interne, jamais exposée directement au navigateur.
export async function POST(request: Request) {
  try {
    const { oobCode, newPassword } = await request.json();

    if (!oobCode || !newPassword) {
      return NextResponse.json({ message: 'Données manquantes' }, { status: 400 });
    }

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

    if (userEmail) {
      try {
        await fetch(`${AUTH_SVC_URL}/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
          body: JSON.stringify({ email: userEmail, new_password: newPassword }),
        })
      } catch {
        // Le compte MIAD peut ne pas exister encore (utilisateur Firebase
        // pur, jamais passé par auth-svc) — on ne bloque pas le reset
        // Firebase lui-même pour autant.
        console.error('[reset-password] synchronisation auth-svc échouée pour', userEmail);
      }
    }

    return NextResponse.json({ success: true, message: 'Mot de passe réinitialisé avec succès' });
  } catch {
    return NextResponse.json({ message: 'Erreur serveur' }, { status: 500 });
  }
}

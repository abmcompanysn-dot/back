import { NextResponse } from 'next/server';
import { rateLimit, getIp, tooManyRequests } from '@/lib/rate-limit'

export const runtime = 'edge';

// Assurez-vous que cette variable est présente dans votre .env
const FIREBASE_API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;

export async function POST(request: Request) {
  const ip = getIp(request)
  const rl = rateLimit(`forgot-pwd:${ip}`, 3, 15 * 60 * 1000) // 3 / 15 min
  if (!rl.allowed) return tooManyRequests(rl.resetAt)

  try {
    const body = await request.json().catch(() => ({}));
    const { email } = body;

    if (!email) {
      return NextResponse.json({ message: 'Email requis' }, { status: 400 });
    }

    // Utilisation de l'API REST Firebase Auth pour déclencher l'envoi de l'email.
    // On utilise l'opération sendOobCode avec le type PASSWORD_RESET.
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestType: 'PASSWORD_RESET',
          email: email,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { message: data.error?.message || "Erreur lors de l'envoi de l'email de réinitialisation" },
        { status: response.status }
      );
    }

    return NextResponse.json({ success: true, message: 'Email de réinitialisation envoyé avec succès' });
  } catch (error: any) {
    console.error('Forgot Password API Error:', error);
    return NextResponse.json({ message: 'Erreur serveur lors de la demande' }, { status: 500 });
  }
}

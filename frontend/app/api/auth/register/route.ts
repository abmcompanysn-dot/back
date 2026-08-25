import { NextResponse } from 'next/server';
import { rateLimit, getIp, tooManyRequests } from '@/lib/rate-limit'
import { AUTH_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

// Inscription par mot de passe (pas le flux OTP principal, voir
// app/api/auth/otp/verify — ce endpoint n'a plus d'appelant dans l'UI
// actuelle, migré par cohérence). L'inscription vendeur est désactivée
// depuis le 2026-07-13 (voir CLAUDE.md) : tout compte créé ici est un
// acheteur, jamais un vendeur — accountType/storeName retirés.
export async function POST(request: Request) {
  const ip = getIp(request)
  const rl = rateLimit(`register:${ip}`, 5, 60 * 60 * 1000) // 5 / heure
  if (!rl.allowed) return tooManyRequests(rl.resetAt)

  try {
    const body = await request.json();
    const { email, password, name } = body;

    if (!email || !password) {
      return NextResponse.json({ message: 'Email et mot de passe requis' }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ message: 'Le nom est requis' }, { status: 400 });
    }
    if (!/\S+@\S+\.\S+/.test(email)) return NextResponse.json({ message: 'Format d\'email invalide' }, { status: 400 });

    const res = await fetch(`${AUTH_SVC_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, full_name: name }),
    })
    const data: any = await res.json().catch(() => ({}))

    if (!res.ok) {
      return NextResponse.json({ message: data?.error?.message || 'Erreur lors de la création du compte' }, { status: res.status });
    }

    return NextResponse.json({
      success: true,
      message: "Compte créé avec succès",
      user_id: data.customer_id,
    });

  } catch (error: any) {
    console.error('Registration Error:', error);
    return NextResponse.json({ message: 'Erreur serveur lors de l\'inscription' }, { status: 500 });
  }
}

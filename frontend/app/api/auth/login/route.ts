/**
 * Route d'authentification Miad Market — auth-svc (backend Go).
 * Le rôle n'est plus un champ WordPress séparé : un JWT customer porte
 * vendor_id (non-null = vendeur) ; le rôle admin/représentant se
 * détermine par un login distinct (auth/admin/login) ou une résolution
 * ultérieure (representative/by-email), pas dans ce flux acheteur.
 */
import { NextResponse } from 'next/server'
import { rateLimit, getIp, tooManyRequests } from '@/lib/rate-limit'
import { AUTH_SVC_URL, LOYALTY_SVC_URL, verifyJWT } from '@/lib/miad-server-auth'

export const runtime = 'edge';

// Le rôle "représentant" n'est pas un claim JWT (pas de notion de rôle
// séparée côté auth-svc) — résolu par email via loyalty-svc, seul endroit
// qui connaît les représentants pays. Best-effort : jamais bloquant pour
// le login si loyalty-svc est indisponible.
async function isRepresentative(email: string | undefined): Promise<boolean> {
  if (!email) return false
  try {
    const res = await fetch(`${LOYALTY_SVC_URL}/representative/by-email/${encodeURIComponent(email)}`)
    return res.ok
  } catch {
    return false
  }
}

export async function POST(request: Request) {
  const ip = getIp(request)
  const rl = rateLimit(`login:${ip}`, 5, 5 * 60 * 1000) // 5 / 5 min
  if (!rl.allowed) return tooManyRequests(rl.resetAt)

  try {
    const body = await request.json().catch(() => ({}));
    const { username, password, firebase_token } = body;

    // 1. CAS FIREBASE (Google / Facebook)
    if (firebase_token) {
      const res = await fetch(`${AUTH_SVC_URL}/auth/firebase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_token: firebase_token }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        return NextResponse.json({ message: data?.error?.message || 'Liaison Firebase échouée' }, { status: res.status });
      }
      const claims = data.session?.jwt ? await verifyJWT(data.session.jwt) : null
      const rep = await isRepresentative(claims?.email as string | undefined)
      return NextResponse.json({
        success: true,
        token: data.session?.jwt,
        id: data.customer_id,
        role: rep ? 'representant' : (claims?.vendor_id ? 'vendor' : 'buyer'),
      });
    }

    // 2. CAS CLASSIQUE (email/mot de passe) — "username" du formulaire est
    // en réalité toujours un email dans ce système (pas de nom d'utilisateur
    // WordPress séparé côté auth-svc).
    if (!username || !password) {
      return NextResponse.json({ message: 'Identifiants ou mot de passe manquants' }, { status: 400 })
    }

    const res = await fetch(`${AUTH_SVC_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: username, password }),
    })
    const data: any = await res.json().catch(() => ({}))

    if (!res.ok) {
      return NextResponse.json({ message: data?.error?.message || 'Identifiants ou mot de passe incorrects' }, { status: res.status })
    }

    const claims = data.session?.jwt ? await verifyJWT(data.session.jwt) : null
    const rep = await isRepresentative(claims?.email as string | undefined)
    return NextResponse.json({
      success: true,
      token: data.session?.jwt,
      id: data.customer_id,
      user_email: username,
      role: rep ? 'representant' : (claims?.vendor_id ? 'vendor' : 'buyer'),
    })

  } catch (error: any) {
    return NextResponse.json(
      { message: error.message || 'Erreur lors de la connexion' },
      { status: 500 }
    )
  }
}

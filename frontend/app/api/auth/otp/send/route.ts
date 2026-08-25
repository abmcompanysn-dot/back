import { NextResponse } from 'next/server'
import { rateLimit, getIp, tooManyRequests } from '@/lib/rate-limit'
import { AUTH_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

// ATTENTION (voir CLAUDE.md / suivi migration) : POST /auth/otp/send côté
// auth-svc ne fait qu'enregistrer le code dans Redis et le logger en
// mode dev — aucun canal d'envoi réel (email/SMS) n'est câblé, alors
// qu'un template email otp_email existe déjà côté email-svc (jamais
// appelé). Le champ dev_mode dans la réponse reflète cet état : tant que
// SMS_PROVIDER_URL n'est pas configuré côté auth-svc ET qu'un pont vers
// email-svc n'est pas ajouté, aucun OTP n'atteint réellement l'utilisateur
// en production. Trou fonctionnel backend, pas quelque chose que cette
// route frontend peut corriger seule.
export async function POST(request: Request) {
  const ip = getIp(request)
  const rl = rateLimit(`otp-send:${ip}`, 3, 10 * 60 * 1000) // 3 / 10 min
  if (!rl.allowed) return tooManyRequests(rl.resetAt)

  try {
    const { email } = await request.json()
    if (!email) return NextResponse.json({ error: 'Email requis' }, { status: 400 })

    const res = await fetch(`${AUTH_SVC_URL}/auth/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: email, channel: 'email' }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return NextResponse.json({ error: data?.error?.message || 'Erreur serveur' }, { status: res.status })
    return NextResponse.json({ success: true, otp_ref: data.otp_ref })
  } catch {
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { rateLimit, getIp, tooManyRequests } from '@/lib/rate-limit'
import { AUTH_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

// Canal email réellement câblé depuis le 2026-08-26 : auth-svc appelle
// email-svc (template otp_email) pour channel=="email" — voir
// sendOTPEmail dans services/auth-svc/main.go. Le canal SMS reste en
// mode dev (SMS_PROVIDER_URL configurable mais aucun appel réel
// implémenté) : dev_mode dans la réponse reflète l'état du canal
// effectivement demandé ici (email), pas du SMS.
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

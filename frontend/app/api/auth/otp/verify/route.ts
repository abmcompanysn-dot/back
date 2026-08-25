import { NextResponse } from 'next/server'
import { rateLimit, getIp, tooManyRequests } from '@/lib/rate-limit'
import { AUTH_SVC_URL, LOYALTY_SVC_URL, verifyJWT } from '@/lib/miad-server-auth'

export const runtime = 'edge';

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
  const rl = rateLimit(`otp-verify:${ip}`, 5, 5 * 60 * 1000) // 5 / 5 min
  if (!rl.allowed) return tooManyRequests(rl.resetAt)

  try {
    const { email, code, otp_ref, name, account_type, referral_code } = await request.json()
    const cleaned = (code || '').replace(/\D/g, '')

    if (!email || cleaned.length !== 6) {
      return NextResponse.json({ error: 'Email et code à 6 chiffres requis.' }, { status: 400 })
    }
    if (!otp_ref) {
      return NextResponse.json({ error: 'Session de vérification expirée, redemandez un code.' }, { status: 400 })
    }

    // Inscription vendeur désactivée (demandé le 2026-07-13).
    if (account_type === 'vendor') {
      return NextResponse.json({ error: 'L\'inscription en tant que vendeur est temporairement fermée.' }, { status: 403 })
    }

    const res = await fetch(`${AUTH_SVC_URL}/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otp_ref, code: cleaned, full_name: name || '', referral_code: referral_code || '' }),
    })

    const data: any = await res.json().catch(() => ({}))

    if (!res.ok || !data.session?.jwt) {
      return NextResponse.json(
        { error: data?.error?.message || 'Code incorrect ou expiré.' },
        { status: res.status || 400 }
      )
    }

    const claims = await verifyJWT(data.session.jwt)
    const rep = await isRepresentative(email)
    const role = rep ? 'representant' : (claims?.vendor_id ? 'vendor' : 'buyer')

    // Si Firebase est configuré, on renvoie aussi un custom token pour que
    // le client puisse basculer en session Firebase (signInWithCustomToken).
    if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
      try {
        const { createFirebaseCustomToken, uidFromEmail } = await import('@/lib/firebase-custom-token')
        const uid = await uidFromEmail(email)
        const customToken = await createFirebaseCustomToken(uid, { email, miad_token: data.session.jwt })
        return NextResponse.json({
          success: true,
          customToken,
          token: data.session.jwt,
          user_display_name: data.full_name || name,
          user_email: data.identifier || email,
          id: data.customer_id,
          role,
        })
      } catch (e) {
        console.warn('Custom token creation failed, returning token only:', e)
      }
    }

    return NextResponse.json({
      success: true,
      token: data.session.jwt,
      user_display_name: data.full_name || name,
      user_email: data.identifier || email,
      id: data.customer_id,
      role,
    })

  } catch (err) {
    console.error('OTP verify error:', err)
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

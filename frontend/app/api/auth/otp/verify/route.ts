import { NextResponse } from 'next/server'
import { rateLimit, getIp, tooManyRequests } from '@/lib/rate-limit'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')
import { requireEnv } from '@/lib/require-env'
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

const REP_ROLES = ['miad_representative', 'miad_representant', 'representant', 'miad_rep', 'miad_agent', 'miad_super_rep']

function normalizeRole(rawRole?: string): string {
  if (!rawRole) return 'buyer'
  if (rawRole === 'administrator') return 'admin'
  if (['seller', 'vendor', 'wcfm_vendor'].includes(rawRole)) return 'vendor'
  if (REP_ROLES.includes(rawRole)) return 'representant'
  return 'buyer'
}

export async function POST(request: Request) {
  const ip = getIp(request)
  const rl = rateLimit(`otp-verify:${ip}`, 5, 5 * 60 * 1000) // 5 / 5 min
  if (!rl.allowed) return tooManyRequests(rl.resetAt)

  try {
    const { email, code, name, phone, account_type } = await request.json()
    const cleaned = (code || '').replace(/\D/g, '')

    if (!email || cleaned.length !== 6) {
      return NextResponse.json({ error: 'Email et code à 6 chiffres requis.' }, { status: 400 })
    }

    // Inscription vendeur désactivée (demandé le 2026-07-13) : bloqué ici
    // (pas seulement dans RegisterPage.tsx) pour qu'un appel direct à cette
    // route avec account_type=vendor ne contourne pas le blocage côté UI.
    if (account_type === 'vendor') {
      return NextResponse.json({ error: 'L\'inscription en tant que vendeur est temporairement fermée.' }, { status: 403 })
    }

    // 1. Verify OTP code via WordPress (generates code + stores in WP transients)
    const res = await fetch(`${WOO_URL}/wp-json/miad/v1/otp/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Headless-Secret': INTERNAL_SECRET,
        'User-Agent': 'MIAD-Headless-Client',
      },
      body: JSON.stringify({ email, code: cleaned, name, phone, account_type }),
    })

    const text = await res.text()
    if (text.trim().startsWith('<')) {
      return NextResponse.json({ error: 'Erreur serveur (WAF).' }, { status: 502 })
    }

    let data: any
    try { data = JSON.parse(text) } catch {
      return NextResponse.json({ error: 'Réponse serveur invalide.' }, { status: 502 })
    }

    if (!res.ok || !data.token) {
      return NextResponse.json(
        { error: data.error || data.message || 'Code incorrect ou expiré.' },
        { status: res.ok ? 400 : res.status }
      )
    }

    // 2. If Firebase service account is configured, also return a Firebase custom token
    //    so the client can call signInWithCustomToken() and get a proper Firebase session.
    if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
      try {
        const { createFirebaseCustomToken, uidFromEmail } = await import('@/lib/firebase-custom-token')
        const uid         = await uidFromEmail(email)
        const customToken = await createFirebaseCustomToken(uid, { email, wp_token: data.token })
        return NextResponse.json({
          success: true,
          customToken,             // client uses signInWithCustomToken → ID token → /api/auth/login
          token: data.token,       // fallback miad_ token (still valid for checkout)
          user_display_name: data.user_display_name || name,
          user_email: data.user_email || email,
          user_nicename: data.user_nicename,
          id: data.id,
          role: normalizeRole(data.role),
          avatar: data.avatar,
        })
      } catch (e) {
        console.warn('Custom token creation failed, returning miad_ token only:', e)
      }
    }

    // 3. Fallback: return miad_ token directly (checkout works via X-Miad-Session path)
    return NextResponse.json({
      success: true,
      token: data.token,
      user_display_name: data.user_display_name || name,
      user_email: data.user_email || email,
      user_nicename: data.user_nicename,
      id: data.id,
      role: normalizeRole(data.role),
      avatar: data.avatar,
    })

  } catch (err) {
    console.error('OTP verify error:', err)
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

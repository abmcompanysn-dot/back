import { NextResponse } from 'next/server'
import { rateLimit, getIp, tooManyRequests } from '@/lib/rate-limit'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')

export async function POST(request: Request) {
  const ip = getIp(request)
  const rl = rateLimit(`otp-send:${ip}`, 3, 10 * 60 * 1000) // 3 / 10 min
  if (!rl.allowed) return tooManyRequests(rl.resetAt)

  try {
    const { email } = await request.json()
    if (!email) return NextResponse.json({ error: 'Email requis' }, { status: 400 })

    // WordPress generates the 6-digit code, stores it in WP transients, and sends the branded email
    const res = await fetch(`${WOO_URL}/wp-json/miad/v1/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    const data = await res.json().catch(() => ({}))
    return NextResponse.json(data, { status: res.ok ? 200 : (res.status || 500) })
  } catch {
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

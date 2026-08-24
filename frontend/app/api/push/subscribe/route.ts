import { NextResponse } from 'next/server'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')
const WOO_CK  = process.env.WOO_CONSUMER_KEY  || ''
const WOO_CS  = process.env.WOO_CONSUMER_SECRET || ''

export async function POST(request: Request) {
  try {
    const { token, user_id } = await request.json()
    if (!token) return NextResponse.json({ error: 'Token manquant' }, { status: 400 })

    const auth = Buffer.from(`${WOO_CK}:${WOO_CS}`).toString('base64')

    // Stocker le token FCM dans WordPress via notre endpoint custom
    await fetch(`${WOO_URL}/wp-json/miad/v1/push/subscribe`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token, user_id: user_id || null }),
    })

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ success: false }, { status: 500 })
  }
}

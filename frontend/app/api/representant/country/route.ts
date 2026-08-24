import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  let country = (searchParams.get('country') || '').toUpperCase()

  // Use Cloudflare country header if no explicit country
  if (!country) {
    country = request.headers.get('cf-ipcountry') || ''
  }

  try {
    const url = country
      ? `${WOO_URL}/wp-json/miad/v1/representant/country?country=${encodeURIComponent(country)}`
      : `${WOO_URL}/wp-json/miad/v1/representant/country`

    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'MIAD-Headless-Client' },
      cache: 'no-store',
    })

    if (!res.ok) return NextResponse.json({ found: false })
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ found: false })
  }
}

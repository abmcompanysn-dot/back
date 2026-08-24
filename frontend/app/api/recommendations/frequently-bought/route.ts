import { NextResponse } from 'next/server'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')

// Relais public — données agrégées non sensibles (IDs produits + compteurs).
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const productId = searchParams.get('product_id')
  const limit = searchParams.get('limit') || '8'

  if (!productId || !/^\d+$/.test(productId)) {
    return NextResponse.json({ recommendations: [] })
  }

  try {
    const res = await fetch(
      `${WOO_URL}/wp-json/miad-analytics/v1/recommendations?product_id=${productId}&limit=${encodeURIComponent(limit)}`,
      { headers: { 'User-Agent': 'MIAD-Headless-Client', Accept: 'application/json' }, next: { revalidate: 3600 } }
    )
    if (!res.ok) return NextResponse.json({ recommendations: [] })
    const data = await res.json()
    return NextResponse.json({ recommendations: data.recommendations || [] }, {
      headers: { 'Cache-Control': 'public, s-maxage=3600' },
    })
  } catch {
    return NextResponse.json({ recommendations: [] })
  }
}

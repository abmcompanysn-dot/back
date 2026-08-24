import { NextResponse } from 'next/server'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')
const WOO_CK  = process.env.WOO_CONSUMER_KEY  || ''
const WOO_CS  = process.env.WOO_CONSUMER_SECRET || ''
import { requireEnv } from '@/lib/require-env'
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

function wooHeaders() {
  return {
    Authorization: 'Basic ' + Buffer.from(`${WOO_CK}:${WOO_CS}`).toString('base64'),
    'Content-Type': 'application/json',
    'X-Headless-Secret': INTERNAL_SECRET,
    'User-Agent': 'MIAD-Headless-Client',
  }
}

// GET /api/products/[id]/variations
export async function GET(
  _: Request,
  { params }: { params: { id: string } }
) {
  const res = await fetch(
    `${WOO_URL}/wp-json/wc/v3/products/${params.id}/variations?per_page=100`,
    { headers: wooHeaders() }
  )
  const data = await res.json()
  if (!res.ok) return NextResponse.json({ error: data.message }, { status: res.status })
  return NextResponse.json({ variations: data }, {
    headers: { 'Cache-Control': 'public, max-age=60, s-maxage=3600' },
  })
}

// POST /api/products/[id]/variations
// body: { variations: [{id?, attrs, price, regularPrice, salePrice, stock, imageId}] }
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const variations: any[] = body?.variations || []

  const results = await Promise.all(
    variations.map(async (v: any) => {
      const regular = v.regularPrice || v.price
      const sale    = v.regularPrice && v.regularPrice !== v.price ? v.price : (v.salePrice || '')

      const payload: Record<string, any> = {
        regular_price:  String(regular || ''),
        sale_price:     String(sale),
        manage_stock:   true,
        stock_quantity: parseInt(v.stock) || 0,
        attributes: Object.entries(v.attrs || {}).map(([name, option]) => ({ name, option })),
      }

      if (v.imageId) payload.image = { id: v.imageId }

      const isUpdate = !!v.id
      const url    = isUpdate
        ? `${WOO_URL}/wp-json/wc/v3/products/${params.id}/variations/${v.id}`
        : `${WOO_URL}/wp-json/wc/v3/products/${params.id}/variations`
      const method = isUpdate ? 'PUT' : 'POST'

      const res = await fetch(url, { method, headers: wooHeaders(), body: JSON.stringify(payload) })
      return res.json()
    })
  )

  return NextResponse.json({ success: true, variations: results })
}

// DELETE /api/products/[id]/variations — supprimer une variation spécifique via ?variationId=X
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const variationId = searchParams.get('variationId')
  if (!variationId) return NextResponse.json({ error: 'variationId requis' }, { status: 400 })

  const res = await fetch(
    `${WOO_URL}/wp-json/wc/v3/products/${params.id}/variations/${variationId}?force=true`,
    { method: 'DELETE', headers: wooHeaders() }
  )
  const data = await res.json()
  if (!res.ok) return NextResponse.json({ error: data.message }, { status: res.status })
  return NextResponse.json({ success: true })
}

import { NextResponse } from 'next/server'
import { CATALOG_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

// GET /api/products/[id]/variations
export async function GET(
  _: Request,
  { params }: { params: { id: string } }
) {
  const res = await fetch(`${CATALOG_SVC_URL}/products/${params.id}?lang=fr`, { next: { revalidate: 60 } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: data?.error?.message }, { status: res.status })
  return NextResponse.json({ variations: data.variations || [] }, {
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

      const payload: Record<string, any> = {
        price_usd: Number(regular || 0),
        stock: parseInt(v.stock) || 0,
        attributes: v.attrs || {},
      }
      if (v.imageUrl) payload.image_url = v.imageUrl

      const isUpdate = !!v.id
      const url = isUpdate
        ? `${CATALOG_SVC_URL}/products/${params.id}/variations/${v.id}`
        : `${CATALOG_SVC_URL}/products/${params.id}/variations`
      const method = isUpdate ? 'PUT' : 'POST'

      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      return res.json().catch(() => ({}))
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
    `${CATALOG_SVC_URL}/products/${params.id}/variations/${variationId}`,
    { method: 'DELETE' }
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: data?.error?.message }, { status: res.status })
  return NextResponse.json({ success: true })
}

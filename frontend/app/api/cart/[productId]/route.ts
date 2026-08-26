import { NextResponse } from 'next/server'
import { CATALOG_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

async function requireCustomerId(request: Request): Promise<number | NextResponse> {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }
  const user = await fetchWpUser(auth.slice(7))
  if (!user) {
    return NextResponse.json({ error: 'Session invalide' }, { status: 401 })
  }
  return Number(user.sub)
}

// PUT /api/cart/{productId} — body: { variationId?, quantity }
// Remplace toujours la quantité (jamais un delta) — voir upsertCartItem
// côté catalog-svc pour le même raisonnement.
export async function PUT(request: Request, { params }: { params: Promise<{ productId: string }> }) {
  const customerId = await requireCustomerId(request)
  if (customerId instanceof NextResponse) return customerId
  const { productId } = await params

  const body = await request.json().catch(() => ({}))
  const { variationId, quantity } = body || {}

  const res = await fetch(`${CATALOG_SVC_URL}/cart/${customerId}/${productId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variation_id: variationId ?? null, quantity }),
  })
  if (!res.ok) {
    return NextResponse.json({ error: 'Impossible de mettre à jour le panier' }, { status: 502 })
  }
  return NextResponse.json({ success: true })
}

// DELETE /api/cart/{productId}?variationId=X
export async function DELETE(request: Request, { params }: { params: Promise<{ productId: string }> }) {
  const customerId = await requireCustomerId(request)
  if (customerId instanceof NextResponse) return customerId
  const { productId } = await params

  const { searchParams } = new URL(request.url)
  const variationId = searchParams.get('variationId')
  const qs = variationId ? `?variation_id=${variationId}` : ''

  const res = await fetch(`${CATALOG_SVC_URL}/cart/${customerId}/${productId}${qs}`, { method: 'DELETE' })
  if (!res.ok) {
    return NextResponse.json({ error: 'Impossible de retirer du panier' }, { status: 502 })
  }
  return NextResponse.json({ success: true })
}

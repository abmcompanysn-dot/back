import { NextResponse } from 'next/server'
import { CATALOG_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

// PUT /api/products/[id] — édition d'un produit par le vendeur connecté.
// Migré vers PATCH {CATALOG_SVC_URL}/products/{id} (partiel — seuls les
// champs fournis sont modifiés côté catalog-svc).
export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Corps invalide' }, { status: 400 })

  const {
    name, description,
    price, regularPrice, salePrice,
    stock, images, category_id,
  } = body

  // regularPrice/salePrice sont les champs canoniques renseignes par le
  // formulaire ; "price" n'est qu'un champ d'affichage derive cote client.
  const regular = regularPrice ?? price
  const sale = salePrice || null

  const payload: Record<string, any> = {
    name,
    description,
    price_usd: regular !== undefined ? Number(regular) : undefined,
    sale_price_usd: sale !== null ? Number(sale) : null,
    stock: stock !== undefined ? parseInt(stock) || 0 : undefined,
  }
  if (Array.isArray(images)) payload.images = images
  if (category_id) payload.category_id = Number(category_id)

  const res = await fetch(`${CATALOG_SVC_URL}/products/${params.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: data?.error?.message || 'Erreur catalog-svc' }, { status: res.status })
  return NextResponse.json({ success: true, product: data })
}

// DELETE /api/products/[id]
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }

  const res = await fetch(`${CATALOG_SVC_URL}/products/${params.id}`, { method: 'DELETE' })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: data?.error?.message || 'Erreur suppression' }, { status: res.status })
  return NextResponse.json({ success: true })
}

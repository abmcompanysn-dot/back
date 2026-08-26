import { NextResponse } from 'next/server'
import { CATALOG_SVC_URL, fetchWpUser, isAdmin } from '@/lib/miad-server-auth'

export const runtime = 'edge';

// checkProductOwnership — un vendeur ne peut modifier/supprimer que SES
// propres produits (IDOR corrigé le 2026-08-26 : PUT/DELETE vérifiaient
// juste la PRÉSENCE d'un header Authorization, jamais sa validité ni que
// le produit visé appartenait au vendeur du token — n'importe quel vendeur
// connecté pouvait éditer/supprimer le produit d'un autre en changeant
// l'ID dans l'URL). Un admin passe outre cette vérification.
async function checkProductOwnership(productId: string, vendorId: number): Promise<boolean> {
  const res = await fetch(`${CATALOG_SVC_URL}/products/${productId}`)
  if (!res.ok) return false
  const product = await res.json().catch(() => null)
  return product?.vendor_id === vendorId
}

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
  const user = await fetchWpUser(auth.slice(7))
  if (!user) return NextResponse.json({ error: 'Session invalide' }, { status: 401 })
  if (!isAdmin(user)) {
    if (!user.vendor_id) return NextResponse.json({ error: 'Accès réservé aux vendeurs' }, { status: 403 })
    const owns = await checkProductOwnership(params.id, Number(user.vendor_id))
    if (!owns) return NextResponse.json({ error: 'Ce produit ne vous appartient pas' }, { status: 403 })
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
  const user = await fetchWpUser(auth.slice(7))
  if (!user) return NextResponse.json({ error: 'Session invalide' }, { status: 401 })
  if (!isAdmin(user)) {
    if (!user.vendor_id) return NextResponse.json({ error: 'Accès réservé aux vendeurs' }, { status: 403 })
    const owns = await checkProductOwnership(params.id, Number(user.vendor_id))
    if (!owns) return NextResponse.json({ error: 'Ce produit ne vous appartient pas' }, { status: 403 })
  }

  const res = await fetch(`${CATALOG_SVC_URL}/products/${params.id}`, { method: 'DELETE' })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: data?.error?.message || 'Erreur suppression' }, { status: res.status })
  return NextResponse.json({ success: true })
}

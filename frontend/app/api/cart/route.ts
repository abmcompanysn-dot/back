import { NextResponse } from 'next/server'
import { CATALOG_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'
import { fetchWooProductsByIds } from '@/lib/woo-catalog'

export const runtime = 'edge'

// Panier serveur — construit le 2026-08-26, même raisonnement que la
// wishlist (voir app/api/wishlist/route.ts) : le panier n'était que
// localStorage jusqu'ici, perdu à chaque changement d'appareil. GET
// renvoie les produits enrichis + quantité/variation, pas juste les IDs
// (réutilise fetchWooProductsByIds comme la wishlist, pas de duplication
// du mapping produit ici).
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

export async function GET(request: Request) {
  const customerId = await requireCustomerId(request)
  if (customerId instanceof NextResponse) return customerId

  const { searchParams } = new URL(request.url)
  const lang = (searchParams.get('lang') as 'fr' | 'en') || 'fr'

  const res = await fetch(`${CATALOG_SVC_URL}/cart/${customerId}`, { cache: 'no-store' })
  if (!res.ok) {
    return NextResponse.json({ error: 'Panier indisponible' }, { status: 502 })
  }
  const data = await res.json().catch(() => ({}))
  const rawItems: { product_id: number; variation_id: number | null; quantity: number }[] = data.items || []

  const productIds = rawItems.map((i) => i.product_id)
  const products = await fetchWooProductsByIds(productIds, lang)
  const byId = new Map(products.map((p: any) => [String(p.id), p]))

  const items = rawItems
    .map((i) => {
      const product = byId.get(String(i.product_id))
      if (!product) return null
      return { product, quantity: i.quantity, variationId: i.variation_id }
    })
    .filter(Boolean)

  return NextResponse.json({ items })
}

// DELETE /api/cart — vide tout le panier (appelé après un checkout réussi).
export async function DELETE(request: Request) {
  const customerId = await requireCustomerId(request)
  if (customerId instanceof NextResponse) return customerId

  const res = await fetch(`${CATALOG_SVC_URL}/cart/${customerId}`, { method: 'DELETE' })
  if (!res.ok) {
    return NextResponse.json({ error: 'Impossible de vider le panier' }, { status: 502 })
  }
  return NextResponse.json({ success: true })
}

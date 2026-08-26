import { NextResponse } from 'next/server'
import { CATALOG_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'
import { fetchWooProductsByIds } from '@/lib/woo-catalog'

export const runtime = 'edge'

// Wishlist / favoris — construit le 2026-08-26 : le bouton cœur et la
// section "Liste de souhaits" du dashboard client n'étaient que des
// maquettes vides jusqu'ici (voir catalog-svc pour la table wishlists).
// GET renvoie directement les produits enrichis (pas juste les IDs) :
// réutilise fetchWooProductsByIds, déjà utilisé pour la recherche
// sémantique, pour ne pas dupliquer le mapping produit ici.
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

  const res = await fetch(`${CATALOG_SVC_URL}/wishlist/${customerId}`, { cache: 'no-store' })
  if (!res.ok) {
    return NextResponse.json({ error: 'Wishlist indisponible' }, { status: 502 })
  }
  const data = await res.json().catch(() => ({}))
  const ids: (number | string)[] = data.product_ids || []
  const products = await fetchWooProductsByIds(ids, lang)
  // fetchWooProductsByIds ne garantit pas l'ordre demandé (catalog-svc
  // ?include= ne trie pas forcément par la liste fournie) — reconstruit
  // l'ordre "ajout le plus récent d'abord" attendu par l'UI.
  const byId = new Map(products.map((p: any) => [String(p.id), p]))
  const ordered = ids.map((id) => byId.get(String(id))).filter(Boolean)

  return NextResponse.json({ products: ordered })
}

export async function POST(request: Request) {
  const customerId = await requireCustomerId(request)
  if (customerId instanceof NextResponse) return customerId

  const body = await request.json().catch(() => ({}))
  const productId = body?.product_id
  if (!productId) {
    return NextResponse.json({ error: 'product_id requis' }, { status: 400 })
  }

  const res = await fetch(`${CATALOG_SVC_URL}/wishlist/${customerId}/${productId}`, { method: 'POST' })
  if (!res.ok) {
    return NextResponse.json({ error: 'Impossible d’ajouter aux favoris' }, { status: 502 })
  }
  return NextResponse.json({ success: true })
}

export async function DELETE(request: Request) {
  const customerId = await requireCustomerId(request)
  if (customerId instanceof NextResponse) return customerId

  const { searchParams } = new URL(request.url)
  const productId = searchParams.get('product_id')
  if (!productId) {
    return NextResponse.json({ error: 'product_id requis' }, { status: 400 })
  }

  const res = await fetch(`${CATALOG_SVC_URL}/wishlist/${customerId}/${productId}`, { method: 'DELETE' })
  if (!res.ok) {
    return NextResponse.json({ error: 'Impossible de retirer des favoris' }, { status: 502 })
  }
  return NextResponse.json({ success: true })
}

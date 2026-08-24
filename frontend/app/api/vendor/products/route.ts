import { NextResponse } from 'next/server'
import { CATALOG_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// GET /api/vendor/products — uniquement les produits du vendeur connecté.
// Le filtre ?vendor_id= existe nativement sur GET /products (catalog-svc).
export async function GET(request: Request) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }
  const user = await fetchWpUser(auth.slice(7))
  if (!user?.vendor_id) return NextResponse.json({ error: 'Accès réservé aux vendeurs' }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const perPage = Math.min(parseInt(searchParams.get('per_page') || '100'), 100)
  const page = searchParams.get('page') || '1'

  const res = await fetch(
    `${CATALOG_SVC_URL}/products?vendor_id=${user.vendor_id}&page=${page}&page_size=${perPage}&lang=fr`,
    { cache: 'no-store' }
  )
  if (!res.ok) return NextResponse.json({ products: [], total: 0, userId: user.vendor_id })

  const data = await res.json()
  const products = (data.items || []).map((p: any) => ({
    id: String(p.id),
    name: p.name || '',
    slug: p.slug || '',
    price: parseFloat(p.price || '0'),
    regularPrice: parseFloat(p.regular_price || '0'),
    salePrice: p.on_sale && p.sale_price ? parseFloat(p.sale_price) : undefined,
    type: p.type || 'simple',
    image: p.image || '',
    images: (p.images || []).map((img: any) => img.src),
    status: p.status,
    vendor: { id: String(user.vendor_id) },
    currency: 'USD',
    lang: 'fr' as const,
  }))

  return NextResponse.json({ products, total: data.total || 0, userId: user.vendor_id })
}

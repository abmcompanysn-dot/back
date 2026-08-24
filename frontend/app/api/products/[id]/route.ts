import { NextResponse } from 'next/server'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')
const WOO_CK  = process.env.WOO_CONSUMER_KEY  || ''
const WOO_CS  = process.env.WOO_CONSUMER_SECRET || ''
import { requireEnv } from '@/lib/require-env'
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

function wooAuth() {
  return 'Basic ' + Buffer.from(`${WOO_CK}:${WOO_CS}`).toString('base64')
}

// PUT /api/products/[id]
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
    name, description, type,
    price, regularPrice, salePrice,
    stock, mainImageId, galleryImageIds,
    category, attributes,
  } = body

  // regularPrice/salePrice sont les champs canoniques renseignes par le
  // formulaire ; "price" n'est qu'un champ d'affichage derive cote client
  // qui n'est mis a jour que lorsque le vendeur touche le champ "Prix
  // promo" (pas "Prix regulier"). S'en servir pour deduire le prix promo
  // (ancienne logique) faisait passer l'ancien prix pour une promo des que
  // seul le prix regulier etait modifie, donc le nouveau prix ne s'affichait
  // jamais sur la boutique.
  const regular = regularPrice || price
  const sale    = salePrice || ''

  const payload: Record<string, any> = {
    name,
    description,
    type: type || 'simple',
    regular_price: String(regular),
    sale_price:    String(sale),
    manage_stock:  true,
    stock_quantity: parseInt(stock) || 0,
  }

  if (mainImageId) {
    payload.images = [
      { id: mainImageId },
      ...(galleryImageIds || []).map((id: number) => ({ id })),
    ]
  }

  if (category) payload.categories = [{ slug: category }]

  if (Array.isArray(attributes) && attributes.length > 0) {
    payload.attributes = attributes.map((a: any, i: number) => ({
      name:      a.name,
      position:  i,
      visible:   true,
      variation: type === 'variable',
      options:   a.options.split(',').flatMap((o: string) => { const t = o.trim(); return t ? [t] : [] }),
    }))
  }

  const res = await fetch(`${WOO_URL}/wp-json/wc/v3/products/${params.id}`, {
    method: 'PUT',
    headers: {
      Authorization: wooAuth(),
      'Content-Type': 'application/json',
      'X-Headless-Secret': INTERNAL_SECRET,
      'User-Agent': 'MIAD-Headless-Client',
    },
    body: JSON.stringify(payload),
  })

  const data = await res.json()
  if (!res.ok) return NextResponse.json({ error: data.message || 'Erreur WooCommerce' }, { status: res.status })
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

  const res = await fetch(`${WOO_URL}/wp-json/wc/v3/products/${params.id}?force=true`, {
    method: 'DELETE',
    headers: {
      Authorization: wooAuth(),
      'X-Headless-Secret': INTERNAL_SECRET,
      'User-Agent': 'MIAD-Headless-Client',
    },
  })

  const data = await res.json()
  if (!res.ok) return NextResponse.json({ error: data.message || 'Erreur suppression' }, { status: res.status })
  return NextResponse.json({ success: true })
}

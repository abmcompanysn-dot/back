import { NextResponse } from 'next/server'
import { WOO_URL, INTERNAL_SECRET } from '@/lib/miad-server-auth'
import { fetchWooProductsByIds } from '@/lib/woo-catalog'
import { type WooProduct, type CartItem } from '@/lib/woocommerce'

export const runtime = 'edge'

// Pont entre le lien "Récupérer mon panier" de l'email de relance
// (woocommerce-snippets/miad-cart-recovery.php) et la restauration de panier
// déjà en place côté frontend (/?cart=<id>, voir /api/cart-share et
// app/MiadMarketClient.tsx). WordPress ne connaît que product_id/quantity —
// c'est ici qu'on va chercher les vrais WooProduct (prix, image, vendeur à
// jour) avant de reconstruire un panier partageable.
function mapToWooProduct(p: any): WooProduct {
  return {
    id: String(p.id),
    name: p.name || '',
    slug: p.slug || '',
    price: parseFloat(p.price || '0'),
    regularPrice: p.regular_price ? parseFloat(p.regular_price) : undefined,
    salePrice: p.sale_price ? parseFloat(p.sale_price) : undefined,
    currency: '$',
    type: p.type,
    image: p.images?.[0]?.src || '/placeholder.svg',
    images: p.images?.map((img: any) => img.src) || [],
    category: p.categories?.[0]?.name || 'Général',
    categories: p.categories?.map((c: any) => ({ name: c.name || '', slug: c.slug || '' })) || [],
    categorySlug: p.categories?.[0]?.slug || '',
    vendor: {
      id: p.store?.id?.toString() || '',
      name: p.store?.shop_name || p.store?.store_name || p.store?.name || 'Boutique',
      slug: p.store?.shop_url?.split('/').filter(Boolean).pop() || '',
      logo: p.store?.avatar || p.store?.gravatar || '',
      country: p.store?.address?.country || '',
      countryCode: (p.store?.address?.country || '').toLowerCase(),
      rating: parseFloat(p.store?.rating || '0'),
      verified: !!p.store?.verified,
      productCount: p.store?.product_count || 0,
    },
    country: p.store?.address?.country || '',
    countryCode: (p.store?.address?.country || '').toLowerCase(),
    stock: p.stock_quantity ?? 0,
    inStock: p.stock_status === 'instock',
    description: '',
    lang: 'fr',
    weight: p.weight,
  }
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const token = searchParams.get('token')
  const uid = searchParams.get('uid')

  if (!token || !uid) {
    return NextResponse.redirect(new URL('/', origin))
  }

  try {
    const savedRes = await fetch(
      `${WOO_URL}/wp-json/miad/v1/saved-cart-items?token=${encodeURIComponent(token)}&uid=${encodeURIComponent(uid)}`,
      { headers: { 'X-Headless-Secret': INTERNAL_SECRET, 'User-Agent': 'MIAD-Headless-Client' }, cache: 'no-store' }
    )
    const savedData = await savedRes.json().catch(() => null)
    const savedItems: { product_id: number; variation_id: number; quantity: number }[] = savedData?.items || []

    if (!savedRes.ok || savedItems.length === 0) {
      return NextResponse.redirect(new URL('/', origin))
    }

    const productIds = [...new Set(savedItems.map(i => i.product_id))]
    const rawProducts = await fetchWooProductsByIds(productIds)
    const byId = new Map(rawProducts.map((p: any) => [p.id, p]))

    const cartItems: CartItem[] = savedItems
      .map(item => {
        const raw = byId.get(item.product_id)
        if (!raw) return null
        // Prix de variation non résolu ici (nécessiterait un appel
        // supplémentaire par produit) — utilise le prix du produit parent,
        // acceptable pour une relance de panier plutôt que de bloquer toute
        // la restauration si le produit a des variations.
        return { product: mapToWooProduct(raw), quantity: item.quantity } as CartItem
      })
      .filter((i): i is CartItem => i !== null)

    if (cartItems.length === 0) {
      return NextResponse.redirect(new URL('/', origin))
    }

    const shareRes = await fetch(`${origin}/api/cart-share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: cartItems }),
    })
    const shareData = await shareRes.json().catch(() => null)
    if (!shareRes.ok || !shareData?.id) {
      return NextResponse.redirect(new URL('/', origin))
    }

    return NextResponse.redirect(new URL(`/?cart=${shareData.id}`, origin))
  } catch {
    return NextResponse.redirect(new URL('/', origin))
  }
}

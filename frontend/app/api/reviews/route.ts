import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { CATALOG_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// GET /api/reviews?product_id=123&rating=5&with_photos=true&sort=recent|top|photos&page=1
// Renvoie la liste des avis + l'en-tête (note moyenne, répartition étoiles,
// bandeau photos) de la section avis complète.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const productId = searchParams.get('product_id')
  if (!productId || !/^\d+$/.test(productId)) {
    return NextResponse.json({ reviews: [], header: null })
  }

  const qs = new URLSearchParams({ page_size: '20' })
  for (const k of ['rating', 'with_photos', 'sort', 'page']) {
    const v = searchParams.get(k)
    if (v) qs.set(k, v)
  }

  try {
    const res = await fetch(`${CATALOG_SVC_URL}/products/${productId}/reviews?${qs}`, {
      next: { revalidate: 60 },
    })
    if (!res.ok) return NextResponse.json({ reviews: [], header: null })
    const data: any = await res.json()

    const reviews = (data.items || []).map((r: any) => ({
      id: r.id,
      reviewer: r.reviewer || 'Client',
      country: r.country || '',
      avatar: r.avatar || '',
      rating: r.rating || 5,
      title: r.title || '',
      review: r.comment || '',
      photos: Array.isArray(r.photos) ? r.photos : [],
      date: r.created_at || '',
      verified: r.verified_purchase ?? false,
      isCommunity: r.is_community ?? false,
      helpfulCount: r.helpful_count ?? 0,
    }))

    return NextResponse.json(
      {
        reviews,
        header: {
          average: data.average_rating || 0,
          count: data.rating_count || 0,
          stars: data.stars || { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
          withPhotos: data.with_photos_count || 0,
          photoStrip: data.photo_strip || [],
          hasMore: data.has_more || false,
        },
      },
      { headers: { 'Cache-Control': 'public, s-maxage=60' } }
    )
  } catch {
    return NextResponse.json({ reviews: [], header: null })
  }
}

// POST /api/reviews
// Avis produit — RÉSERVÉ aux acheteurs vérifiés (compte connecté +
// order_id d'une commande livrée contenant le produit). Le backend
// (catalog-svc) refait la vérification via order-svc.
export async function POST(req: Request) {
  const h = await headers()
  const user = await fetchWpUser(h.get('authorization') || h.get('cookie') || '')
  if (!user?.sub) {
    return NextResponse.json(
      { success: false, message: 'Connectez-vous pour laisser un avis.' },
      { status: 401 }
    )
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, message: 'Corps JSON invalide.' }, { status: 400 })
  }

  const { product_id, order_id, rating, title, review, photos, country } = body
  if (!product_id || typeof product_id !== 'number') {
    return NextResponse.json({ success: false, message: 'product_id manquant.' }, { status: 400 })
  }
  if (!order_id) {
    return NextResponse.json(
      { success: false, message: "Sélectionnez la commande concernée (seuls les achats livrés peuvent être notés)." },
      { status: 400 }
    )
  }
  if (!rating || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
    return NextResponse.json({ success: false, message: 'Note invalide (1–5).' }, { status: 400 })
  }
  if (!review || typeof review !== 'string' || review.trim().length < 10) {
    return NextResponse.json({ success: false, message: 'Avis trop court (10 caractères min).' }, { status: 400 })
  }
  if (review.trim().length > 1500) {
    return NextResponse.json({ success: false, message: 'Avis trop long (1500 caractères max).' }, { status: 400 })
  }

  const cleanPhotos = (Array.isArray(photos) ? photos : [])
    .filter((p: any) => typeof p === 'string' && /^https?:\/\//.test(p))
    .slice(0, 6)

  try {
    const res = await fetch(`${CATALOG_SVC_URL}/products/${product_id}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: Number(user.sub),
        order_id: Number(order_id),
        rating,
        title: (title || '').trim().replace(/<[^>]*>/g, '').slice(0, 120),
        comment: review.trim().replace(/<[^>]*>/g, ''),
        photos: cleanPhotos,
        country: (country || (user as any).country || '').toString().toUpperCase().slice(0, 2),
        avatar: (user as any).avatar || '',
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return NextResponse.json(
        { success: false, message: data?.error?.message || 'Erreur serveur.' },
        { status: res.status }
      )
    }
    return NextResponse.json({
      success: true,
      pending: data.pending ?? false,
      message: data.pending
        ? "Votre avis a été reçu et sera publié après une vérification rapide."
        : "Merci ! Votre avis est publié.",
    })
  } catch {
    return NextResponse.json(
      { success: false, message: 'Impossible de joindre le serveur.' },
      { status: 500 }
    )
  }
}

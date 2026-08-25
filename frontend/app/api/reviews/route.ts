import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { CATALOG_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

// Simple in-memory rate limiter: max 3 reviews per IP per hour
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 3
const RATE_WINDOW_MS = 60 * 60 * 1000

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return false
  }
  if (entry.count >= RATE_LIMIT) return true
  entry.count++
  return false
}

// GET /api/reviews?product_id=123
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const productId = searchParams.get('product_id')
  if (!productId || !/^\d+$/.test(productId)) {
    return NextResponse.json({ reviews: [] })
  }

  try {
    const res = await fetch(`${CATALOG_SVC_URL}/products/${productId}/reviews?page_size=20`, {
      next: { revalidate: 120 },
    })
    if (!res.ok) return NextResponse.json({ reviews: [] })
    const data: any = await res.json()

    const reviews = (data.items || []).map((r: any) => ({
      id: r.id,
      reviewer: r.reviewer || 'Client',
      rating: r.rating || 5,
      review: r.comment || '',
      date: r.created_at || '',
      verified: r.verified_purchase ?? false,
    }))

    return NextResponse.json({ reviews }, { headers: { 'Cache-Control': 'public, s-maxage=120' } })
  } catch {
    return NextResponse.json({ reviews: [] })
  }
}

// POST /api/reviews
export async function POST(req: Request) {
  const headersList = await headers()
  const ip =
    headersList.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    headersList.get('x-real-ip') ||
    'unknown'

  if (isRateLimited(ip)) {
    return NextResponse.json(
      { success: false, message: 'Trop de tentatives. Réessayez dans une heure.' },
      { status: 429 }
    )
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, message: 'Corps JSON invalide.' }, { status: 400 })
  }

  const { product_id, rating, review, reviewer, reviewer_email } = body

  if (!product_id || typeof product_id !== 'number') {
    return NextResponse.json({ success: false, message: 'product_id manquant.' }, { status: 400 })
  }
  if (!rating || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
    return NextResponse.json({ success: false, message: 'Note invalide (1–5).' }, { status: 400 })
  }
  if (!review || typeof review !== 'string' || review.trim().length < 10) {
    return NextResponse.json({ success: false, message: 'Avis trop court (10 caractères min).' }, { status: 400 })
  }
  if (review.trim().length > 1000) {
    return NextResponse.json({ success: false, message: 'Avis trop long (1000 caractères max).' }, { status: 400 })
  }
  if (!reviewer || typeof reviewer !== 'string' || reviewer.trim().length < 2) {
    return NextResponse.json({ success: false, message: 'Nom requis.' }, { status: 400 })
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!reviewer_email || !emailRegex.test(reviewer_email)) {
    return NextResponse.json({ success: false, message: 'Email invalide.' }, { status: 400 })
  }

  const cleanReview = review.trim().replace(/<[^>]*>/g, '')
  const cleanName = reviewer.trim().replace(/<[^>]*>/g, '').slice(0, 100)
  const cleanEmail = reviewer_email.trim().slice(0, 200)

  try {
    const res = await fetch(`${CATALOG_SVC_URL}/products/${product_id}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guest_name: cleanName,
        guest_email: cleanEmail,
        rating,
        comment: cleanReview,
      }),
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      return NextResponse.json({ success: false, message: data?.error?.message || 'Erreur serveur.' }, { status: res.status })
    }

    return NextResponse.json({
      success: true,
      message: 'Votre avis a été soumis et sera publié après validation.',
    })
  } catch {
    return NextResponse.json(
      { success: false, message: 'Impossible de joindre le serveur.' },
      { status: 500 }
    )
  }
}

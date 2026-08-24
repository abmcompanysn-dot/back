import { NextResponse } from 'next/server'
import { headers } from 'next/headers'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')
const WOO_CK = process.env.WOO_CONSUMER_KEY || ''
const WOO_CS = process.env.WOO_CONSUMER_SECRET || ''

const wooAuth = () =>
  'Basic ' + Buffer.from(`${WOO_CK}:${WOO_CS}`).toString('base64')

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
    const url = `${WOO_URL}/wp-json/wc/v3/products/reviews?product=${productId}&per_page=20&status=approved`
    const res = await fetch(url, {
      headers: { Authorization: wooAuth(), Accept: 'application/json' },
      next: { revalidate: 120 },
    })
    if (!res.ok) return NextResponse.json({ reviews: [] })
    const raw: any[] = await res.json()

    const reviews = raw.map((r) => ({
      id: r.id,
      reviewer: r.reviewer || 'Client',
      rating: r.rating || 5,
      review: r.review?.replace(/<[^>]*>/g, '') || '',
      date: r.date_created || '',
      verified: r.verified ?? false,
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

  // Validation stricte
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

  // Sanitize: strip HTML tags from text fields
  const cleanReview = review.trim().replace(/<[^>]*>/g, '')
  const cleanName = reviewer.trim().replace(/<[^>]*>/g, '').slice(0, 100)
  const cleanEmail = reviewer_email.trim().slice(0, 200)

  try {
    const res = await fetch(`${WOO_URL}/wp-json/wc/v3/products/reviews`, {
      method: 'POST',
      headers: {
        Authorization: wooAuth(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        product_id,
        rating,
        review: cleanReview,
        reviewer: cleanName,
        reviewer_email: cleanEmail,
        status: 'hold', // pending moderation by default
      }),
    })

    const data = await res.json()

    if (!res.ok) {
      const msg = data?.message || 'Erreur WooCommerce.'
      return NextResponse.json({ success: false, message: msg }, { status: res.status })
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

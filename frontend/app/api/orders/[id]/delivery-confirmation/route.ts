import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { CATALOG_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// POST /api/orders/[id]/delivery-confirmation
// L'acheteur confirme la réception, note la livraison (1-5) et peut
// joindre une photo du colis. body: { delivery_rating, comment?, photos?, country? }
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const h = await headers()
  const user = await fetchWpUser(h.get('authorization') || h.get('cookie') || '')
  if (!user?.sub) {
    return NextResponse.json({ success: false, message: 'Connexion requise.' }, { status: 401 })
  }
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, message: 'JSON invalide.' }, { status: 400 })
  }
  const rating = Number(body?.delivery_rating)
  if (!rating || rating < 1 || rating > 5) {
    return NextResponse.json({ success: false, message: 'Note de livraison (1-5) requise.' }, { status: 400 })
  }
  const photos = (Array.isArray(body?.photos) ? body.photos : [])
    .filter((p: any) => typeof p === 'string' && /^https?:\/\//.test(p))
    .slice(0, 4)

  try {
    const res = await fetch(`${CATALOG_SVC_URL}/orders/${id}/delivery-confirmation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: Number(user.sub),
        delivery_rating: rating,
        comment: (body?.comment || '').toString().trim().replace(/<[^>]*>/g, '').slice(0, 1000),
        photos,
        country: (body?.country || (user as any).country || '').toString().toUpperCase().slice(0, 2),
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
      message: 'Merci ! Réception confirmée.',
    })
  } catch {
    return NextResponse.json({ success: false, message: 'Serveur injoignable.' }, { status: 500 })
  }
}

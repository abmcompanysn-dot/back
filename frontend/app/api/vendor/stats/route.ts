import { NextResponse } from 'next/server'
import { VENDOR_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// Même donnée que /api/vendor/dashboard (GET /vendor/{id}/dashboard côté
// vendor-svc) — gardé comme route distincte pour ne pas casser les
// appelants existants, reformaté dans l'ancien format de champs attendu.
export async function GET(request: Request) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }
  const user = await fetchWpUser(auth.slice(7))
  if (!user?.vendor_id) return NextResponse.json({ error: 'Accès réservé aux vendeurs' }, { status: 403 })

  const res = await fetch(`${VENDOR_SVC_URL}/vendor/${user.vendor_id}/dashboard`, { cache: 'no-store' })
  if (!res.ok) return NextResponse.json({ error: 'Erreur backend', userId: user.vendor_id }, { status: res.status })

  const data = await res.json()
  const byStatus = data.orders_by_status || {}
  return NextResponse.json({
    userId: user.vendor_id,
    revenue: (data.revenue_usd || 0).toFixed(2),
    orders_total: data.orders_total || 0,
    orders_pending: byStatus.pending_payment || 0,
    orders_processing: byStatus.processing || 0,
    orders_completed: byStatus.delivered || 0,
    orders_cancelled: byStatus.cancelled || 0,
    products_total: data.products_total || 0,
    products_published: data.products_total || 0,
    reviews_count: 0,
  })
}

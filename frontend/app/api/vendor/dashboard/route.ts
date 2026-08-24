import { NextResponse } from 'next/server'
import { VENDOR_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

/**
 * GET /api/vendor/dashboard — proxy vers GET /vendor/{id}/dashboard
 * (vendor-svc, agrège products_total/orders_total/revenue_usd/
 * orders_by_status depuis catalog-svc et order-svc). L'identité vendeur
 * est résolue via vendor_id dans le JWT du client connecté (voir A.10 du
 * plan de migration), jamais un id fourni par le client.
 */
export async function GET(request: Request) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }

  const user = await fetchWpUser(auth.slice(7))
  if (!user?.vendor_id) {
    return NextResponse.json({ error: 'Accès réservé aux vendeurs' }, { status: 403 })
  }

  const res = await fetch(`${VENDOR_SVC_URL}/vendor/${user.vendor_id}/dashboard`, { cache: 'no-store' })
  if (!res.ok) {
    return NextResponse.json({ error: 'Erreur backend' }, { status: res.status })
  }
  return NextResponse.json(await res.json())
}

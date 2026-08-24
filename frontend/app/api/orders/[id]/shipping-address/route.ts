import { NextResponse } from 'next/server'
import { ORDER_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

/**
 * PATCH /api/orders/[id]/shipping-address — permet au CLIENT propriétaire d'une
 * commande (pas seulement admin/représentant) de corriger son adresse de
 * livraison après l'achat, tant que la commande n'est pas encore expédiée.
 * L'{id} est un parent_order_id (commande groupée multi-boutiques) — order-svc
 * vérifie lui-même l'appartenance et le statut avant d'appliquer le changement
 * à toutes les sous-commandes du groupe.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })

  const user = await fetchWpUser(auth.slice(7))
  if (!user?.sub) return NextResponse.json({ error: 'Session invalide' }, { status: 401 })

  const [{ id }, body] = await Promise.all([params, request.json().catch(() => ({}))])
  const { shipping } = body
  if (!shipping || !shipping.address_1 || !shipping.city || !shipping.country) {
    return NextResponse.json({ error: 'Adresse incomplète (rue, ville et pays requis)' }, { status: 400 })
  }

  const res = await fetch(`${ORDER_SVC_URL}/orders/parent/${id}/shipping-address`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: user.sub, shipping_address: shipping }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    if (res.status === 403) return NextResponse.json({ error: 'Cette commande ne vous appartient pas' }, { status: 403 })
    if (res.status === 409) return NextResponse.json({ error: "Cette commande est déjà en cours d'expédition et ne peut plus être modifiée." }, { status: 409 })
    if (res.status === 404) return NextResponse.json({ error: 'Commande introuvable' }, { status: 404 })
    return NextResponse.json({ error: "Échec de la mise à jour de l'adresse", detail }, { status: 502 })
  }

  const data = await res.json().catch(() => null)
  return NextResponse.json({ success: true, shipping: data?.shipping_address || shipping })
}

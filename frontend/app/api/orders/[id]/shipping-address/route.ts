import { NextResponse } from 'next/server'
import { WOO_URL, INTERNAL_SECRET, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge';

const WOO_KEY = process.env.WOO_CONSUMER_KEY
const WOO_SECRET = process.env.WOO_CONSUMER_SECRET
const REQUEST_HEADERS = { 'X-Headless-Secret': INTERNAL_SECRET, 'User-Agent': 'MIAD-Headless-Client' }

// Statuts pour lesquels le client peut encore corriger son adresse de livraison
// (avant que la commande ne soit physiquement prise en charge / expédiée).
const EDITABLE_STATUSES = ['pending', 'processing', 'on-hold', 'miad-rep-charge']

/**
 * PATCH /api/orders/[id]/shipping-address — permet au CLIENT propriétaire d'une
 * commande (pas seulement admin/représentant) de corriger son adresse de
 * livraison après l'achat, tant que la commande n'est pas encore expédiée.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })

  const user = await fetchWpUser(auth.slice(7))
  if (!user?.id) return NextResponse.json({ error: 'Session invalide' }, { status: 401 })

  if (!WOO_KEY || !WOO_SECRET) {
    return NextResponse.json({ error: 'Configuration serveur incomplète' }, { status: 500 })
  }

  const [{ id }, body] = await Promise.all([params, request.json().catch(() => ({}))])
  const { shipping } = body
  if (!shipping || !shipping.address_1 || !shipping.city || !shipping.country) {
    return NextResponse.json({ error: 'Adresse incomplète (rue, ville et pays requis)' }, { status: 400 })
  }

  const headers = REQUEST_HEADERS

  // Sécurité : on relit la commande pour vérifier qu'elle appartient bien à
  // l'utilisateur connecté et qu'elle est encore dans un statut modifiable —
  // sinon n'importe quel client pourrait changer l'adresse de n'importe quelle
  // commande en devinant son ID.
  const orderRes = await fetch(
    `${WOO_URL}/wp-json/wc/v3/orders/${id}?consumer_key=${WOO_KEY}&consumer_secret=${WOO_SECRET}`,
    { headers, cache: 'no-store' }
  )
  if (!orderRes.ok) return NextResponse.json({ error: 'Commande introuvable' }, { status: 404 })

  const order = await orderRes.json().catch(() => null)
  if (!order || String(order.customer_id) !== String(user.id)) {
    return NextResponse.json({ error: 'Cette commande ne vous appartient pas' }, { status: 403 })
  }
  if (!EDITABLE_STATUSES.includes(order.status)) {
    return NextResponse.json({ error: 'Cette commande est déjà en cours d\'expédition et ne peut plus être modifiée.' }, { status: 409 })
  }

  const updateRes = await fetch(
    `${WOO_URL}/wp-json/wc/v3/orders/${id}?consumer_key=${WOO_KEY}&consumer_secret=${WOO_SECRET}`,
    {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipping }),
    }
  )

  if (!updateRes.ok) {
    const err = await updateRes.text().catch(() => '')
    return NextResponse.json({ error: 'Échec de la mise à jour de l\'adresse', detail: err }, { status: 502 })
  }

  const updated = await updateRes.json().catch(() => null)
  return NextResponse.json({ success: true, shipping: updated?.shipping || shipping })
}

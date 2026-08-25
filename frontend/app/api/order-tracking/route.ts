import { NextResponse } from 'next/server'

export const runtime = 'edge'

/**
 * GAP BACKEND CONNU : cette route relayait un endpoint WordPress
 * (wp-json/miad-products/v1/order-tracking) protégé par un token HMAC public
 * par commande (pas un JWT auth-svc — la personne qui consulte ce lien de
 * suivi n'a pas forcément de compte MIAD), qui agrégeait :
 *   - order_number, status, total, date, client_name, items[] (commande)
 *   - delivery_stage / stage_label (étapes de livraison "nationale" Sénégal)
 *   - shipping_method, tracking_number, dhl_status, dhl_events[] (DHL)
 *   - scan_checkpoints[] (points de passage géolocalisés, voir
 *     app/api/scan-checkpoint/route.ts pour le même gap en écriture)
 *
 * Aucun service Go n'expose de token public par commande pour ce cas
 * d'usage (order-svc n'a que des routes admin/interne, voir
 * services/order-svc/main.go — GET /orders/{id} et /orders/{id}/events
 * n'ont pas de mécanisme d'autorisation par token). Reconstituer une version
 * partielle en assemblant order-svc (statut/total) + fulfillment-svc (DHL,
 * GET /tracking/search/{number}) SANS aucune vérification d'identité serait
 * une régression de sécurité (n'importe qui devinant un order_id verrait la
 * commande de n'importe qui) — donc pas fait ici.
 *
 * Cette route renvoie explicitement { ok: false, error: ... } — le frontend
 * gère déjà ce cas proprement (voir app/suivi/[orderId]/[token]/page.tsx :
 * `if (!data.ok)` affiche "Lien de suivi invalide" plutôt que de planter).
 * Note : app/suivi/[orderId]/[token]/page.tsx appelle en réalité directement
 * l'ancienne URL WordPress en dur (pas via cette route Next.js) — il faudra
 * le corriger séparément une fois qu'un vrai mécanisme de token public
 * existera côté Go.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const orderId = searchParams.get('order_id')
  const token = searchParams.get('token')
  if (!orderId || !token) {
    return NextResponse.json({ error: 'Paramètres manquants' }, { status: 400 })
  }

  console.warn('[api/order-tracking] aucun endpoint Go ne supporte encore le suivi de commande par token public — voir le rapport de migration.')

  return NextResponse.json(
    { ok: false, error: "Le suivi de commande par lien public n'est pas encore supporté par le backend Go." },
    { status: 501 }
  )
}

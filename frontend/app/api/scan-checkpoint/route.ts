import { NextResponse } from 'next/server'

export const runtime = 'edge'

/**
 * GAP BACKEND CONNU : cette route relayait un endpoint WordPress
 * (wp-json/miad-products/v1/scan-checkpoint) qui enregistrait un point de
 * passage géolocalisé (vendeur/représentant/transporteur scannant un lien de
 * suivi), sécurisé par un token HMAC par commande
 * (miad_order_tracking_token()) — pas un JWT auth-svc classique, car la
 * personne qui scanne n'a pas forcément de compte MIAD.
 *
 * Aucun service Go n'expose l'équivalent aujourd'hui :
 *   - fulfillment-svc a bien un modèle d'événements de suivi
 *     (tracking_events / POST /tracking/{shipment_id}/event), mais
 *     addManualEvent attend une authentification admin/interne classique,
 *     pas un token public par commande, et ne gère pas de lat/lng —
 *     seulement status/description/location en texte.
 *   - shipping-svc a un statut "national" par commande
 *     (shipping-domestic/order-stage), mais pas de points de passage
 *     géolocalisés multiples ni de token public.
 *   - Aucun service ne génère/valide de token HMAC public par commande pour
 *     ce cas d'usage précis.
 *
 * Pour ne pas fabriquer un faux succès (ce qui ferait croire au
 * livreur/vendeur que le point de passage est enregistré alors qu'il ne
 * l'est nulle part), cette route renvoie explicitement une erreur 501.
 * Voir aussi app/api/order-tracking/route.ts (même gap, endpoint miroir en
 * lecture) et components/miad/ScanCheckpointButton.tsx /
 * app/suivi/[orderId]/[token]/page.tsx pour les appelants.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { orderId, token, lat, lng } = body

  if (!orderId || !token || lat === undefined || lng === undefined) {
    return NextResponse.json({ error: 'Paramètres manquants' }, { status: 400 })
  }

  console.warn('[api/scan-checkpoint] aucun endpoint Go ne supporte encore les points de passage géolocalisés par token public — voir le rapport de migration.')

  return NextResponse.json(
    { error: 'not_implemented', message: "Le suivi par points de passage n'est pas encore supporté par le backend Go." },
    { status: 501 }
  )
}

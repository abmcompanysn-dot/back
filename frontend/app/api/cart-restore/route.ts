import { NextResponse } from 'next/server'

export const runtime = 'edge'

// Pont entre le lien "Récupérer mon panier" de l'email de relance et la
// restauration de panier côté frontend (/?cart=<id>, voir /api/cart-share).
// La sauvegarde de panier abandonné (saved-cart-items, ancien endpoint
// WordPress) n'a pas encore d'équivalent côté backend Go — aucun service
// ne stocke de paniers abandonnés actuellement. Redirige vers l'accueil en
// attendant, plutôt que d'appeler un endpoint qui n'existe plus.
export async function GET(request: Request) {
  const { origin } = new URL(request.url)
  return NextResponse.redirect(new URL('/', origin))
}

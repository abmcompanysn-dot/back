import { NextResponse } from 'next/server'

export const runtime = 'edge'

// Cartes bancaires Stripe enregistrées par le client — n'a pas encore
// d'équivalent côté backend Go (payment-svc ne gère que les PaymentIntents
// à la volée, pas de stockage de moyens de paiement réutilisables).
// Erreur EXPLICITE plutôt qu'un tableau vide silencieux tant que ce n'est
// pas construit, pour ne pas laisser croire que la fonctionnalité marche.
function notImplemented() {
  return NextResponse.json(
    { error: 'Cartes enregistrées non disponibles pour le moment', code: 'not_implemented' },
    { status: 501 }
  )
}

export async function GET() {
  return notImplemented()
}

export async function DELETE() {
  return notImplemented()
}

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge'

// Emails marketing en masse (envoi unique / broadcast à une audience) —
// différé côté backend Go (voir plan de migration, A.12) : email-svc gère
// le transactionnel (POST /emails/send avec un modèle prédéfini), pas
// encore l'envoi en masse à une liste d'abonnés. Erreur EXPLICITE plutôt
// qu'un échec silencieux tant que ce n'est pas construit.
function notImplemented() {
  return NextResponse.json(
    { error: "Envoi d'emails en masse non disponible pour le moment", code: 'not_implemented' },
    { status: 501 }
  )
}

export async function GET(_request: NextRequest) {
  return notImplemented()
}

export async function POST(_request: NextRequest) {
  return notImplemented()
}

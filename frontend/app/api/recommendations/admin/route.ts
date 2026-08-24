import { NextResponse } from 'next/server'

export const runtime = 'edge'

// Statut du moteur de recommandations — différé côté backend Go (voir plan
// de migration, A.11), aucun service ne calcule de recommandations
// hors-ligne pour l'instant (lib/recommendations.ts gère déjà une
// personnalisation légère en temps réel côté edge, ceci concernait le
// recalcul par lot admin uniquement).
function notImplemented() {
  return NextResponse.json(
    { error: 'Moteur de recommandations non disponible pour le moment', code: 'not_implemented' },
    { status: 501 }
  )
}

export async function GET() {
  return notImplemented()
}

export async function POST() {
  return notImplemented()
}

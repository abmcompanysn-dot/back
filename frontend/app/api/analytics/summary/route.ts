import { NextResponse } from 'next/server'

export const runtime = 'edge'

// Analytics visiteurs différé côté backend Go (voir plan de migration,
// A.11) — aucun service ne persiste de sessions/événements pour l'instant.
// Erreur EXPLICITE plutôt qu'un échec silencieux tant que ce n'est pas
// construit.
export async function GET() {
  return NextResponse.json(
    { error: 'Analytics non disponibles pour le moment', code: 'not_implemented' },
    { status: 501 }
  )
}

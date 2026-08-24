import { NextResponse } from 'next/server'

export const runtime = 'edge'

// Emails de recommandations personnalisées en masse — différé côté backend
// Go (voir plan de migration, A.11/A.12).
export async function POST() {
  return NextResponse.json(
    { error: 'Envoi de recommandations non disponible pour le moment', code: 'not_implemented' },
    { status: 501 }
  )
}

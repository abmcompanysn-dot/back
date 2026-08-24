import { NextResponse } from 'next/server'

export const runtime = 'edge'

// Aperçu des emails de recommandations en masse — différé côté backend Go
// (voir plan de migration, A.11/A.12).
export async function GET() {
  return NextResponse.json(
    { error: 'Aperçu de recommandations non disponible pour le moment', code: 'not_implemented' },
    { status: 501 }
  )
}

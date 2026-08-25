import { NextRequest, NextResponse } from 'next/server'
import { LOYALTY_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

// loyalty-svc résout le pays exact d'abord, puis un super-rep (portée
// globale) en repli — jamais une absence de réponse silencieuse (voir
// getRepresentativeByCountry dans services/loyalty-svc/main.go). Pas
// besoin de pays par défaut ici : si aucun code pays n'est fourni ni
// déductible de l'en-tête Cloudflare, on répond simplement { found: false }
// plutôt que d'appeler l'API avec une valeur vide.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  let country = (searchParams.get('country') || '').toUpperCase()

  // Use Cloudflare country header if no explicit country
  if (!country) {
    country = request.headers.get('cf-ipcountry') || ''
  }

  if (!country) return NextResponse.json({ found: false })

  try {
    const res = await fetch(`${LOYALTY_SVC_URL}/representative/by-country/${encodeURIComponent(country)}`, {
      cache: 'no-store',
    })

    if (!res.ok) return NextResponse.json({ found: false })
    const data = await res.json()
    return NextResponse.json({ found: true, representative: data })
  } catch {
    return NextResponse.json({ found: false })
  }
}

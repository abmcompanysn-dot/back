import { NextResponse } from 'next/server'

export const runtime = 'edge'
// PAS de `dynamic = 'force-dynamic'` ici : cette route ne sert que des
// images qui changent rarement (logos/bannières vendeur) — force-dynamic
// annulait le Cache-Control ci-dessous (cf-cache-status restait DYNAMIC
// malgré l'en-tête correct), donc CHAQUE visiteur repayait le lent
// aller-retour vers l'origine WordPress (~2.3s mesurés le 2026-09-03,
// signalé par le fondateur) au lieu de profiter du cache Cloudflare Edge.

// Seul hôte autorisé — évite qu'un tiers utilise ce proxy pour relayer
// n'importe quelle URL arbitraire (SSRF).
const ALLOWED_HOST = 'api.miadmarket.com'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const target = searchParams.get('url')
  if (!target) return NextResponse.json({ error: 'url requis' }, { status: 400 })

  let targetUrl: URL
  try {
    targetUrl = new URL(target)
  } catch {
    return NextResponse.json({ error: 'url invalide' }, { status: 400 })
  }
  if (targetUrl.hostname !== ALLOWED_HOST) {
    return NextResponse.json({ error: 'hôte non autorisé' }, { status: 400 })
  }

  // On transmet le vrai User-Agent du visiteur plutôt qu'une valeur fixe :
  // le blocage anti-bot SiteGround constaté le 2026-07-13 sur ces images
  // (hébergées en direct sur l'origine WP, pas encore sur le CDN — voir
  // CLAUDE.md "Logos vendeurs Dokan") réagit au User-Agent de la requête.
  // Une requête serveur-à-serveur avec le UA d'origine passe là où le
  // navigateur du visiteur, exposé directement à l'origine, pouvait être
  // bloqué selon son propre UA.
  const visitorUA = req.headers.get('user-agent') || 'Mozilla/5.0 (compatible; MIAD-Image-Proxy)'

  const upstream = await fetch(targetUrl.toString(), {
    headers: { 'User-Agent': visitorUA, 'Accept': 'image/*' },
    next: { revalidate: 86400 },
  }).catch(() => null)

  if (!upstream || !upstream.ok) {
    return NextResponse.json({ error: 'image indisponible' }, { status: 502 })
  }

  const contentType = upstream.headers.get('content-type') || 'image/jpeg'
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000',
    },
  })
}

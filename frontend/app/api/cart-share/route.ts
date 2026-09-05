import { NextResponse } from 'next/server'
import { catalogCacheGet, catalogCacheSet } from '@/lib/catalog-cache'

export const runtime = 'edge'

// CORS restreint à kante.miadmarket.ca — ajouté le 2026-09-05 pour l'outil
// admin "Commande de test" (services/admin-svc/webui TestOrder.tsx), qui
// appelle cette route en JavaScript depuis une AUTRE origine (le
// back-office). Jamais un '*' ouvert à tout le web : cette route écrit en
// KV sans authentification, un CORS large permettrait à n'importe quel
// site tiers de fabriquer des paniers partagés arbitraires. Le POST direct
// serveur-à-serveur (TestOrder.tsx → miadmarket.ca) échouait avant ce
// correctif : le navigateur bloque le preflight OPTIONS avant même que la
// requête POST ne parte, faute d'Access-Control-Allow-Origin.
const ALLOWED_ORIGIN = 'https://kante.miadmarket.ca'

function corsHeaders(origin: string | null): HeadersInit {
  if (origin !== ALLOWED_ORIGIN) return {}
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

// Permet à un client de retrouver son panier sur un autre appareil : le panier
// est sérialisé côté serveur (Cloudflare KV) derrière un id, et le lien
// `/?cart=<id>` le restaure. No-op en `next dev` local (KV indisponible hors
// Cloudflare Pages, voir lib/catalog-cache.ts).
export async function POST(req: Request) {
  const cors = corsHeaders(req.headers.get('origin'))
  const body = await req.json().catch(() => null)
  const items = body?.items

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'items[] requis' }, { status: 400, headers: cors })
  }

  // forcedShippingUsd — ajouté le 2026-09-05 pour l'outil admin "Commande
  // de test" (services/admin-svc/webui TestOrder.tsx). Stocké AVEC le
  // panier côté serveur (jamais dans l'URL, contrairement à une première
  // tentative) : MiadMarketClient.tsx retire ?cart=<id> de l'URL dès la
  // restauration (history.replaceState), donc un paramètre porté par
  // l'URL n'aurait jamais atteint CheckoutPage. Un vrai client ne passe
  // jamais ce champ (le panier "partager mon panier" n'envoie que items).
  const forcedShippingUsd = typeof body?.forcedShippingUsd === 'number' && body.forcedShippingUsd > 0
    ? body.forcedShippingUsd
    : undefined

  const id = crypto.randomUUID()
  await catalogCacheSet(`cart-share:${id}`, { items, forcedShippingUsd })

  return NextResponse.json({ id }, { headers: cors })
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id requis' }, { status: 400 })
  }

  const cached = await catalogCacheGet<unknown[] | { items: unknown[]; forcedShippingUsd?: number }>(`cart-share:${id}`)
  if (!cached) {
    return NextResponse.json({ error: 'Panier introuvable ou expiré' }, { status: 404 })
  }

  // Repli sur l'ancien format (array direct) — un panier partagé juste
  // avant ce changement (2026-09-05, nouveau format {items, forcedShippingUsd})
  // reste lisible jusqu'à son expiration naturelle en KV.
  if (Array.isArray(cached.data)) {
    return NextResponse.json({ items: cached.data })
  }
  return NextResponse.json({ items: cached.data.items, forcedShippingUsd: cached.data.forcedShippingUsd })
}

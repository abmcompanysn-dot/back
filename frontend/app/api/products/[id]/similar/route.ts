import { NextResponse } from 'next/server'
import { getCloudflareBindings } from '@/lib/cloudflare-ai'

export const runtime = 'edge';

// "Produits similaires" — nearest-neighbors du vecteur déjà stocké pour ce
// produit dans Vectorize (pas besoin de ré-embedder une requête). Renvoie
// uniquement les IDs classés par similarité : le frontend récupère les
// fiches complètes via /api/products?id=X (même mapping riche que le reste
// du site — vendor, images, description... — plutôt qu'une 2e forme de
// produit réduite qui désynchroniserait ProductCard). No-op (liste vide) si
// les bindings sont indisponibles ou si le produit n'a pas encore été
// synchronisé (voir node scripts/miad.mjs sync-embeddings).
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const productId = params.id
  const { searchParams } = new URL(req.url)
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '8') || 8, 1), 12)

  const bindings = await getCloudflareBindings()
  if (!bindings) {
    return NextResponse.json({ ids: [] })
  }

  try {
    const existing = await bindings.vectorize.getByIds([productId])
    if (!existing.length) return NextResponse.json({ ids: [] })

    const result = await bindings.vectorize.query(existing[0].values, { topK: limit + 1, returnMetadata: 'none' })
    const ids = result.matches.flatMap(m => m.id !== productId ? [m.id] : []).slice(0, limit)

    return NextResponse.json({ ids }, {
      headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800' },
    })
  } catch (e: any) {
    return NextResponse.json({ ids: [], error: e.message })
  }
}

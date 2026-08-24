import { NextResponse } from 'next/server'
import { hasWooCredentials, searchWooProducts, fetchWooProductsByIds, mapWooProduct } from '@/lib/woo-catalog'
import { getCloudflareBindings, embedOne } from '@/lib/cloudflare-ai'

export const runtime = 'edge'

// Suggestions "as you type" pour la barre de recherche — recherche mot-clé
// WooCommerce (rapide, quelques dizaines de ms) complétée par la recherche
// sémantique (Vectorize) en parallèle, pas en séquence, pour ne pas cumuler
// les deux latences. Initialement volontairement gardée mot-clé seule (un
// appel Workers AI à chaque frappe semblait too much) — mais sans elle, taper
// "chaussure" ne suggérait jamais "Babouches artisanales" ou "Mocassins",
// qui ne contiennent jamais ce mot (signalé le 2026-07-31, même bug que sur
// la recherche principale déjà corrigé). Best-effort : si les bindings
// Cloudflare AI sont indisponibles (dev local) ou que l'appel échoue, se
// comporte exactement comme avant (mot-clé seul).
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') || '').trim()
  const lang = searchParams.get('lang') === 'en' ? 'en' : 'fr'
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 6, 1), 10)

  if (q.length < 2 || !hasWooCredentials()) {
    return NextResponse.json({ products: [] })
  }

  const [rawKeyword, semanticProducts] = await Promise.all([
    searchWooProducts(q, limit),
    fetchSemanticSuggestions(q, lang, limit),
  ])

  const products = rawKeyword.slice(0, limit).map(mapWooProduct)
  const seen = new Set(products.map(p => String(p.id)))
  for (const p of semanticProducts) {
    if (products.length >= limit) break
    if (seen.has(String(p.id))) continue
    seen.add(String(p.id))
    products.push(p)
  }

  return NextResponse.json({ products })
}

async function fetchSemanticSuggestions(q: string, lang: 'fr' | 'en', limit: number) {
  try {
    const bindings = await getCloudflareBindings()
    if (!bindings) return []
    const vector = await embedOne(bindings.ai, q)
    const result = await bindings.vectorize.query(vector, { topK: limit * 2, returnMetadata: 'none' })
    if (!result.matches.length) return []
    const raw = await fetchWooProductsByIds(result.matches.map(m => m.id), lang)
    return raw.map(mapWooProduct)
  } catch {
    return []
  }
}

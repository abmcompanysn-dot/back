import { NextResponse } from 'next/server'
import { getCloudflareBindings, embedOne } from '@/lib/cloudflare-ai'
import { fetchWooProductsByIds, mapWooProduct } from '@/lib/woo-catalog'

export const runtime = 'edge';

// Recherche sémantique : embed la requête, interroge Vectorize, récupère les
// fiches produit correspondantes sur le vrai catalogue. Renvoie semantic:false
// (sans erreur) si les bindings sont indisponibles (local dev) — à charge de
// l'appelant de retomber sur une recherche mot-clé classique dans ce cas.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')?.trim() || ''
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '8') || 8, 1), 20)
  const category = searchParams.get('category')?.toLowerCase() || undefined
  const country = searchParams.get('country')?.toLowerCase() || undefined
  const lang = searchParams.get('lang') === 'en' ? 'en' : 'fr'

  if (!q) return NextResponse.json({ products: [], semantic: false })

  const bindings = await getCloudflareBindings()
  if (!bindings) {
    return NextResponse.json({ products: [], semantic: false })
  }

  try {
    const vector = await embedOne(bindings.ai, q)
    const result = await bindings.vectorize.query(vector, { topK: limit * 4, returnMetadata: 'indexed' })

    let matches = result.matches
    if (category) {
      matches = matches.filter(m => String(m.metadata?.categorySlug ?? '').includes(category) || String(m.metadata?.category ?? '').toLowerCase().includes(category))
    }
    if (country) {
      matches = matches.filter(m => String(m.metadata?.countryCode ?? '') === country)
    }
    matches = matches.slice(0, limit)

    if (!matches.length) return NextResponse.json({ products: [], semantic: true })

    const ids = matches.map(m => m.id)
    const rawProducts = await fetchWooProductsByIds(ids, lang)
    const order = new Map(ids.map((id, i) => [id, i]))
    rawProducts.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0))

    return NextResponse.json({
      products: rawProducts.map(mapWooProduct),
      semantic: true,
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=300' },
    })
  } catch (e: any) {
    return NextResponse.json({ products: [], semantic: false, error: e.message })
  }
}

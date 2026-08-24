import { NextResponse } from 'next/server'
import { getCloudflareBindings, EMBEDDING_MODEL, type VectorizeVector } from '@/lib/cloudflare-ai'
import { hasWooCredentials, fetchAllPublishedWooProducts, fetchWooProductsByIds } from '@/lib/woo-catalog'

export const runtime = 'edge';

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET
const BATCH_SIZE = 50

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function productText(p: any): string {
  const category = p.categories?.[0]?.name || ''
  const description = stripHtml(p.short_description || p.description || '')
  return [p.name, category, description].filter(Boolean).join(' — ').slice(0, 2000)
}

// Génère les embeddings du catalogue réel et les upsert dans Vectorize.
// Appelé par `node scripts/miad.mjs sync-embeddings` (voir CLAUDE.md).
export async function POST(req: Request) {
  if (!INTERNAL_SECRET || req.headers.get('X-Internal-Secret') !== INTERNAL_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasWooCredentials()) {
    return NextResponse.json({ error: 'WOO_CONSUMER_KEY/SECRET manquants côté serveur' }, { status: 500 })
  }

  const bindings = await getCloudflareBindings()
  if (!bindings) {
    return NextResponse.json({ error: 'Bindings AI/VECTORIZE indisponibles — nécessite un déploiement Cloudflare Pages (no-op en local next dev)' }, { status: 503 })
  }
  const { ai, vectorize } = bindings

  const body = await req.json().catch(() => ({} as any))
  const ids: number[] = Array.isArray(body.productIds) ? body.productIds.flatMap((x: any) => { const n = Number(x); return n ? [n] : [] }) : []
  const all = body.all === true

  let products: any[]
  try {
    products = all ? await fetchAllPublishedWooProducts() : await fetchWooProductsByIds(ids)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 })
  }

  if (!products.length) {
    return NextResponse.json({ synced: 0, total: 0, message: 'Aucun produit trouvé' })
  }

  let synced = 0
  const errors: { id: number; error: string }[] = []

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE)
    try {
      const texts = batch.map(productText)
      const embeddingRes = await ai.run(EMBEDDING_MODEL, { text: texts })
      const vectors: VectorizeVector[] = batch.map((p, idx) => ({
        id: String(p.id),
        values: embeddingRes.data[idx],
        metadata: {
          category: p.categories?.[0]?.name || '',
          categorySlug: p.categories?.[0]?.slug || '',
          vendorSlug: p.store?.shop_url?.split('/').filter(Boolean).pop() || '',
          countryCode: (p.store?.address?.country || '').toLowerCase(),
          price: parseFloat(p.price || '0'),
        },
      }))
      await vectorize.upsert(vectors)
      synced += vectors.length
    } catch (e: any) {
      for (const p of batch) errors.push({ id: p.id, error: e.message })
    }
  }

  return NextResponse.json({ synced, total: products.length, errors })
}

import { NextResponse } from 'next/server'
import { getCloudflareBindings, EMBEDDING_MODEL, type VectorizeVector } from '@/lib/cloudflare-ai'
import { fetchAllPublishedWooProducts, fetchWooProductsByIds } from '@/lib/woo-catalog'
import { CATALOG_SVC_URL, VENDOR_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET
const BATCH_SIZE = 50

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function productText(p: any): string {
  const description = stripHtml(p.description || '')
  return [p.name, description].filter(Boolean).join(' — ').slice(0, 2000)
}

// Génère les embeddings du catalogue réel et les upsert dans Vectorize.
// Appelé par `node scripts/miad.mjs sync-embeddings` (voir CLAUDE.md).
export async function POST(req: Request) {
  if (!INTERNAL_SECRET || req.headers.get('X-Internal-Secret') !== INTERNAL_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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

  // search/semantic filtre les résultats Vectorize par categorySlug/countryCode
  // dans les métadonnées — catalog-svc ne renvoie que category_id/vendor_id
  // (champs plats), donc on résout ici categorySlug (catégories fr) et
  // countryCode (via vendor-svc) une seule fois pour tout le lot plutôt que
  // par produit.
  const [catRes, storesRes] = await Promise.all([
    fetch(`${CATALOG_SVC_URL}/categories?lang=fr`, { cache: 'no-store' }).catch(() => null),
    fetch(`${VENDOR_SVC_URL}/stores?page_size=100`, { cache: 'no-store' }).catch(() => null),
  ])
  const categorySlugById: Record<string, string> = {}
  if (catRes?.ok) {
    const catData: any = await catRes.json().catch(() => ({}))
    for (const c of (catData.items || catData.categories || [])) categorySlugById[String(c.id)] = c.slug || ''
  }
  const countryByVendorId: Record<string, string> = {}
  if (storesRes?.ok) {
    const storesData: any = await storesRes.json().catch(() => ({}))
    for (const s of (storesData.items || storesData.stores || [])) countryByVendorId[String(s.id)] = (s.country || '').toLowerCase()
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
          categorySlug: categorySlugById[String(p.category_id)] || '',
          countryCode: countryByVendorId[String(p.vendor_id)] || '',
          price: parseFloat(p.price || p.price_usd || '0'),
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

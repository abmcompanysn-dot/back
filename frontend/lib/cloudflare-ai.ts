/**
 * Accès aux bindings Cloudflare Pages (Workers AI + Vectorize) — no-op en
 * dehors de l'environnement Cloudflare Pages réel (ex: `next dev` local),
 * même principe que lib/catalog-cache.ts pour CATALOG_KV.
 */

// bge-m3 : multilingue (100+ langues, dont le français) — le catalogue MIAD
// est rédigé en français, un modèle "-en-" (bge-base-en-v1.5) donnerait de
// moins bons résultats de similarité sémantique. Vecteurs 1024 dims (index
// Vectorize "miad-products" dimensionné en conséquence).
export const EMBEDDING_MODEL = '@cf/baai/bge-m3'

export interface AiBinding {
  run(model: string, input: { text: string[] }): Promise<{ data: number[][] }>
}

export interface VectorizeMatch {
  id: string
  score: number
  metadata?: Record<string, string | number | boolean>
}

export interface VectorizeVector {
  id: string
  values: number[]
  metadata?: Record<string, string | number | boolean>
}

export interface VectorizeBinding {
  upsert(vectors: VectorizeVector[]): Promise<{ mutationId: string }>
  query(vector: number[], opts?: { topK?: number; returnMetadata?: 'none' | 'indexed' | 'all'; filter?: Record<string, unknown> }): Promise<{ matches: VectorizeMatch[] }>
  getByIds(ids: string[]): Promise<VectorizeVector[]>
}

export async function getCloudflareBindings(): Promise<{ ai: AiBinding; vectorize: VectorizeBinding } | null> {
  try {
    const { getRequestContext } = await import('@cloudflare/next-on-pages')
    const env = getRequestContext().env as Record<string, unknown>
    const ai = env?.AI as AiBinding | undefined
    const vectorize = env?.VECTORIZE as VectorizeBinding | undefined
    if (!ai || !vectorize) return null
    return { ai, vectorize }
  } catch {
    return null
  }
}

export async function embedOne(ai: AiBinding, text: string): Promise<number[]> {
  const res = await ai.run(EMBEDDING_MODEL, { text: [text] })
  return res.data[0]
}

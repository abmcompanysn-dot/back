/**
 * Cache de secours pour le catalogue (produits/boutiques), stocké dans Cloudflare KV.
 * Écriture systématique à chaque réponse WooCommerce réussie ("write-through"), lecture
 * uniquement quand WordPress est inaccessible — permet au site de continuer à afficher
 * le catalogue (déjà visité) même si api.miadmarket.com tombe complètement.
 *
 * Ne fait rien (no-op) en dehors de l'environnement Cloudflare Pages (ex: `next dev` local).
 */

interface KVNamespaceLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

async function getCatalogKv(): Promise<KVNamespaceLike | null> {
  try {
    // Import dynamique pour ne jamais casser `next dev` (où ce module n'a pas de contexte Cloudflare).
    const { getRequestContext } = await import('@cloudflare/next-on-pages')
    const env = getRequestContext().env as Record<string, unknown>
    return (env?.CATALOG_KV as KVNamespaceLike) || null
  } catch {
    return null
  }
}

// 30 jours : largement suffisant pour couvrir n'importe quelle panne WordPress réaliste,
// tout en évitant de servir indéfiniment des données obsolètes si une clé n'est plus jamais réécrite.
const FALLBACK_TTL_SECONDS = 60 * 60 * 24 * 30

export async function catalogCacheSet(key: string, data: unknown): Promise<void> {
  const kv = await getCatalogKv()
  if (!kv) return
  try {
    await kv.put(key, JSON.stringify({ data, savedAt: Date.now() }), { expirationTtl: FALLBACK_TTL_SECONDS })
  } catch {
    // Le cache de secours est un bonus, jamais bloquant pour la réponse normale.
  }
}

export async function catalogCacheGet<T>(key: string): Promise<{ data: T; savedAt: number } | null> {
  const kv = await getCatalogKv()
  if (!kv) return null
  try {
    const raw = await kv.get(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

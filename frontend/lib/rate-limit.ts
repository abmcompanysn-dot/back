/**
 * Rate limiter in-memory pour les API routes Next.js (edge runtime).
 * Basé sur une sliding window simple par clé (IP + endpoint).
 *
 * NOTE: en environnement edge distribué (Cloudflare Workers), chaque isolate
 * peut avoir sa propre mémoire — cette limite n'est donc pas strictement
 * globale. Suffisant comme garde-fou basique ; pour une limite stricte à
 * l'échelle du réseau, migrer vers Cloudflare KV ou Durable Objects.
 *
 * `setInterval` au niveau module est interdit dans les Workers Cloudflare
 * (« Disallowed operation called within global scope ») — le nettoyage des
 * entrées expirées se fait donc à la volée, à chaque appel.
 */

interface Entry { count: number; resetAt: number }

const store = new Map<string, Entry>()

let opsSinceCleanup = 0
function maybeCleanup() {
  if (++opsSinceCleanup < 500) return
  opsSinceCleanup = 0
  const now = Date.now()
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key)
  }
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number   // timestamp ms
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  maybeCleanup()
  const now = Date.now()
  const entry = store.get(key)

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: limit - 1, resetAt: now + windowMs }
  }

  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt }
  }

  entry.count++
  return { allowed: true, remaining: limit - entry.count, resetAt: entry.resetAt }
}

/** Extrait l'IP réelle depuis les headers Next.js */
export function getIp(request: Request): string {
  const fwd = (request as any).headers?.get?.('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return 'unknown'
}

/** Réponse 429 prête à retourner */
export function tooManyRequests(resetAt: number) {
  const retryAfter = Math.ceil((resetAt - Date.now()) / 1000)
  return new Response(
    JSON.stringify({ error: 'Trop de tentatives. Réessayez dans quelques instants.' }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        'X-RateLimit-Reset': String(Math.ceil(resetAt / 1000)),
      },
    }
  )
}

const CDN_HOST = 'cdn.miadmarket.com'
const WP_ORIGIN_HOST = 'api.miadmarket.com'

/**
 * Fait passer les images encore hébergées directement sur l'origine WordPress
 * (typiquement les logos/bannières vendeur Dokan, volontairement pas migrés
 * vers le CDN — voir CLAUDE.md) par notre propre proxy serveur au lieu de
 * laisser le navigateur du visiteur les requêter directement. Constaté le
 * 2026-07-13 : ces requêtes directes déclenchent parfois le blocage anti-bot
 * SiteGround (403) selon le User-Agent du visiteur. Laisse intactes toutes
 * les autres origines (CDN, gravatar, placeholders...).
 */
export function proxyIfLocalWp(url: string | undefined | null): string | undefined {
  if (!url || !url.includes(WP_ORIGIN_HOST)) return url ?? undefined
  return `/api/image-proxy?url=${encodeURIComponent(url)}`
}

/**
 * Réécrit une URL d'image du CDN R2 vers sa miniature déjà générée par le
 * pipeline de sync (`miad.mjs sync` / sync-product-images), au lieu de
 * servir l'image originale en pleine résolution pour une carte produit de
 * ~110-220px. Suit la convention de nommage WordPress standard
 * (`nom-WIDTHxHEIGHT.ext` avant l'extension) — vérifié en direct sur le CDN :
 * les tailles 150x150/300x300 existent pour les produits déjà synchronisés.
 *
 * Ne touche qu'aux URLs du CDN R2 — laisse intactes les images d'autres
 * origines (placeholder, logos locaux, gravatar Dokan, drapeaux) qui n'ont
 * pas ce pipeline. Toutes les images ne sont pas garanties d'avoir cette
 * miniature (produits jamais synchronisés) : voir LazyImage.tsx, qui
 * retente automatiquement l'originale si la miniature renvoie une 404.
 */
export function getThumbnailUrl(url: string | undefined | null, size: '150x150' | '300x300' = '300x300'): string | undefined {
  if (!url || !url.includes(CDN_HOST)) return url ?? undefined
  const lastDot = url.lastIndexOf('.')
  if (lastDot <= url.lastIndexOf('/')) return url // pas d'extension identifiable
  return `${url.slice(0, lastDot)}-${size}${url.slice(lastDot)}`
}

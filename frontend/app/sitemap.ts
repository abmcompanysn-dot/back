import { MetadataRoute } from 'next'

const BASE   = (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.miadmarket.com').replace(/\/$/, '')
const WOO    = (process.env.NEXT_PUBLIC_WOO_URL  || 'https://api.miadmarket.com').replace(/\/$/, '')
const WOO_CK = process.env.WOO_CONSUMER_KEY    || ''
const WOO_CS = process.env.WOO_CONSUMER_SECRET || ''

async function fetchAll<T>(endpoint: string, params: Record<string, string> = {}): Promise<T[]> {
  const results: T[] = []
  let page = 1
  const PER_PAGE = 100

  while (true) {
    try {
      // Auth par paramètres d'URL uniquement — envoyer en même temps un header
      // Authorization: Basic ET consumer_key/secret en query fait échouer la
      // requête WooCommerce (double authentification rejetée par le serveur).
      const q = new URLSearchParams({
        per_page: String(PER_PAGE), page: String(page),
        consumer_key: WOO_CK, consumer_secret: WOO_CS,
        ...params,
      })
      const res = await fetch(`${WOO}/wp-json/${endpoint}?${q}`, {
        headers: { 'User-Agent': 'MIAD-Headless-Client' },
        next: { revalidate: 3600 },
      })
      if (!res.ok) break
      const data: T[] = await res.json()
      if (!Array.isArray(data) || data.length === 0) break  
      results.push(...data)
      if (data.length < PER_PAGE) break
      page++
    } catch {
      break
    }
  }
  return results
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()

  // ── Pages statiques publiques uniquement ──────────────────────────────────
  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE,                 lastModified: now, changeFrequency: 'daily',   priority: 1.0 },
    { url: `${BASE}/promotions`, lastModified: now, changeFrequency: 'daily',   priority: 0.9 },
    { url: `${BASE}/coins`,      lastModified: now, changeFrequency: 'weekly',  priority: 0.7 },
    { url: `${BASE}/helpcenter`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
  ]

  // ── Produits ───────────────────────────────────────────────────────────────
  let productEntries: MetadataRoute.Sitemap = []
  try {
    const products = await fetchAll<{ id: number; slug: string; date_modified?: string }>(
      'wc/v3/products',
      { status: 'publish', _fields: 'id,slug,date_modified' }
    )
    productEntries = products.flatMap(p => p.slug ? [{
      url:             `${BASE}/product/${p.slug}`,
      lastModified:    p.date_modified ? new Date(p.date_modified) : now,
      changeFrequency: 'weekly' as const,
      priority:        0.8,
    }] : [])
  } catch (err) {
    console.error('[sitemap] échec récupération', err)
  }

  // ── Boutiques vendeurs ─────────────────────────────────────────────────────
  // L'API Dokan ne renvoie pas de champ "slug" direct — il faut l'extraire de
  // shop_url (ex: "https://api.miadmarket.com/store/bio-kya/" → "bio-kya").
  // Sans cette extraction, .filter(s => s.slug) était toujours vide et aucune
  // des boutiques n'apparaissait dans le sitemap.
  let vendorEntries: MetadataRoute.Sitemap = []
  try {
    const stores = await fetchAll<{ id: number; shop_url?: string; store_name?: string }>(
      'dokan/v1/stores',
      { status: 'approved' }
    )
    vendorEntries = stores.flatMap(s => {
      const slug = s.shop_url?.split('/').filter(Boolean).pop() || ''
      if (!slug) return []
      return [{
        url:             `${BASE}/vendor/${slug}`,
        lastModified:    now,
        changeFrequency: 'weekly' as const,
        priority:        0.7,
      }]
    })
  } catch (err) {
    console.error('[sitemap] échec récupération', err)
  }

  // Catégories volontairement absentes du sitemap : ce sont des vues filtrées
  // de la page d'accueil (/?category=slug) qui héritent toutes du même titre/
  // description statique (pas de generateMetadata dédié) — les soumettre à
  // l'indexation crée du contenu dupliqué qui dilue le référencement de la
  // page d'accueil elle-même plutôt que d'aider.

  return [...staticPages, ...productEntries, ...vendorEntries]
}

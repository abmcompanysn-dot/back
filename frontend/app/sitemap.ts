import { MetadataRoute } from 'next'
import { CATALOG_SVC_URL, VENDOR_SVC_URL } from '@/lib/miad-server-auth'

const BASE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://miadmarket.ca').replace(/\/$/, '')

async function fetchAllCatalog<T>(url: string): Promise<T[]> {
  const results: T[] = []
  let page = 1
  const PER_PAGE = 100
  while (true) {
    try {
      const sep = url.includes('?') ? '&' : '?'
      const res = await fetch(`${url}${sep}page=${page}&page_size=${PER_PAGE}`, {
        next: { revalidate: 3600 },
      })
      if (!res.ok) break
      const data: any = await res.json().catch(() => ({}))
      const batch: T[] = data.items || []
      if (batch.length === 0) break
      results.push(...batch)
      if (!data.has_more || batch.length < PER_PAGE) break
      page++
    } catch {
      break
    }
  }
  return results
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()

  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE,                 lastModified: now, changeFrequency: 'daily',   priority: 1.0 },
    { url: `${BASE}/promotions`, lastModified: now, changeFrequency: 'daily',   priority: 0.9 },
    { url: `${BASE}/coins`,      lastModified: now, changeFrequency: 'weekly',  priority: 0.7 },
    { url: `${BASE}/helpcenter`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
  ]

  // ── Produits ───────────────────────────────────────────────────────────────
  let productEntries: MetadataRoute.Sitemap = []
  try {
    const products = await fetchAllCatalog<{ id: number; slug: string }>(
      `${CATALOG_SVC_URL}/products?lang=fr`
    )
    productEntries = products.flatMap(p => p.slug ? [{
      url:             `${BASE}/product/${p.slug}`,
      lastModified:    now, // catalog-svc n'a pas de updated_at exploitable par produit pour l'instant
      changeFrequency: 'weekly' as const,
      priority:        0.8,
    }] : [])
  } catch (err) {
    console.error('[sitemap] échec récupération produits', err)
  }

  // ── Boutiques vendeurs ─────────────────────────────────────────────────────
  let vendorEntries: MetadataRoute.Sitemap = []
  try {
    const stores = await fetchAllCatalog<{ id: number; slug?: string }>(
      `${VENDOR_SVC_URL}/stores`
    )
    vendorEntries = stores.flatMap(s => {
      if (!s.slug) return []
      return [{
        url:             `${BASE}/vendor/${s.slug}`,
        lastModified:    now,
        changeFrequency: 'weekly' as const,
        priority:        0.7,
      }]
    })
  } catch (err) {
    console.error('[sitemap] échec récupération boutiques', err)
  }

  // Catégories volontairement absentes du sitemap : ce sont des vues filtrées
  // de la page d'accueil qui héritent toutes du même titre/description
  // statique — les soumettre à l'indexation dilue le référencement de la
  // page d'accueil elle-même plutôt que d'aider.

  return [...staticPages, ...productEntries, ...vendorEntries]
}

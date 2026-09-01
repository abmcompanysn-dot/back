import { MetadataRoute } from 'next'
import { CATALOG_SVC_URL, VENDOR_SVC_URL } from '@/lib/miad-server-auth'

// hreflang FR/EN pour chaque entrée du sitemap (le site est bilingue,
// ?lang=en bascule l'interface).
function altLangs(url: string) {
  return {
    languages: {
      fr: url,
      en: `${url}${url.includes('?') ? '&' : '?'}lang=en`,
    },
  }
}

// Généré à la demande au runtime edge, JAMAIS au build (2026-08-29) :
// - au build, CATALOG_SVC_URL/VENDOR_SVC_URL ne sont pas injectées (elles
//   n'existent qu'au runtime Cloudflare Pages) → les fetch de catalogue
//   ci-dessous restaient bloqués jusqu'au timeout de 60 s de Next, faisant
//   échouer TOUT le déploiement ("Export encountered an error on
//   /sitemap.xml/route").
// - un sitemap doit de toute façon refléter le catalogue LIVE, pas un
//   instantané figé au moment du build.
export const runtime = 'edge'
export const dynamic = 'force-dynamic'
// (pas de `revalidate` ici : incompatible avec force-dynamic. Le cache
// CDN 1 h vient des fetch internes `next: { revalidate: 3600 }` ci-dessous
// + du header Cache-Control posé par Cloudflare Pages sur la réponse.)

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
    { url: BASE,                 lastModified: now, changeFrequency: 'daily',   priority: 1.0, alternates: altLangs(BASE) },
    { url: `${BASE}/promotions`, lastModified: now, changeFrequency: 'daily',   priority: 0.9, alternates: altLangs(`${BASE}/promotions`) },
    { url: `${BASE}/coins`,      lastModified: now, changeFrequency: 'weekly',  priority: 0.7 },
    { url: `${BASE}/helpcenter`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
  ]

  // ── Catégories (routes SEO /categorie/[slug]) ─────────────────────────────
  let categoryEntries: MetadataRoute.Sitemap = []
  try {
    const catRes = await fetch(`${CATALOG_SVC_URL}/categories?lang=fr`, { next: { revalidate: 3600 } })
    if (catRes.ok) {
      const catData: any = await catRes.json().catch(() => ({}))
      const cats: any[] = catData.items || catData.categories || []
      const seen = new Set<string>()
      categoryEntries = cats.flatMap((c) => {
        const slug = String(c.slug || '').replace(/-(fr|en)$/, '')
        if (!slug || seen.has(slug)) return []
        seen.add(slug)
        const url = `${BASE}/categorie/${slug}`
        return [{
          url,
          lastModified: now,
          changeFrequency: 'daily' as const,
          priority: 0.85,
          alternates: altLangs(url),
        }]
      })
    }
  } catch (err) {
    console.error('[sitemap] échec récupération catégories', err)
  }

  // ── Produits ───────────────────────────────────────────────────────────────
  let productEntries: MetadataRoute.Sitemap = []
  try {
    const products = await fetchAllCatalog<{ id: number; slug: string }>(
      `${CATALOG_SVC_URL}/products?lang=fr`
    )
    productEntries = products.flatMap(p => {
      if (!p.slug) return []
      const url = `${BASE}/product/${p.slug}`
      return [{
        url,
        lastModified:    now, // catalog-svc n'a pas de updated_at exploitable par produit pour l'instant
        changeFrequency: 'weekly' as const,
        priority:        0.8,
        alternates:      altLangs(url),
      }]
    })
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
      const url = `${BASE}/vendor/${s.slug}`
      return [{
        url,
        lastModified:    now,
        changeFrequency: 'weekly' as const,
        priority:        0.7,
        alternates:      altLangs(url),
      }]
    })
  } catch (err) {
    console.error('[sitemap] échec récupération boutiques', err)
  }

  // Les catégories ont maintenant de vraies routes indexables
  // (/categorie/[slug], voir app/categorie/[slug]/page.tsx) avec metadata,
  // JSON-LD et fil d'Ariane propres — elles sont donc dans le sitemap.

  return [...staticPages, ...categoryEntries, ...productEntries, ...vendorEntries]
}

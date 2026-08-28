import { NextResponse } from 'next/server'
import { catalogCacheGet, catalogCacheSet } from '@/lib/catalog-cache'
import { VENDOR_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const perPage = searchParams.get('per_page') || '100'
  // slug — ajouté le 2026-08-28 : recherche ciblée d'UNE boutique par slug,
  // utilisée en secours par MiadMarketClient.tsx (v=vendor&slug=X) quand la
  // boutique n'est pas dans le lot des 100 premières déjà en mémoire côté
  // client (sinon le lien restait silencieusement sur l'accueil).
  const slug = searchParams.get('slug')
  const kvKey = `stores:per_page=${perPage}`

  try {
    const url = new URL(`${VENDOR_SVC_URL}/stores`)
    url.searchParams.set('page_size', slug ? '1' : perPage)
    if (slug) url.searchParams.set('slug', slug)
    const response = await fetch(url.toString(), {
      next: { revalidate: slug ? 300 : 3600 },
    })
    if (!response.ok) {
      throw new Error(`vendor-svc a répondu ${response.status}`)
    }

    const data = await response.json()
    const items: any[] = data.items || data.stores || []

    // Comptes vendeur jamais finalisés (inscription incomplète, aucun nom de
    // boutique renseigné) — ne doivent pas apparaître comme "boutiques" sur
    // le site public.
    const stores = items.flatMap((s: any) => {
      const name = s.store_name || s.name
      if (!name || name.trim() === '') return []
      return [
        {
          id: s.id?.toString() || null,
          name,
          slug: s.slug || '',
          logo: s.gravatar || s.logo_url || '',
          banner: s.banner || s.banner_url || '',
          country: s.country || '',
          countryCode: s.country || '',
          rating: parseFloat(s.rating_avg || '0'),
          verified: !!s.enabled,
          productCount: s.products_count || s.product_count || 0,
        },
      ]
    })

    // Cache KV de secours réservé à la liste complète — un résultat filtré
    // par slug (1 boutique) ne doit jamais écraser ce cache global.
    if (!slug) await catalogCacheSet(kvKey, { stores })

    return NextResponse.json(
      { stores },
      {
        headers: {
          'Cache-Control': slug ? 'public, s-maxage=300' : 'public, s-maxage=300, stale-while-revalidate=31536000',
        },
      }
    )
  } catch (error: any) {
    console.error('[Route API Stores] Erreur:', error)

    if (slug) {
      return NextResponse.json({ stores: [], error: 'Service indisponible' }, { status: 500 })
    }

    // Backend injoignable : on tente de servir la dernière liste de
    // boutiques connue depuis le cache de secours KV plutôt que de
    // renvoyer un tableau vide.
    const fallback = await catalogCacheGet<{ stores: any[] }>(kvKey)
    if (fallback) {
      return NextResponse.json(fallback.data, {
        headers: {
          'Cache-Control': 'public, s-maxage=60',
          'X-Miad-Catalog-Source': 'kv-fallback',
          'X-Miad-Catalog-Saved-At': new Date(fallback.savedAt).toISOString(),
        },
      })
    }

    return NextResponse.json({ stores: [], error: 'Service indisponible' }, { status: 500 })
  }
}

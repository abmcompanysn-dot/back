import { NextResponse } from 'next/server'
import { WooCategory } from '@/lib/woocommerce'
import { decodeHtmlEntities } from '@/lib/utils'
import { CATALOG_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const lang = searchParams.get('lang') || 'fr'
  const parentId = searchParams.get('parent')

  try {
    const apiUrl = new URL(`${CATALOG_SVC_URL}/categories`)
    apiUrl.searchParams.set('lang', lang)

    const response = await fetch(apiUrl.toString(), {
      next: { revalidate: 3600 }, // Cache plus long (1h) pour les catégories qui changent peu
    })
    if (!response.ok) {
      console.error(`[API Categories] catalog-svc a répondu ${response.status}`)
      return NextResponse.json({ categories: [] }, { status: 200 })
    }

    const data = await response.json()
    // catalog-svc renvoie { categories: [...] } (pas { items: [...] }),
    // avec les champs count/productCount et parent/parent_id — on accepte
    // les deux formes pour rester robuste si le contrat évolue. Bug
    // constaté le 2026-09-03 : la page d'accueil n'affichait AUCUNE
    // catégorie (data.items toujours vide).
    let items: any[] = data.categories || data.items || []
    if (parentId) {
      items = items.filter(
        (c: any) => String(c.parent_id ?? c.parent ?? 0) === parentId
      )
    }

    const transformedCategories: WooCategory[] = items.map((c: any) => {
      const cParent = c.parent_id ?? c.parent ?? 0
      return {
        id: c.id.toString(),
        name: decodeHtmlEntities(c.name || ''),
        slug: c.slug,
        image: c.image_url || c.image?.src || '/category-placeholder.png',
        productCount: c.productCount ?? c.product_count ?? c.count ?? 0,
        parent: cParent.toString(),
        isRoot: !cParent || cParent === 0,
        description: '',
        lang: lang as 'fr' | 'en',
      }
    })

    // Tri : On met les catégories les plus populaires (avec le plus de produits) en premier
    const sortedCategories = transformedCategories.sort((a, b) => b.productCount - a.productCount)

    return NextResponse.json(
      { categories: sortedCategories },
      {
        headers: {
          // Cache frais 5 min, mais servable via le cache Vercel jusqu'à 1h (stale-while-revalidate)
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600',
        },
      }
    )
  } catch (error) {
    console.error('[Route API Categories] Erreur critique:', error)
    return NextResponse.json({ categories: [] }, { status: 200 })
  }
}

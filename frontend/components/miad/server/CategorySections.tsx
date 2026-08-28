import { fetchInitialCategories, fetchCategoryRow } from '@/lib/woo-server'
import { CategoryRow } from '../CategoryRow'

// CategorySections — bloc "catalogue par catégorie" de l'accueil, AJOUTÉ
// (pas en remplacement) entre FoodServer et InfiniteProductFeed, cf.
// HomeSections.tsx. Une rangée horizontale scrollable par catégorie
// principale ayant des produits. Server Component : les 6 premiers produits
// de chaque catégorie sont fetchés côté serveur ; le scroll latéral charge
// la suite côté client (CategoryRow).
//
// Catégories principales seulement (celles sans parent). Les sous-catégories
// (Pagnes, Sacs…) ne font pas de rangée dédiée pour ne pas allonger
// l'accueil à l'infini — elles restent accessibles via "Voir tout".

// Catégorie alimentation déjà rendue par FoodServer juste au-dessus — on
// l'exclut ici pour ne pas la dupliquer.
const EXCLUDE_SLUGS = new Set(['alimentation', 'alimentation-epicerie'])

const PER_PAGE = 6

export async function CategorySections({ lang = 'fr' }: { lang?: 'fr' | 'en' } = {}) {
  const categories = await fetchInitialCategories()

  // Catégories "principales" = pas de "-" dans le slug composé enfant, ou
  // productCount élevé. catalog-svc n'expose pas toujours parent_id ici ;
  // on se base sur productCount > 0 et on garde les 8 plus fournies pour
  // borner la hauteur de l'accueil.
  const main = categories
    .filter((c: any) => c.productCount > 0 && !EXCLUDE_SLUGS.has(c.slug))
    .sort((a: any, b: any) => b.productCount - a.productCount)
    .slice(0, 8)

  if (main.length === 0) return null

  const rows = await Promise.all(
    main.map(async (c: any) => {
      const { products, totalPages } = await fetchCategoryRow(c.slug, PER_PAGE, lang)
      return { cat: c, products, totalPages }
    })
  )

  const visible = rows.filter((r) => r.products.length > 0)
  if (visible.length === 0) return null

  return (
    <div className="bg-white">
      <div className="container mx-auto px-4 pt-10">
        <h2 className="text-2xl md:text-3xl font-black uppercase tracking-tighter italic">
          {lang === 'en' ? 'Browse by category' : 'Parcourir par catégorie'}
        </h2>
      </div>
      {visible.map(({ cat, products, totalPages }) => (
        <CategoryRow
          key={cat.id}
          categoryName={cat.name}
          categorySlug={cat.slug}
          initialProducts={products}
          totalPages={totalPages}
        />
      ))}
    </div>
  )
}

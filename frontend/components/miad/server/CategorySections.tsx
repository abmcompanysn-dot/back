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
// l'exclut ici pour ne pas la dupliquer. Les slugs catalog-svc portent un
// suffixe de langue (-fr / -en), on teste donc par inclusion.
function isFood(slug: string) {
  return /aliment|epicerie|grocery|food/i.test(slug)
}

const PER_PAGE = 6

export async function CategorySections({ lang = 'fr' }: { lang?: 'fr' | 'en' } = {}) {
  const categories = await fetchInitialCategories()

  // Catégories racines avec des produits, les 8 plus fournies (borne la
  // hauteur de l'accueil). isRoot vient de catalog-svc (parent_id === 0).
  const main = categories
    .filter((c: any) => c.productCount > 0 && c.isRoot !== false && !isFood(c.slug))
    .sort((a: any, b: any) => b.productCount - a.productCount)
    .slice(0, 8)

  if (main.length === 0) return null

  const rows = await Promise.all(
    main.map(async (c: any) => {
      // c.id déjà connu (sorti de fetchInitialCategories() ci-dessus) —
      // transmis directement pour éviter que fetchCategoryRow ne
      // re-résolve le même slug via un appel GET /categories redondant
      // (voir commentaire sur fetchCategoryRow, correctif du 2026-09-04).
      const { products, totalPages } = await fetchCategoryRow(c.slug, PER_PAGE, lang, c.id)
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

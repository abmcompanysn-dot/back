import { Suspense } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { FoodServer } from './FoodServer'
import { CategorySections } from './CategorySections'
import { InfiniteProductFeed } from './InfiniteProductFeed'

function SectionSkeleton() {
  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center gap-3 mb-6">
        <Skeleton className="w-9 h-9 rounded-xl" />
        <Skeleton className="h-6 w-48 rounded-xl" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="aspect-square rounded-2xl" />
            <Skeleton className="h-3 w-3/4 rounded" />
            <Skeleton className="h-4 w-1/2 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

// Composition des sections de l'accueil par défaut (aucun filtre catégorie/
// recherche actif) — chaque section a sa propre frontière <Suspense> et son
// propre fetch serveur indépendant (lib/woo-server.ts), donc une section
// lente n'empêche plus les autres de s'afficher. HeroSection/CategoriesSection/
// TopVendorsStrip restent rendues par MiadMarketClient.tsx (hors de cet arbre
// serveur) — elles ont besoin de callbacks client (sélection de catégorie
// notamment) qu'un Server Component ne peut pas recevoir.
export function HomeSections({ lang = 'fr' }: { lang?: 'fr' | 'en' } = {}) {
  return (
    <>
      {/* Vente Flash / Offres du jour / Bandeau promo / sections "Marché
          [Pays]" retirés de l'accueil (demandé le 2026-07-24) — les promos
          restent visibles sur /promotions, page dédiée déjà existante
          (app/promotions/page.tsx). Boutiques sponsorisées supprimé
          (demandé le 2026-08-26 — cette section n'a jamais eu de contenu
          réel, voir SponsoredStoresCarousel.tsx). Rangées "par catégorie"
          (CategorySections, ajoutées le 2026-08-28) : déplacées vers
          /promotions le 2026-09-04 (ralentissaient l'accueil), puis
          remises sur l'accueil le même soir sur demande du fondateur —
          gardées EN HAUT cette fois (avant l'alimentation), et gardent
          aussi présentes sur /promotions (le fondateur n'a pas demandé
          de les en retirer). Le vrai ralentissement d'origine était le
          correctif appliqué le même jour : fetchCategoryRow reçoit
          désormais categoryId directement (woo-server.ts), plus de 8
          requêtes /categories redondantes. */}
      <Suspense fallback={<SectionSkeleton />}>
        <CategorySections lang={lang} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <FoodServer lang={lang} />
      </Suspense>
      <InfiniteProductFeed language={lang} />
    </>
  )
}

import { fetchProductsByCategorySlug } from '@/lib/woo-server'
import { LinkProductCard } from '../LinkProductCard'

// Server Component — "Épicerie & Alimentation", clone de FoodSection
// (HomePage.tsx). Fetch dédié filtré côté serveur (fetchProductsByCategorySlug)
// plutôt que de filtrer tout le catalogue côté client comme avant.
export async function FoodServer({ lang = 'fr' }: { lang?: 'fr' | 'en' } = {}) {
  const products = await fetchProductsByCategorySlug('alimentation', 8, lang)
  if (products.length === 0) return null

  return (
    <section className="py-16 bg-orange-50/30">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-3xl font-black uppercase tracking-tighter text-orange-900 italic">
              {lang === 'en' ? 'Grocery & Food' : 'Épicerie & Alimentation'}
            </h2>
            <p className="text-sm text-orange-700/70 font-bold uppercase tracking-widest">
              {lang === 'en' ? 'The authentic taste of the continent' : 'Le goût authentique du continent'}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {products.map((p: any) => (
            <LinkProductCard key={p.id} product={p} />
          ))}
        </div>
      </div>
    </section>
  )
}

import { fetchStores, fetchInitialProducts } from '@/lib/woo-server'
import { SponsoredStoresCarousel } from '../SponsoredStoresCarousel'

// Server Component : fetch indépendant, délègue l'affichage "flip entre
// vendeurs" au client (voir SponsoredStoresCarousel.tsx — cet état ne peut
// pas vivre côté serveur). fetchStores/fetchInitialProducts sont mis en
// cache (React.cache), partagés avec les autres sections de l'accueil.
export async function SponsoredStoresServer({ lang = 'fr' }: { lang?: 'fr' | 'en' } = {}) {
  const [stores, products] = await Promise.all([fetchStores(100), fetchInitialProducts(100, lang)])
  const sponsored = stores
    .filter((s: any) => s.verified)
    .slice(0, 6)
    .map((s: any) => ({
      ...s,
      topProducts: products.filter((p: any) => p.vendor?.id === s.id || p.vendor?.name === s.name).slice(0, 4),
    }))

  if (sponsored.length === 0) return null

  return <SponsoredStoresCarousel sponsored={sponsored} lang={lang} />
}

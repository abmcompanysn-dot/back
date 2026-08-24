import Link from 'next/link'
import Image from 'next/image'
import { Star, ShieldCheck, ArrowRight } from 'lucide-react'
import { fetchStores } from '@/lib/woo-server'
import { proxyIfLocalWp } from '@/lib/image-utils'

// Variante de BrandDayBanner.tsx ("Boutique du jour"), déplacée de l'accueil
// vers /promotions (demandé le 2026-07-25). Même logique de sélection de la
// boutique vedette, mais en Server Component avec <Link href="/vendor/...">
// au lieu d'un onClick (cette page n'a pas accès aux callbacks SPA de
// MiadMarketClient, même raison que PromoCountrySections.tsx).
export async function PromoBrandDayBanner() {
  const stores = await fetchStores(100)
  if (stores.length === 0) return null

  const withBanner = stores.filter((s: any) => s.verified && s.banner)
  const pool = withBanner.length > 0 ? withBanner : stores.filter((s: any) => s.verified)
  const candidates = pool.length > 0 ? pool : stores
  const featured = [...candidates].sort((a: any, b: any) =>
    (b.rating || 0) - (a.rating || 0) || (b.productCount || 0) - (a.productCount || 0)
  )[0]

  if (!featured) return null

  return (
    <Link
      href={`/vendor/${featured.slug}`}
      className="group relative w-full h-[110px] sm:h-[140px] rounded-2xl overflow-hidden block"
    >
      {featured.banner ? (
        <Image src={proxyIfLocalWp(featured.banner)!} alt="" fill sizes="100vw" className="object-cover" />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-primary to-accent" />
      )}
      <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/40 to-black/10" />
      <div className="relative z-10 h-full flex items-center justify-between px-5 sm:px-8">
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="relative w-12 h-12 sm:w-14 sm:h-14 rounded-full border-2 border-white/80 overflow-hidden bg-white shrink-0">
            <Image src={proxyIfLocalWp(featured.logo) || '/logo/logo.png'} alt={featured.name} fill sizes="56px" className="object-cover" />
          </div>
          <div className="text-white">
            <p className="text-[10px] font-black uppercase tracking-widest text-white/70 mb-0.5">Boutique du jour</p>
            <h3 className="text-base sm:text-xl font-black uppercase tracking-tight leading-tight">{featured.name}</h3>
            <div className="flex items-center gap-2 mt-1">
              {featured.verified && (
                <span className="flex items-center gap-1 text-[10px] font-bold text-white/90">
                  <ShieldCheck size={12} /> Vérifiée
                </span>
              )}
              <span className="flex items-center gap-1 text-[10px] font-bold text-white/90">
                <Star size={11} className="fill-yellow-400 text-yellow-400" /> {(featured.rating || 5).toFixed(1)}
              </span>
            </div>
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-1.5 bg-white text-black text-xs font-black uppercase px-4 py-2.5 rounded-full shrink-0 group-hover:bg-white/90 transition-colors">
          Découvrir <ArrowRight size={14} />
        </div>
      </div>
    </Link>
  )
}

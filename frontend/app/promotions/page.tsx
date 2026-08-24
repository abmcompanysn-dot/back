import Link from 'next/link'
import Image from 'next/image'
import { Suspense } from 'react'
import { Metadata } from 'next'
import { ArrowLeft, Percent, Tag } from 'lucide-react'
import { fetchOnSaleProducts, fetchActiveCoupons } from '@/lib/woo-server'
import { formatPrice } from '@/lib/woocommerce'
import { PromoHeroCarousel } from '@/components/miad/PromoHeroCarousel'
import { PromoCountrySections } from '@/components/miad/server/PromoCountrySections'
import { PromoBrandDayBanner } from '@/components/miad/server/PromoBrandDayBanner'
import { CouponsSection } from '@/components/miad/CouponsSection'

export const runtime = 'edge'
export const revalidate = 300

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.miadmarket.com'

export const metadata: Metadata = {
  title: 'Promotions en cours | MIAD Market',
  description: 'Découvrez les produits africains actuellement en promotion sur MIAD Market — artisanat, mode, beauté et alimentation à prix réduit.',
  alternates: { canonical: `${SITE_URL}/promotions` },
}

function couponLabel(c: { discountType: string; amount: string }): string {
  if (c.discountType === 'percent') return `-${c.amount}%`
  return `-${formatPrice(parseFloat(c.amount))}$`
}

export default async function PromotionPage() {
  const [products, coupons] = await Promise.all([
    fetchOnSaleProducts(24),
    fetchActiveCoupons(),
  ])

  // Tri par % de réduction décroissant — les meilleures offres passent en
  // premier dans le carrousel ET en tête de grille, sans dupliquer le fetch.
  const sorted = products.toSorted((a: any, b: any) => {
    const da = a.regularPrice > 0 ? 1 - a.price / a.regularPrice : 0
    const db = b.regularPrice > 0 ? 1 - b.price / b.regularPrice : 0
    return db - da
  })

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full bg-white/90 backdrop-blur-md border-b border-border/50 shadow-xs">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center h-9">
            <Image src="/logo/logo.png" alt="MIAD Market" width={140} height={36} priority className="h-full w-auto object-contain" />
          </Link>
          <Link
            href="/"
            className="group inline-flex items-center gap-1.5 text-foreground hover:text-accent transition-colors font-bold text-xs uppercase tracking-widest"
          >
            <ArrowLeft size={15} className="group-hover:-translate-x-0.5 transition-transform" />
            <span className="hidden sm:inline">Retour au marché</span>
            <span className="sm:hidden">Marché</span>
          </Link>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        {/* Boutique du jour / Tickets Réduction : déplacées ici depuis
            l'accueil (demandé le 2026-07-25) */}
        <Suspense fallback={null}>
          <PromoBrandDayBanner />
        </Suspense>
        <div className="mt-4">
          <CouponsSection />
        </div>

        <PromoHeroCarousel products={sorted} coupons={coupons} />

        <div className="text-center mt-10 mb-8">
          <h1 className="font-serif text-3xl sm:text-4xl text-foreground text-balance">Toutes les promotions</h1>
          <p className="text-muted-foreground text-sm mt-2">
            {products.length} produit{products.length > 1 ? 's' : ''} actuellement en promotion sur MIAD Market
          </p>
        </div>

        {coupons.length > 0 && (
          <div className="mb-12">
            <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
              <Tag size={13} className="text-accent" /> Codes promo actifs
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {coupons.map((coupon) => (
                <div key={coupon.code} className="flex rounded-2xl border border-border bg-card overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                  <div className="bg-accent text-accent-foreground w-24 shrink-0 flex flex-col items-center justify-center px-2 py-4 relative">
                    <span className="text-xl font-black leading-none text-center">{couponLabel(coupon)}</span>
                    {/* Perforation façon ticket, purement décorative */}
                    <div className="absolute -right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-background" />
                  </div>
                  <div className="flex-1 px-4 py-3 flex flex-col justify-center border-l border-dashed border-border min-w-0">
                    <span className="font-mono font-bold text-sm text-foreground truncate">{coupon.code}</span>
                    {coupon.minimumAmount && (
                      <span className="text-xs text-muted-foreground mt-0.5">Dès {formatPrice(parseFloat(coupon.minimumAmount))}$ d'achat</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {sorted.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground">
            <Percent size={28} className="mx-auto mb-3 opacity-40" />
            <p className="font-bold">Aucune promotion active pour le moment.</p>
            <p className="text-sm mt-1">Revenez bientôt — de nouvelles offres arrivent régulièrement !</p>
          </div>
        ) : (
          <div>
            <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
              <Percent size={13} className="text-accent" /> Tous les produits en promotion
            </h2>
            <div className="grid gap-4 sm:gap-5 grid-cols-2 md:grid-cols-4">
              {sorted.map((p: any) => {
                const discountPct = p.regularPrice > 0 ? Math.round((1 - p.price / p.regularPrice) * 100) : 0
                return (
                  <Link
                    key={p.id}
                    href={`/product/${p.slug}`}
                    className="bg-card rounded-2xl overflow-hidden border border-border hover:shadow-lg hover:border-accent/40 transition-all group"
                  >
                    <div className="aspect-square relative bg-muted">
                      {p.image && (
                        <Image src={p.image} alt={p.name} fill sizes="(max-width: 768px) 50vw, 25vw" className="object-cover group-hover:scale-105 transition-transform duration-300" />
                      )}
                      {discountPct > 0 && (
                        <span className="absolute top-2 left-2 bg-accent text-accent-foreground text-[10px] font-black px-2 py-0.5 rounded-full shadow-sm">-{discountPct}%</span>
                      )}
                    </div>
                    <div className="p-3">
                      <h3 className="text-xs font-bold text-foreground line-clamp-2 mb-1.5 leading-snug">{p.name}</h3>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-black text-accent">{formatPrice(p.price)}$</span>
                        {p.regularPrice > p.price && (
                          <span className="text-[10px] line-through text-muted-foreground">{formatPrice(p.regularPrice)}$</span>
                        )}
                      </div>
                    </div>
                  </Link>
                )
              })}
            </div>
          </div>
        )}

        <Suspense fallback={null}>
          <PromoCountrySections />
        </Suspense>
      </div>
    </div>
  )
}

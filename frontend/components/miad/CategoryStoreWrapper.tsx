'use client'

import Link from 'next/link'
import { ShoppingBag, Package, Star } from 'lucide-react'
import { LazyImage } from './LazyImage'
import { StandaloneHeader } from './StandaloneHeader'
import { useCurrency } from '@/contexts/CurrencyContext'

// Version SEO/SSR autonome de la page catégorie (comme VendorStoreWrapper
// pour les boutiques) : grille de produits avec de VRAIS liens <a href>
// crawlables. La navigation interne à l'app continue de passer par la SPA
// (MiadMarketClient -> CategoryPage), cette route sert l'indexation et les
// accès directs / partages.

interface CategoryProduct {
  id: string | number
  name: string
  slug: string
  price: number
  regularPrice?: number
  currency?: string
  image: string
  countryCode?: string
  rating?: number
}

interface CategoryStoreWrapperProps {
  categoryName: string
  categorySlug: string
  description?: string
  products: CategoryProduct[]
  total: number
}

export function CategoryStoreWrapper({
  categoryName,
  categorySlug,
  description,
  products,
  total,
}: CategoryStoreWrapperProps) {
  const { formatPrice: fp } = useCurrency()

  return (
    <div className="min-h-screen bg-background">
      <StandaloneHeader
        mode="category"
        title={categoryName}
        subtitle={`${total} produit${total > 1 ? 's' : ''}`}
      />

      {/* ── En-tête catégorie ── */}
      <div className="border-b border-border bg-muted/30 py-10">
        <div className="container mx-auto px-4 max-w-6xl">
          <nav aria-label="Fil d'Ariane" className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">
            <Link href="/" className="hover:text-accent">Accueil</Link>
            <span className="mx-2 opacity-40">/</span>
            <span className="text-foreground">{categoryName}</span>
          </nav>
          <div className="flex items-center gap-5">
            <div className="w-16 h-16 bg-accent text-white rounded-3xl shadow-xl shadow-accent/25 flex items-center justify-center rotate-3">
              <ShoppingBag size={30} />
            </div>
            <div>
              <h1 className="text-3xl lg:text-4xl font-black uppercase tracking-tighter">{categoryName}</h1>
              <p className="text-muted-foreground font-bold text-sm mt-1 uppercase tracking-widest opacity-60">
                {total} pépite{total > 1 ? 's' : ''} d&apos;Afrique
              </p>
            </div>
          </div>
          {description && (
            <p className="mt-5 max-w-2xl text-sm text-foreground/80 leading-relaxed">{description}</p>
          )}
        </div>
      </div>

      {/* ── Grille produits ── */}
      <div className="container mx-auto px-4 max-w-6xl py-12">
        {products.length === 0 ? (
          <div className="text-center py-28 opacity-40">
            <Package size={56} className="mx-auto mb-4" />
            <p className="font-bold uppercase text-sm">Aucun produit dans cette catégorie pour le moment</p>
          </div>
        ) : (
          <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 list-none p-0 m-0">
            {products.map((product) => (
              <li key={product.id}>
                <Link
                  href={`/product/${product.slug}`}
                  className="group block bg-card border border-border rounded-xl overflow-hidden hover:shadow-lg hover:border-accent/30 transition-all h-full"
                >
                  <div className="aspect-square relative overflow-hidden bg-muted">
                    <LazyImage
                      src={product.image || '/placeholder.svg'}
                      alt={product.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                    />
                    {product.countryCode && (
                      <div className="absolute top-1.5 left-1.5 bg-white/90 px-1.5 py-0.5 rounded text-[9px] font-black shadow-sm uppercase">
                        {product.countryCode}
                      </div>
                    )}
                    {(product.regularPrice ?? 0) > product.price && (
                      <div className="absolute top-1.5 right-1.5 bg-red-500 text-white px-1.5 py-0.5 rounded text-[9px] font-black">
                        -{Math.round((1 - product.price / (product.regularPrice ?? product.price)) * 100)}%
                      </div>
                    )}
                  </div>
                  <div className="p-2.5 flex flex-col">
                    <h2 className="text-xs font-medium line-clamp-2 leading-tight mb-1.5 group-hover:text-accent transition-colors">
                      {product.name}
                    </h2>
                    {(product.rating ?? 0) > 0 && (
                      <div className="flex items-center gap-1 mb-1.5">
                        <Star size={10} className="fill-orange-400 text-orange-400" />
                        <span className="text-[10px] font-bold">{(product.rating ?? 0).toFixed(1)}</span>
                      </div>
                    )}
                    <div className="mt-auto">
                      <p className="font-black text-sm text-accent">{fp(product.price)}</p>
                      {(product.regularPrice ?? 0) > product.price && (
                        <p className="text-[10px] text-muted-foreground line-through">
                          {fp(product.regularPrice ?? 0)}
                        </p>
                      )}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {total > products.length && (
          <p className="text-center text-xs text-muted-foreground font-medium mt-10">
            {products.length} produits affichés sur {total}.{' '}
            <Link href={`/?v=category&slug=${categorySlug}`} className="text-accent font-bold underline underline-offset-2">
              Voir tout dans l&apos;application
            </Link>
          </p>
        )}
      </div>

      <footer className="bg-primary text-white/60 text-center py-8 text-xs">
        <div className="flex items-center justify-center gap-2 mb-2">
          <ShoppingBag size={16} className="text-accent" />
          <p className="font-black text-white text-sm italic uppercase tracking-tighter">MIAD Market</p>
        </div>
        <p>Le marché africain en ligne · Qualité garantie · Livraison internationale</p>
        <Link href="/" className="inline-block mt-3 text-accent font-bold underline underline-offset-2 text-xs">
          Découvrir tous les produits →
        </Link>
      </footer>
    </div>
  )
}

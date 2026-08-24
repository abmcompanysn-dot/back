"use client"

import { useMemo } from 'react'
import useSWR from 'swr'
import Image from 'next/image'
import { ShoppingBag, Package } from 'lucide-react'
import { type WooProduct } from '@/lib/woocommerce'
import { ProductCard } from './ProductCard'
import { ProductSkeleton } from './ProductSkeleton'
import { HOME_CATEGORY_TABS } from './HomeCategoryTabs'

const BANNER_IMAGE: Record<string, string> = {
  'mode-vetements': '/categories/mode-vetements.webp',
  'bijoux-accessoires': '/categories/bijoux-accessoires.webp',
  'beaute-soin-naturel': '/categories/beaute-soin-naturel.webp',
  'artisanat-art-africain': '/categories/artisanat-art-africain.webp',
  'alimentation-epicerie': '/categories/alimentation-epicerie.webp',
}

const BANNER_SUBTITLE: Record<string, string> = {
  'mode-vetements': 'Pagnes, boubous et tenues authentiques d’Afrique',
  'bijoux-accessoires': 'Bijoux artisanaux, cauris et créations dorées',
  'beaute-soin-naturel': 'Soins naturels, huiles et savons artisanaux',
  'artisanat-art-africain': 'Sculptures, tableaux et art fait main',
  'alimentation-epicerie': 'Épices, infusions et saveurs du continent',
  'maison-decoration': 'Décoration et artisanat pour la maison',
  'bebe-enfant': 'Vêtements et douceurs pour les tout-petits',
  'sante-bien-etre': 'Plantes médicinales et compléments naturels',
}

const BANNER_SUBTITLE_EN: Record<string, string> = {
  'mode-vetements': 'Pagnes, boubous and authentic African outfits',
  'bijoux-accessoires': 'Handcrafted jewelry, cowries and golden pieces',
  'beaute-soin-naturel': 'Natural skincare, oils and handmade soaps',
  'artisanat-art-africain': 'Sculptures, paintings and handmade art',
  'alimentation-epicerie': 'Spices, infusions and flavors from the continent',
  'maison-decoration': 'Home decor and craftsmanship',
  'bebe-enfant': 'Clothes and gentle essentials for little ones',
  'sante-bien-etre': 'Medicinal plants and natural supplements',
}

const fetcher = (url: string) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('miad_token') : null
  return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then(res => {
    if (!res.ok) throw new Error(`Erreur ${res.status}`)
    return res.json()
  })
}

interface HomeCategoryTabSectionProps {
  categorySlug: string
  allProducts: WooProduct[]
  userCountry: string
  onProductClick: (product: WooProduct) => void
  onAddToCart: (product: WooProduct) => void
  language?: 'fr' | 'en'
}

export function HomeCategoryTabSection({ categorySlug, allProducts, userCountry, onProductClick, onAddToCart, language = 'fr' }: HomeCategoryTabSectionProps) {
  const tab = HOME_CATEGORY_TABS.find(t => t.slug === categorySlug)
  const tabLabel = language === 'en' ? tab?.labelEn : tab?.label
  const bannerSubtitle = language === 'en' ? BANNER_SUBTITLE_EN[categorySlug] : BANNER_SUBTITLE[categorySlug]

  const { data, isLoading } = useSWR(
    `/api/products?category=${categorySlug}&per_page=60&userCountry=${userCountry}`,
    fetcher,
    { revalidateOnFocus: false }
  )

  const products: WooProduct[] = useMemo(() => {
    if (data?.products?.length) return data.products
    // Repli le temps du premier fetch : filtre les produits déjà en mémoire.
    return allProducts.filter(p => p.categorySlug === categorySlug)
  }, [data, allProducts, categorySlug])

  return (
    <section>
      {/* Bannière catégorie — fixe, pas de rotation (contrairement au hero) */}
      <div className="relative w-full h-[160px] sm:h-[220px] overflow-hidden bg-muted">
        {BANNER_IMAGE[categorySlug] ? (
          <Image
            src={BANNER_IMAGE[categorySlug]}
            alt={tabLabel || ''}
            fill
            priority
            sizes="100vw"
            className="object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-primary to-accent" />
        )}
        <div className="absolute inset-0 bg-gradient-to-r from-black/65 via-black/30 to-transparent" />
        <div className="relative z-10 h-full flex items-center px-6 sm:px-10">
          <div className="text-white max-w-sm">
            <h2 className="text-2xl sm:text-4xl font-black uppercase tracking-tight leading-tight mb-1">
              {tabLabel}
            </h2>
            <p className="text-white/80 text-xs sm:text-sm leading-snug">
              {bannerSubtitle}
            </p>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-6">
        {isLoading && products.length === 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {[...Array(10)].map((_, i) => <ProductSkeleton key={i} />)}
          </div>
        ) : products.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {products.map(product => (
              <ProductCard
                key={product.id}
                product={product}
                onClick={onProductClick}
                onAddToCart={onAddToCart}
                userCountry={userCountry}
              />
            ))}
          </div>
        ) : (
          <div className="text-center py-20">
            <Package size={48} className="mx-auto text-muted-foreground opacity-20 mb-4" />
            <p className="font-bold text-muted-foreground">{language === 'en' ? 'No products in this category yet.' : "Aucun produit pour l'instant dans cette catégorie."}</p>
          </div>
        )}
      </div>
    </section>
  )
}

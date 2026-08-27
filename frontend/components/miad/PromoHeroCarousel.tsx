"use client"

import { useEffect, useMemo, useState, useCallback } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { toast } from 'sonner'
import { ArrowRight, Copy, Sparkles, Tag } from 'lucide-react'
import { formatPrice } from '@/lib/woocommerce'

interface CouponData {
  code: string
  discountType: string
  amount: string
  minimumAmount?: string
}

interface BannerData {
  id: string
  image: string
  href?: string
}

type Slide =
  | { kind: 'product'; product: any }
  | { kind: 'coupon'; coupon: CouponData }
  | { kind: 'banner'; banner: BannerData }

// Bannières promotionnelles statiques (pas de backend dédié — juste une
// image déposée dans public/promo/) : ajoutée le 2026-08-27 à la demande
// du fondateur, insérée en tête du carrousel avant les slides produit/
// coupon dynamiques.
const STATIC_BANNERS: BannerData[] = [
  { id: 'miad-delivery', image: '/promo/miad-delivery-banner.webp' },
]

function copyCode(code: string) {
  navigator.clipboard.writeText(code).then(() => {
    toast.success('Code copié', { description: code })
  }).catch(() => {})
}

function couponLabel(c: CouponData): string {
  if (c.discountType === 'percent') return `-${c.amount}%`
  return `-${formatPrice(parseFloat(c.amount))}$`
}

// Alterne produit / coupon tant qu'il en reste des deux côtés, puis
// continue avec ce qu'il reste — évite un carrousel à sens unique si l'un
// des deux lots est plus court que l'autre.
function buildSlides(products: any[], coupons: CouponData[], banners: BannerData[]): Slide[] {
  const slides: Slide[] = banners.map(banner => ({ kind: 'banner', banner }))
  const maxLen = Math.max(products.length, coupons.length)
  for (let i = 0; i < maxLen; i++) {
    if (products[i]) slides.push({ kind: 'product', product: products[i] })
    if (coupons[i]) slides.push({ kind: 'coupon', coupon: coupons[i] })
  }
  return slides
}

export function PromoHeroCarousel({ products, coupons }: { products: any[]; coupons: CouponData[] }) {
  const slides = useMemo(
    () => buildSlides(products.slice(0, 5), coupons.slice(0, 4), STATIC_BANNERS),
    [products, coupons]
  )
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)

  const advance = useCallback(() => {
    setIndex(i => (i + 1) % slides.length)
  }, [slides.length])

  useEffect(() => {
    if (slides.length <= 1 || paused) return
    const t = setInterval(advance, 5000)
    return () => clearInterval(t)
  }, [advance, slides.length, paused])

  if (slides.length === 0) return null

  const slide = slides[index]

  return (
    <div
      className="relative overflow-hidden rounded-3xl"
      style={{ background: 'linear-gradient(135deg, oklch(0.22 0.06 150) 0%, oklch(0.16 0.05 150) 100%)' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Texture ambiante — cercle accent flouté, purement décoratif */}
      <div className="pointer-events-none absolute -top-24 -right-24 w-80 h-80 rounded-full bg-accent/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-16 -left-16 w-64 h-64 rounded-full bg-accent/10 blur-3xl" />

      <div className="relative min-h-[280px] sm:min-h-[320px]">
        {slide.kind === 'product' ? (
          <ProductSlide product={slide.product} />
        ) : slide.kind === 'coupon' ? (
          <CouponSlide coupon={slide.coupon} onCopy={copyCode} />
        ) : (
          <BannerSlide banner={slide.banner} />
        )}
      </div>

      {slides.length > 1 && (
        <div className="relative flex items-center justify-center gap-2 pb-5">
          {slides.map((s, i) => (
            <button
              key={s.kind === 'product' ? `p-${s.product.id}` : s.kind === 'coupon' ? `c-${s.coupon.code}` : `b-${s.banner.id}`}
              type="button"
              aria-label={`Voir l'offre ${i + 1}`}
              onClick={() => setIndex(i)}
              className={`h-1.5 rounded-full transition-all ${i === index ? 'w-6 bg-accent' : 'w-1.5 bg-white/30 hover:bg-white/50'}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function BannerSlide({ banner }: { banner: BannerData }) {
  const img = (
    <Image
      src={banner.image}
      alt=""
      fill
      className="object-cover"
      sizes="(max-width: 640px) 100vw, 1200px"
      priority
    />
  )
  return (
    <div className="relative w-full h-[280px] sm:h-[320px]">
      {banner.href ? <Link href={banner.href}>{img}</Link> : img}
    </div>
  )
}

function ProductSlide({ product }: { product: any }) {
  const discountPct = product.regularPrice > 0 ? Math.round((1 - product.price / product.regularPrice) * 100) : 0
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] items-center gap-6 px-6 sm:px-10 py-8 sm:py-10">
      <div className="order-2 sm:order-1 text-center sm:text-left">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.15em] text-accent">
          <Sparkles size={12} /> Offre du moment
        </span>
        <h2 className="font-serif text-2xl sm:text-4xl text-white mt-3 leading-tight text-balance line-clamp-2">
          {product.name}
        </h2>
        <div className="flex items-center justify-center sm:justify-start gap-3 mt-4">
          <span className="text-2xl sm:text-3xl font-black text-white">{formatPrice(product.price)}$</span>
          {discountPct > 0 && (
            <>
              <span className="text-sm text-white/50 line-through">{formatPrice(product.regularPrice)}$</span>
              <span className="text-xs font-black bg-accent text-accent-foreground px-2 py-1 rounded-full">-{discountPct}%</span>
            </>
          )}
        </div>
        <Link
          href={`/product/${product.slug}`}
          className="inline-flex items-center gap-2 mt-6 bg-white text-primary font-bold text-sm px-5 py-2.5 rounded-full hover:bg-white/90 transition-colors group"
        >
          Voir l'offre <ArrowRight size={15} className="group-hover:translate-x-0.5 transition-transform" />
        </Link>
      </div>
      <div className="order-1 sm:order-2 w-32 h-32 sm:w-44 sm:h-44 rounded-2xl overflow-hidden bg-white/10 shrink-0 mx-auto shadow-xl">
        {product.image ? (
          <Image src={product.image} alt={product.name} width={176} height={176} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white/30"><Tag size={32} /></div>
        )}
      </div>
    </div>
  )
}

function CouponSlide({ coupon, onCopy }: { coupon: CouponData; onCopy: (code: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-10 sm:py-14">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.15em] text-accent">
        <Tag size={12} /> Code promo
      </span>
      <p className="font-serif text-4xl sm:text-6xl text-white mt-3 leading-none">{couponLabel(coupon)}</p>
      {coupon.minimumAmount && (
        <p className="text-white/60 text-sm mt-3">Dès {formatPrice(parseFloat(coupon.minimumAmount))}$ d'achat</p>
      )}
      <button
        type="button"
        onClick={() => onCopy(coupon.code)}
        className="inline-flex items-center gap-2 mt-6 bg-white/10 border border-white/25 text-white font-mono font-bold text-sm px-5 py-2.5 rounded-full hover:bg-white/20 transition-colors"
      >
        {coupon.code} <Copy size={14} />
      </button>
    </div>
  )
}

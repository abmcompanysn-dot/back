"use client"

import { useMemo, useState, useRef, useCallback } from 'react'
import Image from 'next/image'
import { ShoppingBag, TrendingUp, Star, Compass, ChevronLeft, ChevronRight } from 'lucide-react'
import { type WooProduct } from '@/lib/woocommerce'
import { useCurrency } from '@/contexts/CurrencyContext'
import { LazyImage } from './LazyImage'
import { proxyIfLocalWp } from '@/lib/image-utils'

interface ProductTickerProps {
  products: WooProduct[]
  onProductClick: (product: WooProduct) => void
  userCountryCode?: string
  label?: string
}

function DiscountBadge({ price, regularPrice }: { price: number; regularPrice: number }) {
  if (!regularPrice || regularPrice <= price) return null
  const pct = Math.round((1 - price / regularPrice) * 100)
  return (
    <span className="absolute top-2 right-2 bg-accent text-white text-[9px] font-black px-1.5 py-0.5 rounded-md shadow">
      -{pct}%
    </span>
  )
}

function ProductImg({ src, alt, onError, priority }: { src: string; alt: string; onError?: () => void; priority?: boolean }) {
  const [errored, setErrored] = useState(false)
  const [loaded, setLoaded] = useState(false)

  if (!src || src === '/placeholder.jpg' || errored) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-muted">
        <ShoppingBag size={24} className="text-muted-foreground/40" />
      </div>
    )
  }

  return (
    <div className="w-full h-full relative">
      {!loaded && (
        <div className="absolute inset-0 bg-gradient-to-r from-muted via-background/60 to-muted animate-pulse" />
      )}
      <LazyImage
        src={src}
        alt={alt}
        decoding="async"
        // Le ticker est toujours au-dessus de la ligne de flottaison — priorise
        // son téléchargement devant les dizaines d'autres images (boutiques,
        // sections pays) qui se déclenchent en même temps et lui font
        // concurrence pour la bande passante.
        {...(priority ? { fetchPriority: 'high' as const } : {})}
        className={`w-full h-full object-cover group-hover:scale-105 transition-all duration-500 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        onLoad={() => setLoaded(true)}
        onError={() => { setErrored(true); onError?.() }}
      />
    </div>
  )
}

// ── Badge boutique compact (logo + nom) ──────────────────────────────────────
function VendorBadge({ vendor }: { vendor?: { name?: string; logo?: string } }) {
  const [logoErrored, setLogoErrored] = useState(false)
  const [logoLoaded, setLogoLoaded] = useState(false)
  if (!vendor?.name) return <span className="text-[9px] text-muted-foreground font-bold uppercase">MIAD Market</span>
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-4 h-4 rounded-full overflow-hidden bg-muted shrink-0 border border-border/30 relative">
        {vendor.logo && !logoErrored ? (
          <>
            {!logoLoaded && <div className="absolute inset-0 bg-muted animate-pulse rounded-full" />}
            <Image src={proxyIfLocalWp(vendor.logo)!} alt="" fill sizes="16px" className={`object-cover transition-opacity duration-200 ${logoLoaded ? 'opacity-100' : 'opacity-0'}`} onLoad={() => setLogoLoaded(true)} onError={() => setLogoErrored(true)} />
          </>
        ) : (
          <ShoppingBag size={8} className="m-auto text-muted-foreground/40" />
        )}
      </div>
      <span className="text-[9px] text-muted-foreground font-bold uppercase truncate max-w-[80px]">{vendor.name}</span>
    </div>
  )
}

// ── Rangée 1 : 3 produits côte à côte ────────────────────────────────────────
function Row3({ products, onClick, onImageError }: { products: WooProduct[]; onClick: (p: WooProduct) => void; onImageError: (id: number) => void }) {
  const { formatPrice: fp } = useCurrency()
  return (
    <div className="grid grid-cols-3 gap-3">
      {products.map(p => (
        <button
          type="button"
          key={p.id}
          onClick={() => onClick(p)}
          className="group bg-white rounded-2xl border border-border/60 overflow-hidden hover:border-accent hover:shadow-lg hover:-translate-y-0.5 transition-all duration-300 text-left shadow-sm"
        >
          <div className="relative aspect-square overflow-hidden bg-muted/30">
            <ProductImg src={p.image} alt={p.name} onError={() => onImageError(p.id)} priority />
            {p.countryCode && (
              <span className="absolute top-2 left-2 bg-white/95 text-[9px] font-black uppercase px-1.5 py-0.5 rounded-md shadow-sm border border-border/20">
                {p.countryCode}
              </span>
            )}
            <DiscountBadge price={Number(p.price)} regularPrice={Number(p.regularPrice)} />
          </div>
          <div className="p-3">
            <VendorBadge vendor={p.vendor} />
            <p className="text-xs font-semibold line-clamp-2 leading-snug text-foreground group-hover:text-accent transition-colors mt-1 min-h-8">{p.name}</p>
            <p className="text-sm font-black text-accent mt-1.5">{fp(Number(p.price))}</p>
          </div>
        </button>
      ))}
    </div>
  )
}

// ── Rangée 2 : 4 produits ─────────────────────────────────────────────────────
function Row4({ products, onClick, onImageError }: { products: WooProduct[]; onClick: (p: WooProduct) => void; onImageError: (id: number) => void }) {
  const { formatPrice: fp } = useCurrency()
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {products.map(p => (
        <button
          type="button"
          key={p.id}
          onClick={() => onClick(p)}
          className="group bg-white rounded-2xl border border-border/60 overflow-hidden hover:border-accent hover:shadow-lg hover:-translate-y-0.5 transition-all duration-300 text-left shadow-sm"
        >
          <div className="relative aspect-square overflow-hidden bg-muted/30">
            <ProductImg src={p.image} alt={p.name} onError={() => onImageError(p.id)} />
            <DiscountBadge price={Number(p.price)} regularPrice={Number(p.regularPrice)} />
          </div>
          <div className="p-2.5">
            <VendorBadge vendor={p.vendor} />
            <p className="text-xs font-semibold line-clamp-2 leading-snug text-foreground group-hover:text-accent transition-colors mt-1">{p.name}</p>
            <p className="text-sm font-black text-accent mt-1">{fp(Number(p.price))}</p>
          </div>
        </button>
      ))}
    </div>
  )
}

// ── Rangée 3 : 1 grand produit (image gauche + infos droite) ─────────────────
function RowHero({ product, onClick, onImageError }: { product: WooProduct; onClick: (p: WooProduct) => void; onImageError: (id: number) => void }) {
  const { formatPrice: fp } = useCurrency()
  const hasDiscount = product.regularPrice && Number(product.regularPrice) > Number(product.price)
  const pct = hasDiscount ? Math.round((1 - Number(product.price) / Number(product.regularPrice)) * 100) : 0

  return (
    <button
      type="button"
      onClick={() => onClick(product)}
      className="group w-full bg-white rounded-2xl border border-border/60 overflow-hidden hover:border-accent hover:shadow-xl transition-all duration-300 text-left shadow-sm flex"
    >
      {/* Image gauche ~55% */}
      <div className="relative w-[55%] shrink-0 overflow-hidden bg-muted/30" style={{ minHeight: '220px' }}>
        <ProductImg src={product.image} alt={product.name} onError={() => onImageError(product.id)} />
        {product.countryCode && (
          <span className="absolute top-3 left-3 bg-white/95 text-[10px] font-black uppercase px-2 py-0.5 rounded-md shadow-sm border border-border/20">
            {product.countryCode}
          </span>
        )}
        {hasDiscount && (
          <span className="absolute top-3 right-3 bg-accent text-white text-[10px] font-black px-2 py-0.5 rounded-md shadow">
            -{pct}%
          </span>
        )}
      </div>

      {/* Infos droite ~45% */}
      <div className="flex-1 p-5 flex flex-col justify-between">
        <div>
          <div className="mb-2"><VendorBadge vendor={product.vendor} /></div>
          <h3 className="text-lg font-black text-foreground leading-snug group-hover:text-accent transition-colors line-clamp-3">
            {product.name}
          </h3>
          {product.countryCode && (
            <p className="text-xs text-muted-foreground mt-2">Origine · {product.countryCode.toUpperCase()}</p>
          )}
        </div>
        <div className="mt-4">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-2xl font-black text-accent">{fp(Number(product.price))}</span>
            {hasDiscount && (
              <span className="text-sm text-muted-foreground line-through">{fp(Number(product.regularPrice))}</span>
            )}
          </div>
          <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold bg-accent text-white px-4 py-2 rounded-full group-hover:bg-accent/90 transition-colors">
            <ShoppingBag size={13} /> Voir le produit
          </span>
        </div>
      </div>
    </button>
  )
}

// ── Rangée 4 : 6 petits produits ─────────────────────────────────────────────
function Row6({ products, onClick, onImageError }: { products: WooProduct[]; onClick: (p: WooProduct) => void; onImageError: (id: number) => void }) {
  const { formatPrice: fp } = useCurrency()
  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5">
      {products.map(p => (
        <button
          type="button"
          key={p.id}
          onClick={() => onClick(p)}
          className="group bg-white rounded-xl border border-border/60 overflow-hidden hover:border-accent hover:shadow-md hover:-translate-y-0.5 transition-all duration-300 text-left shadow-sm"
        >
          <div className="relative aspect-square overflow-hidden bg-muted/30">
            <ProductImg src={p.image} alt={p.name} onError={() => onImageError(p.id)} />
            <DiscountBadge price={Number(p.price)} regularPrice={Number(p.regularPrice)} />
          </div>
          <div className="p-2">
            <p className="text-[10px] font-semibold line-clamp-2 leading-tight text-foreground group-hover:text-accent transition-colors">{p.name}</p>
            <p className="text-xs font-black text-accent mt-1">{fp(Number(p.price))}</p>
          </div>
        </button>
      ))}
    </div>
  )
}

// ── Section header ────────────────────────────────────────────────────────────
function SectionHeader({ icon: Icon, title, sub, color }: { icon: any; title: string; sub: string; color: string }) {
  return (
    <div className="flex items-center gap-2.5 mb-4">
      <div className={`w-8 h-8 rounded-lg ${color} flex items-center justify-center shadow-sm`}>
        <Icon size={15} className="text-white" />
      </div>
      <div>
        <p className="text-sm font-black uppercase tracking-tight leading-tight">{title}</p>
        <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest">{sub}</p>
      </div>
    </div>
  )
}

// ── Main export — Carousel swipeable ─────────────────────────────────────────
export function ProductTicker({ products, onProductClick }: ProductTickerProps) {
  const [current, setCurrent] = useState(0)
  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)
  const isDragging  = useRef(false)

  // Ordre stable dès le premier rendu, identique serveur/client, et qui ne
  // change plus par la suite (pas de re-mélange après le montage : les
  // images affichées ne doivent pas changer juste après le chargement).
  const filtered = useMemo(
    () => products.filter(p => p.image && p.image !== '/placeholder.jpg'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [products.length]
  )
  // Produits dont l'image a echoue au chargement : on les retire du pool
  // affiche pour ne jamais montrer un produit "casse" sur la page d'accueil.
  const [brokenIds, setBrokenIds] = useState<Set<number>>(new Set())
  const onImageError = useCallback((id: number) => {
    setBrokenIds(prev => new Set(prev).add(id))
  }, [])

  const visiblePool = filtered.filter(p => !brokenIds.has(p.id))
  const hasEnoughProducts = visiblePool.length >= 4

  const row1 = visiblePool.slice(0, 3)
  const row2 = visiblePool.slice(3, 7)
  const hero = visiblePool[7] ?? visiblePool[0]
  const row4 = visiblePool.slice(8, 14)

  const slides = hasEnoughProducts ? [
    { bg: 'bg-white',       row: <Row3 products={row1} onClick={onProductClick} onImageError={onImageError} />,                      icon: TrendingUp, title: 'Populaires', sub: 'Les plus consultés', color: 'bg-accent' },
    { bg: 'bg-gray-50/80',  row: <Row4 products={row2} onClick={onProductClick} onImageError={onImageError} />,                      icon: ShoppingBag,title: 'Tendances',  sub: 'Cette semaine',     color: 'bg-primary' },
    { bg: 'bg-white',       row: <RowHero product={hero} onClick={onProductClick} onImageError={onImageError} />,                    icon: Star,       title: 'En Vedette', sub: 'Sélection MIAD',    color: 'bg-yellow-500' },
    { bg: 'bg-gray-50/80',  row: row4.length > 0 ? <Row6 products={row4} onClick={onProductClick} onImageError={onImageError} /> : null, icon: Compass, title: 'Découvrir', sub: 'Nouvelles arrivées', color: 'bg-teal-500' },
  ].filter(s => s.row !== null) : []

  // total doit toujours valoir au moins 1 pour ces deux useCallback : ils sont
  // appelés à chaque rendu (avant le "return null" ci-dessous) pour respecter
  // les Rules of Hooks — les appeler conditionnellement faisait planter React
  // dès que visiblePool passait sous 4 articles après un premier rendu réussi.
  const total = slides.length || 1
  const prev  = useCallback(() => setCurrent(c => (c - 1 + total) % total), [total])
  const next  = useCallback(() => setCurrent(c => (c + 1) % total), [total])

  if (!hasEnoughProducts) return null

  const onTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation()
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
    isDragging.current  = false
  }

  const onTouchMove = (e: React.TouchEvent) => {
    e.stopPropagation()
    if (!touchStartX.current || !touchStartY.current) return
    const dx = Math.abs(e.touches[0].clientX - touchStartX.current)
    const dy = Math.abs(e.touches[0].clientY - touchStartY.current)
    // Seulement intercepter si le geste est clairement horizontal
    if (dx > dy && dx > 10) isDragging.current = true
  }

  const onTouchEnd = (e: React.TouchEvent) => {
    e.stopPropagation()
    if (!touchStartX.current || !isDragging.current) { touchStartX.current = null; return }
    const diff = e.changedTouches[0].clientX - touchStartX.current
    if (diff < -50) next()
    else if (diff > 50) prev()
    touchStartX.current = null
    isDragging.current  = false
  }

  const slide = slides[current]

  return (
    <div className="border-y border-border/30 select-none">
      {/* Slide actif */}
      <section
        className={`${slide.bg} py-6 transition-all duration-300`}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{ touchAction: 'pan-y' }}
      >
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between mb-4">
            <SectionHeader icon={slide.icon} title={slide.title} sub={slide.sub} color={slide.color} />
            {/* Contrôles navigation */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={prev}
                className="w-8 h-8 rounded-full border border-border flex items-center justify-center hover:bg-muted transition-colors"
                aria-label="Précédent"
              >
                <ChevronLeft size={16} />
              </button>
              {/* Points indicateurs */}
              <div className="flex gap-1.5">
                {slides.map((s, i) => (
                  <button
                    type="button"
                    key={s.title}
                    onClick={() => setCurrent(i)}
                    className={`h-1.5 rounded-full transition-all duration-300 ${i === current ? 'w-6 bg-accent' : 'w-1.5 bg-border'}`}
                    aria-label={`Slide ${i + 1}`}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={next}
                className="w-8 h-8 rounded-full border border-border flex items-center justify-center hover:bg-muted transition-colors"
                aria-label="Suivant"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
          <div key={current} className="animate-in fade-in duration-150">
            {slide.row}
          </div>
        </div>
      </section>
    </div>
  )
}

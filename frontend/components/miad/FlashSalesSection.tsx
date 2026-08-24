"use client"

import { useEffect, useState, useRef, useSyncExternalStore } from 'react'
import { useCurrency } from '@/contexts/CurrencyContext'
import { Zap, ChevronLeft, ChevronRight, ShoppingCart, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { type WooProduct } from '@/lib/woocommerce'
import { LazyImage } from './LazyImage'

interface FlashSalesSectionProps {
  products: WooProduct[]
  onProductClick: (product: WooProduct) => void
  onAddToCart: (product: WooProduct) => void
}

function ProductImage({ product }: { product: WooProduct }) {
  const [errored, setErrored] = useState(false)
  const hasImage = product.image && product.image !== '/placeholder.jpg' && !errored
  return hasImage ? (
    <LazyImage
      src={product.image}
      alt={product.name}
      decoding="async"
      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
      onError={() => setErrored(true)}
    />
  ) : (
    <div className="w-full h-full flex items-center justify-center bg-linear-to-br from-accent/20 to-primary/20">
      <span className="text-4xl">🛍️</span>
    </div>
  )
}

// Compte à rebours jusqu'à minuit — piloté hors état React pour que le
// serveur rende toujours le même placeholder (0h 0m 0s) et que le client se
// synchronise sur la vraie valeur en un seul commit, sans flash après le
// premier paint (voir react-doctor/rendering-hydration-no-flicker).
const ZERO_TIME_LEFT = { h: 0, m: 0, s: 0 }

function computeTimeLeft() {
  const now = new Date()
  const midnight = new Date(now)
  midnight.setHours(24, 0, 0, 0)
  const diff = midnight.getTime() - now.getTime()
  return {
    h: Math.floor(diff / 3_600_000),
    m: Math.floor((diff % 3_600_000) / 60_000),
    s: Math.floor((diff % 60_000) / 1_000),
  }
}

// Calculée une seule fois à l'évaluation du module côté client (jamais côté
// serveur, où ZERO_TIME_LEFT reste la valeur — cf. getServerTimeLeftSnapshot)
// pour que le premier rendu client affiche déjà la vraie valeur sans flash.
let clientTimeLeft = typeof window !== 'undefined' ? computeTimeLeft() : ZERO_TIME_LEFT

// subscribe() ne doit JAMAIS modifier ce que getSnapshot() retournerait comme
// effet de bord direct — sinon useSyncExternalStore détecte un changement de
// snapshot juste après l'abonnement, force un re-render, qui se réabonne et
// remute à nouveau : boucle infinie ("Maximum update depth exceeded"). Ici on
// se contente de programmer les mises à jour futures via setInterval.
function subscribeTimeLeft(callback: () => void) {
  const id = setInterval(() => {
    clientTimeLeft = computeTimeLeft()
    callback()
  }, 1000)
  return () => clearInterval(id)
}

function getTimeLeftSnapshot() {
  return clientTimeLeft
}

function getServerTimeLeftSnapshot() {
  return ZERO_TIME_LEFT
}

export function FlashSalesSection({ products, onProductClick, onAddToCart }: FlashSalesSectionProps) {
  const { formatPrice: fp } = useCurrency()
  const timeLeft = useSyncExternalStore(subscribeTimeLeft, getTimeLeftSnapshot, getServerTimeLeftSnapshot)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isAtStart, setIsAtStart] = useState(true)
  const [isAtEnd, setIsAtEnd] = useState(false)

  const saleProducts = products.filter(p => p.regularPrice && p.regularPrice > p.price)

  const checkScrollPosition = () => {
    if (scrollRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current
      setIsAtStart(scrollLeft === 0)
      setIsAtEnd(scrollLeft + clientWidth >= scrollWidth)
    }
  }

  useEffect(() => {
    checkScrollPosition() // Initial check
    const currentRef = scrollRef.current
    currentRef?.addEventListener('scroll', checkScrollPosition)
    window.addEventListener('resize', checkScrollPosition) // Re-check on resize
    return () => {
      currentRef?.removeEventListener('scroll', checkScrollPosition)
      window.removeEventListener('resize', checkScrollPosition)
    }
  }, [saleProducts]) // Re-run if saleProducts change

  const scroll = (dir: 'left' | 'right') => {
    if (scrollRef.current) {
      const scrollAmount = 300; // Adjust as needed
      scrollRef.current.scrollBy({ left: dir === 'left' ? -scrollAmount : scrollAmount, behavior: 'smooth' })
    }
  }

  if (saleProducts.length === 0) return null

  return (
    <section className="py-3 bg-red-50 border-y border-red-100">
      <div className="container mx-auto px-4">
        {/* Header compact style AliExpress LIVE */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {/* Badge LIVE animé */}
            <div className="flex items-center gap-1 px-2.5 py-1 bg-red-500 rounded-md">
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
              <Zap size={12} className="text-white fill-white" />
              <span className="text-xs font-black text-white tracking-wider">FLASH</span>
            </div>
            {/* Countdown */}
            <div className="flex items-center gap-1">
              <Clock size={12} className="text-red-400" />
              {[
                { v: timeLeft.h, l: 'h' },
                { v: timeLeft.m, l: 'm' },
                { v: timeLeft.s, l: 's' },
              ].map(({ v, l }, i) => (
                <span key={l} className="flex items-center gap-0.5">
                  <span className="bg-red-500 text-white text-[10px] font-black px-1 py-0.5 rounded min-w-5 text-center tabular-nums">
                    {String(v).padStart(2, '0')}{l}
                  </span>
                  {i < 2 && <span className="text-red-300 text-[10px] font-black">:</span>}
                </span>
              ))}
            </div>
          </div>

          {/* Scroll controls */}
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => scroll('left')}
              disabled={isAtStart}
              aria-label="Défiler vers la gauche"
              className="w-7 h-7 rounded-full border border-red-200 bg-white flex items-center justify-center hover:bg-red-500 hover:text-white hover:border-red-500 transition-colors disabled:opacity-30"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              onClick={() => scroll('right')}
              disabled={isAtEnd}
              aria-label="Défiler vers la droite"
              className="w-7 h-7 rounded-full border border-red-200 bg-white flex items-center justify-center hover:bg-red-500 hover:text-white hover:border-red-500 transition-colors disabled:opacity-30"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>

        {/* Products scroll — cartes compactes */}
        <div
          ref={scrollRef}
          onScroll={checkScrollPosition}
          className="flex gap-2 overflow-x-auto scrollbar-hide pb-1"
        >
          {saleProducts.map(product => {
            const discount = product.regularPrice
              ? Math.round((1 - product.price / product.regularPrice) * 100)
              : 0

            return (
              <div
                key={product.id}
                onClick={() => onProductClick(product)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onProductClick(product) }}
                className="shrink-0 w-28 bg-white rounded-xl border border-red-100 overflow-hidden hover:shadow-md hover:border-red-300 transition-all cursor-pointer group"
              >
                {/* Image compacte */}
                <div className="relative h-24 bg-muted overflow-hidden">
                  <ProductImage product={product} />
                  <span className="absolute top-1 left-1 bg-red-500 text-white text-[9px] font-black px-1.5 py-0.5 rounded-full">
                    -{discount}%
                  </span>
                </div>
                {/* Info */}
                <div className="p-1.5">
                  <p className="text-[10px] text-foreground font-medium line-clamp-1 leading-tight">
                    {product.name}
                  </p>
                  <p className="text-xs font-black text-red-500 mt-0.5">
                    {fp(Number(product.price || 0))}
                  </p>
                  <p className="text-[9px] text-muted-foreground line-through">
                    {fp(Number(product.regularPrice || 0))}
                  </p>
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      onAddToCart(product)
                      toast.success("Ajouté au panier", {
                        description: product.name,
                        position: 'top-center',
                        style: { background: '#1f2937', color: '#ffffff', borderRadius: '1rem' }
                      })
                    }}
                    className="mt-1 w-full py-1 bg-red-500 hover:bg-red-600 text-white text-[9px] font-bold rounded-lg transition-colors flex items-center justify-center gap-1"
                  >
                    <ShoppingCart size={10} />
                    Acheter
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

"use client"

import { useState, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ShoppingCart, Home, Star, BadgeCheck } from 'lucide-react'
import { getBalance, canClaimDaily } from '@/lib/coins'
import { CurrencySelector } from '@/components/miad/CurrencySelector'

function getInitialCartCount(): number {
  if (typeof window === 'undefined') return 0
  try {
    const raw = localStorage.getItem('miad_cart')
    const cart = raw ? JSON.parse(raw) : []
    return cart.reduce((s: number, i: any) => s + i.quantity, 0)
  } catch {
    return 0
  }
}

interface StandaloneHeaderProps {
  /** Mode "product" : affiche le nom + prix du produit */
  mode: 'product' | 'vendor' | 'category'
  title: string
  subtitle?: string       // prix (product) ou nb produits (vendor)
  image?: string          // thumbnail produit ou logo vendeur
  rating?: number
  verified?: boolean
  countryCode?: string
}

export function StandaloneHeader({
  mode, title, subtitle, image, rating, verified, countryCode
}: StandaloneHeaderProps) {
  const router   = useRouter()
  const [cartCount,  setCartCount]  = useState(getInitialCartCount)
  const [coins,      setCoins]      = useState(getBalance)
  const [hasBonus,   setHasBonus]   = useState(canClaimDaily)
  const [scrolled,   setScrolled]   = useState(false)

  useEffect(() => {
    // Scroll shadow
    const onScroll = () => setScrolled(window.scrollY > 4)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const handleBack = () => {
    if (window.history.length > 1) window.history.back()
    else router.push('/')
  }

  return (
    <header className={`sticky top-0 z-50 transition-shadow ${scrolled ? 'shadow-lg' : ''}`}
      style={{ background: 'linear-gradient(90deg,#0A0A0A 0%,#1A1000 60%,#2D1800 100%)' }}
    >
      <div className="flex items-center h-14 px-3 gap-2">

        {/* ── Back ── */}
        <button type="button" onClick={handleBack} aria-label="Retour"
          className="shrink-0 w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white transition-colors">
          <ArrowLeft size={18}/>
        </button>

        {/* ── Product / Vendor info ── */}
        <div className="flex-1 flex items-center gap-2.5 min-w-0 overflow-hidden">
          {/* thumbnail */}
          {image && (
            <div className="relative shrink-0 w-8 h-8 rounded-lg overflow-hidden bg-white/10 border border-white/10">
              <Image src={image} alt={title} fill className="object-cover"/>
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p className="text-white font-black text-xs truncate leading-tight">{title}</p>
              {verified && (
                <span className="shrink-0 w-3.5 h-3.5 bg-blue-500 rounded-full flex items-center justify-center">
                  <BadgeCheck size={8} className="text-white"/>
                </span>
              )}
              {countryCode && (
                <span className="shrink-0 text-[9px] bg-white/15 text-white/70 px-1 rounded font-bold uppercase">
                  {countryCode}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {subtitle && (
                <span className={`text-[11px] font-bold leading-none ${
                  mode === 'product' ? 'text-amber-400' : 'text-white/60'
                }`}>
                  {mode === 'product' ? subtitle : subtitle}
                </span>
              )}
              {rating != null && rating > 0 && (
                <span className="flex items-center gap-0.5 text-[10px] text-yellow-400">
                  <Star size={9} className="fill-yellow-400"/>
                  {rating.toFixed(1)}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ── Coins badge ── */}
        <Link href="/coins" className="relative shrink-0 flex flex-col items-center">
          <div className="w-7 h-7 rounded-full flex items-center justify-center relative"
            style={{
              background:'radial-gradient(circle at 32% 28%,#FFE566,#F5A623,#8B5E00)',
              border:'1.5px solid #DAA520',
              boxShadow:'0 2px 8px rgba(245,166,35,.45)',
            }}>
            <span style={{fontSize:12,fontWeight:900,color:'#5C3800',fontFamily:'Georgia,serif'}}>M</span>
            {hasBonus && (
              <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-red-500 rounded-full border border-black"/>
            )}
          </div>
          <span className="text-[8px] font-black text-amber-400 leading-none mt-0.5">
            {coins > 999 ? (coins/1000).toFixed(1)+'k' : coins}
          </span>
        </Link>

        {/* ── Currency ── */}
        <CurrencySelector className="[&_button]:text-white/80 [&_button]:bg-white/10 [&_button]:hover:bg-white/20 [&_div]:bg-card" />

        {/* ── Cart ── */}
        <button type="button" onClick={() => router.push('/')}
          className="relative shrink-0 w-9 h-9 flex items-center justify-center text-white hover:bg-white/10 rounded-full transition-colors">
          <ShoppingCart size={19}/>
          {cartCount > 0 && (
            <span className="absolute top-0.5 right-0.5 w-4 h-4 bg-amber-400 text-black text-[9px] font-black rounded-full flex items-center justify-center">
              {cartCount > 9 ? '9+' : cartCount}
            </span>
          )}
        </button>

        {/* ── Home ── */}
        <Link href="/"
          className="shrink-0 w-9 h-9 flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 rounded-full transition-colors">
          <Home size={17}/>
        </Link>
      </div>

      {/* thin gold line */}
      <div className="h-px w-full" style={{background:'linear-gradient(90deg,transparent,#F5A623,transparent)'}}/>
    </header>
  )
}

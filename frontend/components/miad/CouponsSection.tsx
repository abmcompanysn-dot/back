"use client"

import { useEffect, useState, useSyncExternalStore } from 'react'
import { LazyMotion, domAnimation, m, AnimatePresence } from 'framer-motion'
import { Ticket, Check, Copy, ChevronRight, Clock, Zap } from 'lucide-react'
import Link from 'next/link'

// Coupons affichés = ceux réellement en base (loyalty-svc via /api/coupons),
// plus de DEMO_COUPONS en dur. Le back-office (console admin → Marketing →
// Coupons) les crée/modifie. On fabrique ici le libellé + le dégradé
// d'affichage à partir de { code, type, amount, expires_at }.
interface ApiCoupon {
  code: string
  type: 'percent' | 'fixed'
  amount: number // percent: 1-100 ; fixed: centimes USD
  expires_at?: string
}
interface DisplayCoupon {
  code: string
  label: string
  sublabel: string
  expiry: string
  gradient: string
}

const GRADIENTS = [
  'from-orange-500 to-amber-400',
  'from-emerald-500 to-teal-400',
  'from-red-500 to-rose-400',
  'from-purple-500 to-violet-400',
  'from-blue-500 to-cyan-400',
]

function toDisplay(c: ApiCoupon, i: number): DisplayCoupon {
  const label = c.type === 'percent' ? `${c.amount}% OFF` : `-${(c.amount / 100).toFixed(2)} $`
  return {
    code: c.code,
    label,
    sublabel: 'Code promo',
    expiry: c.expires_at || '2099-12-31',
    gradient: GRADIENTS[i % GRADIENTS.length],
  }
}

const CLAIMED_KEY = 'miad_claimed_coupons:v1'

// Référence stable : useSyncExternalStore compare les snapshots par
// Object.is, donc un nouveau tableau à chaque appel (que ce soit [] ou un
// JSON.parse frais) casse cette comparaison et déclenche une boucle infinie
// ("Maximum update depth exceeded") — vu en dev sur <CouponsSection>. On ne
// recalcule/renvoie un nouveau tableau que si le contenu brut a changé.
const EMPTY_CLAIMED_CODES: string[] = []
let cachedClaimedRaw: string | null = null
let cachedClaimedCodes: string[] = EMPTY_CLAIMED_CODES

function getClaimedCodes(): string[] {
  if (typeof window === 'undefined') return EMPTY_CLAIMED_CODES
  const raw = localStorage.getItem(CLAIMED_KEY) || '[]'
  if (raw !== cachedClaimedRaw) {
    cachedClaimedRaw = raw
    try { cachedClaimedCodes = JSON.parse(raw) } catch { cachedClaimedCodes = EMPTY_CLAIMED_CODES }
  }
  return cachedClaimedCodes
}

function getServerClaimedCodes(): string[] {
  return EMPTY_CLAIMED_CODES
}

const claimedListeners = new Set<() => void>()

function subscribeClaimed(listener: () => void) {
  claimedListeners.add(listener)
  return () => claimedListeners.delete(listener)
}

function claimCode(code: string) {
  const list = getClaimedCodes()
  if (!list.includes(code)) {
    // Nouveau tableau plutôt que list.push(code) : list peut être la
    // référence mise en cache par getClaimedCodes(), la muter directement
    // court-circuiterait la comparaison raw !== cachedClaimedRaw ci-dessus.
    localStorage.setItem(CLAIMED_KEY, JSON.stringify([...list, code]))
    claimedListeners.forEach(l => l())
  }
}

interface CouponsSectionProps {
  onNavigate?: (view: any) => void
}

export function CouponsSection({ onNavigate }: CouponsSectionProps) {
  const claimed = useSyncExternalStore(subscribeClaimed, getClaimedCodes, getServerClaimedCodes)
  const [copied, setCopied] = useState<string | null>(null)
  const [coupons, setCoupons] = useState<DisplayCoupon[]>([])

  useEffect(() => {
    let cancelled = false
    fetch('/api/coupons')
      .then((r) => (r.ok ? r.json() : { coupons: [] }))
      .then((d) => {
        if (!cancelled) setCoupons((d.coupons || []).map(toDisplay))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const handleClaim = (code: string) => {
    claimCode(code)
    // Copy to clipboard
    navigator.clipboard?.writeText(code).catch(() => {})
    setCopied(code)
    setTimeout(() => setCopied(null), 2000)
  }

  // Aucun coupon actif en base → on ne rend rien (avant : 5 codes de démo
  // toujours visibles).
  if (coupons.length === 0) return null

  return (
    <LazyMotion features={domAnimation}>
      <section className="py-4 bg-background">
        <div className="container mx-auto px-4">
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-red-500 flex items-center justify-center">
                <Ticket size={14} className="text-white"/>
              </div>
              <span className="font-black text-sm text-foreground uppercase tracking-wide">Tickets Réduction</span>
              <span className="text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded-full font-black animate-pulse">
                LIVE
              </span>
            </div>
            <Link href="/coins" className="text-[11px] text-accent font-bold flex items-center gap-0.5">
              Voir tout <ChevronRight size={12}/>
            </Link>
          </div>

          {/* Coupon cards — horizontal scroll */}
          <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide snap-x snap-mandatory">
            {coupons.map(coupon => {
              const isClaimed = claimed.includes(coupon.code)
              const isCopied  = copied === coupon.code
              const daysLeft = Math.ceil((new Date(coupon.expiry).getTime() - Date.now()) / 86400000)

              return (
                <m.div
                  key={coupon.code}
                  whileHover={{ y: -3, scale: 1.02 }}
                  whileTap={{ scale: 0.97 }}
                  role="button"
                  tabIndex={0}
                  aria-label={`Réclamer le code ${coupon.code}`}
                  className="snap-start shrink-0 w-36 sm:w-40 rounded-2xl overflow-hidden shadow-md cursor-pointer"
                  onClick={() => !isClaimed && handleClaim(coupon.code)}
                  onKeyDown={e => { if (!isClaimed && (e.key === 'Enter' || e.key === ' ')) handleClaim(coupon.code) }}
                >
                  {/* Top colored section */}
                  <div className={`bg-linear-to-br ${coupon.gradient} px-3 pt-3 pb-2 relative overflow-hidden`}>
                    {/* dot pattern */}
                    <div className="absolute inset-0 opacity-[.12]"
                      style={{ backgroundImage:'radial-gradient(circle,white 1px,transparent 1px)', backgroundSize:'12px 12px' }}/>
                    <p className="text-2xl font-black text-white leading-none relative z-10">{coupon.label}</p>
                    <p className="text-[11px] text-white/80 relative z-10 mt-0.5">{coupon.sublabel}</p>
                  </div>

                  {/* Bottom white section */}
                  <div className={`bg-white border border-gray-100 px-3 py-2 ${isClaimed ? 'opacity-70' : ''}`}>
                    <div className="flex items-center gap-1 mb-2">
                      <Clock size={9} className="text-gray-400"/>
                      <span className="text-[9px] text-gray-400" suppressHydrationWarning>{daysLeft}j restants</span>
                    </div>

                    <div className={`w-full text-[10px] font-black py-1.5 rounded-lg text-center flex items-center justify-center gap-1 transition-all ${
                      isClaimed
                        ? 'bg-gray-100 text-gray-400'
                        : 'bg-red-50 text-red-600 hover:bg-red-100'
                    }`}>
                      <AnimatePresence mode="wait">
                        {isCopied ? (
                          <m.span key="copied" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
                            className="flex items-center gap-1 text-emerald-600">
                            <Check size={11}/> Copié !
                          </m.span>
                        ) : isClaimed ? (
                          <m.span key="claimed" initial={{opacity:0}} animate={{opacity:1}} className="flex items-center gap-1">
                            <Check size={11}/> Réclamé
                          </m.span>
                        ) : (
                          <m.span key="claim" initial={{opacity:0}} animate={{opacity:1}} className="flex items-center gap-1">
                            <Ticket size={11}/> Réclamer
                          </m.span>
                        )}
                      </AnimatePresence>
                    </div>

                    {isClaimed && (
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); handleClaim(coupon.code) }}
                        className="w-full text-[9px] text-gray-400 flex items-center justify-center gap-0.5 mt-1"
                        aria-label="Copier le code"
                      >
                        <Copy size={9}/> Copier le code
                      </button>
                    )}
                  </div>
                </m.div>
              )
            })}

            {/* "Voir plus" card */}
            <Link href="/coins"
              className="snap-start shrink-0 w-24 rounded-2xl border-2 border-dashed border-gray-200 flex flex-col items-center justify-center gap-1 text-gray-400 hover:border-amber-300 hover:text-amber-500 transition-colors">
              <Zap size={18}/>
              <span className="text-[10px] font-bold text-center px-2">Plus d'offres</span>
            </Link>
          </div>
        </div>
      </section>
    </LazyMotion>
  )
}

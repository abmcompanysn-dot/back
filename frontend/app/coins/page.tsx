"use client"

import { useState, useEffect, useCallback, useReducer } from 'react'
import { LazyMotion, domAnimation, m, AnimatePresence } from 'framer-motion'
import {
  ArrowLeft, ShoppingBag, Calendar, Gift, ChevronRight,
  Sparkles, TrendingUp, Check, Zap, Star, Clock, Share2,
  Users, Trophy, Flame, Coins
} from 'lucide-react'
import Link from 'next/link'
import {
  getBalance, canClaimDaily, getHistory, addCoins,
  getCalendar, getStreak, getBadge, getNextBadge, toFCFA, toUSD,
  COINS_DAILY, COINS_PER_PURCHASE, COINS_PER_SHARE, COINS_REFERRAL,
  BADGES, syncCoinsFromAPI, claimDailyAPI,
  type CoinTx
} from '@/lib/coins'

/* ── 3D Gold Coin ──────────────────────────────────────────────────── */
function GoldCoin({ size = 100, spin = false }: { size?: number; spin?: boolean }) {
  return (
    <div style={{ perspective: 900 }}>
      <m.div
        animate={spin ? { rotateY: 360 } : { rotateY: [0, 22, -22, 0] }}
        transition={
          spin
            ? { duration: 1.4, repeat: Infinity, ease: 'linear' }
            : { duration: 5, repeat: Infinity, ease: 'easeInOut' }
        }
        style={{ transformStyle: 'preserve-3d' }}
      >
        <div style={{
          width: size, height: size, borderRadius: '50%',
          background: 'radial-gradient(circle at 30% 28%, #FFF176, #F5A623 45%, #8B5E00)',
          boxShadow: [
            `0 ${size*.07}px ${size*.28}px rgba(245,166,35,.6)`,
            `inset -${size*.04}px -${size*.04}px ${size*.1}px rgba(0,0,0,.3)`,
            `inset ${size*.04}px ${size*.04}px ${size*.1}px rgba(255,240,140,.45)`,
          ].join(','),
          border: `${size*.045}px solid #DAA520`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative', overflow: 'hidden',
        }}>
          {/* inner ring */}
          <div style={{
            position:'absolute', inset: size*.1, borderRadius:'50%',
            border:`${size*.025}px solid rgba(218,165,32,.55)`,
          }}/>
          {/* MIAD logo text */}
          <span style={{
            fontSize: size*.22, fontWeight: 900, letterSpacing: 1,
            color: '#5C3800', fontFamily: 'Georgia,serif', zIndex:1,
            textShadow:`0 1px 0 rgba(255,240,100,.5)`,
          }}>MIAD</span>
          {/* shine */}
          <div style={{
            position:'absolute', top:'7%', left:'12%',
            width:'30%', height:'34%', borderRadius:'50%',
            background:'radial-gradient(circle,rgba(255,255,255,.55) 0%,transparent 70%)',
          }}/>
        </div>
      </m.div>
    </div>
  )
}

/* ── Animated counter ───────────────────────────────────────────────── */
function CountUp({ to }: { to: number }) {
  const [v, setV] = useState(0)
  useEffect(() => {
    let raf: number
    const t0 = performance.now(), from = v, dur = 900
    const tick = (now: number) => {
      const p = Math.min((now - t0) / dur, 1)
      setV(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to])
  return <>{v.toLocaleString('fr-FR')}</>
}

const WEEKDAY_LABELS = ['D','L','M','M','J','V','S']

/* ── 14-day check-in calendar ───────────────────────────────────────── */
function CheckInCalendar({ checked }: { checked: string[] }) {
  const [today, setToday] = useState<string | null>(null)
  useEffect(() => setToday(new Date().toISOString().slice(0, 10)), [])
  const checkedSet = new Set(checked)
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (13 - i))
    return d.toISOString().slice(0, 10)
  })
  return (
    <div className="grid grid-cols-7 gap-1.5">
      {days.map((day, i) => {
        const done = checkedSet.has(day)
        const isToday = day === today
        const dow = new Date(day).getDay()
        return (
          <div key={day} className="flex flex-col items-center gap-0.5">
            <span className="text-[9px] text-gray-400 uppercase">{WEEKDAY_LABELS[dow]}</span>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-black transition-all ${
              done
                ? 'bg-amber-400 text-white shadow shadow-amber-200'
                : isToday
                ? 'border-2 border-amber-300 text-amber-500'
                : 'bg-gray-100 text-gray-300'
            }`}>
              {done ? <Check size={12}/> : new Date(day).getDate()}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ── Badge card ─────────────────────────────────────────────────────── */
function BadgeRow({ balance }: { balance: number }) {
  const current = getBadge(balance)
  const next    = getNextBadge(balance)
  const progress = next
    ? Math.round(((balance - (current?.min ?? 0)) / (next.min - (current?.min ?? 0))) * 100)
    : 100

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4">
      <p className="font-black text-sm text-gray-800 mb-3 flex items-center gap-2">
        <Trophy size={15} className="text-amber-500"/> Niveau & Badges
      </p>
      <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
        {BADGES.map(b => {
          const unlocked = balance >= b.min
          return (
            <div key={b.id} className={`shrink-0 flex flex-col items-center gap-1 px-3 py-2 rounded-xl border transition-all ${
              unlocked ? 'border-amber-200 bg-amber-50' : 'border-gray-100 bg-gray-50 opacity-50'
            }`}>
              <span className="text-xl">{b.emoji}</span>
              <span className="text-[10px] font-black" style={{color: b.color}}>{b.label}</span>
              <span className="text-[9px] text-gray-400">{(b.min/1000).toFixed(0)}k</span>
            </div>
          )
        })}
      </div>
      {next && (
        <>
          <div className="flex justify-between text-[10px] text-gray-400 mb-1.5">
            <span>{current ? current.emoji + ' ' + current.label : 'Débutant'}</span>
            <span>{next.emoji} {next.label} — {(next.min - balance).toLocaleString('fr-FR')} restants</span>
          </div>
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
            <m.div
              className="h-full w-full rounded-full origin-left"
              style={{ background: `linear-gradient(90deg, #F5A623, ${next.color})` }}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: progress / 100 }}
              transition={{ duration: 1.1, ease: 'easeOut' }}
            />
          </div>
        </>
      )}
      {!next && (
        <p className="text-xs text-center text-amber-600 font-black py-1">💎 Niveau maximum atteint !</p>
      )}
    </div>
  )
}

/* ── Grouped page state (loads together, updates together) ───────────── */
interface CoinsState {
  balance: number
  history: CoinTx[]
  calendar: string[]
  streak: number
  canClaim: boolean
  claimed: boolean
  spinning: boolean
  burst: boolean
}

const initialCoinsState: CoinsState = {
  balance: 0, history: [], calendar: [], streak: 0,
  canClaim: false, claimed: false, spinning: false, burst: false,
}

type CoinsAction =
  | { type: 'loaded'; balance: number; history: CoinTx[]; calendar: string[]; streak: number; canClaim: boolean }
  | { type: 'synced'; balance: number; history: CoinTx[] }
  | { type: 'claimStart' }
  | { type: 'claimed'; balance: number; history: CoinTx[]; calendar: string[]; streak: number }
  | { type: 'burstEnd' }
  | { type: 'simulated'; balance: number; history: CoinTx[] }

function coinsReducer(state: CoinsState, action: CoinsAction): CoinsState {
  switch (action.type) {
    case 'loaded':
      return { ...state, balance: action.balance, history: action.history, calendar: action.calendar, streak: action.streak, canClaim: action.canClaim }
    case 'synced':
      return { ...state, balance: action.balance, history: action.history }
    case 'claimStart':
      return { ...state, spinning: true }
    case 'claimed':
      return { ...state, balance: action.balance, history: action.history, calendar: action.calendar, streak: action.streak, canClaim: false, claimed: true, spinning: false, burst: true }
    case 'burstEnd':
      return { ...state, burst: false }
    case 'simulated':
      return { ...state, balance: action.balance, history: action.history }
    default:
      return state
  }
}

/* ══════════════════════════════════════════════════════════════════════
   PAGE
══════════════════════════════════════════════════════════════════════ */
export default function CoinsPage() {
  const [state, dispatch] = useReducer(coinsReducer, initialCoinsState)
  const { balance, history, calendar, streak, canClaim, claimed, spinning, burst } = state

  useEffect(() => {
    // Charge d'abord le localStorage (instantané)
    dispatch({
      type: 'loaded',
      balance: getBalance(), history: getHistory(), calendar: getCalendar(),
      streak: getStreak(), canClaim: canClaimDaily(),
    })
    // Puis synchronise avec le vrai backend si connecté
    syncCoinsFromAPI().then(real => {
      if (real !== null) dispatch({ type: 'synced', balance: real, history: getHistory() })
    })
  }, [])

  const handleDaily = useCallback(async () => {
    if (!canClaim) return
    dispatch({ type: 'claimStart' })
    await claimDailyAPI()
    dispatch({
      type: 'claimed',
      balance: getBalance(), history: getHistory(), calendar: getCalendar(), streak: getStreak(),
    })
    setTimeout(() => dispatch({ type: 'burstEnd' }), 1200)
  }, [canClaim])

  const badge = getBadge(balance)

  return (
    <LazyMotion features={domAnimation}>
    <div className="min-h-screen bg-linear-to-b from-amber-50 via-white to-white">

      {/* ── Header ── */}
      <div className="sticky top-0 z-30 bg-white/85 backdrop-blur border-b border-amber-100 px-4 py-3 flex items-center gap-3">
        <Link href="/" className="p-1.5 rounded-full hover:bg-amber-50 transition-colors">
          <ArrowLeft size={20} className="text-amber-700"/>
        </Link>
        <span className="font-black text-lg text-amber-800 tracking-tight">MIAD Coins</span>
        {badge && (
          <span className="ml-1 text-sm">{badge.emoji}</span>
        )}
        <span className="ml-auto text-[10px] text-amber-600 font-medium bg-amber-50 px-2 py-0.5 rounded-full">
          100 000 C = 1 USD ≈ 600 FCFA
        </span>
      </div>

      <div className="max-w-lg mx-auto px-4 pb-28 pt-5 space-y-5">

        {/* ── Balance hero ── */}
        <m.div
          initial={{ opacity:0, y:18 }} animate={{ opacity:1, y:0 }}
          className="relative rounded-3xl overflow-hidden"
          style={{ background:'linear-gradient(135deg,#F5A623 0%,#E0780A 50%,#B85C00 100%)' }}
        >
          <div className="absolute inset-0 opacity-[.08]"
            style={{ backgroundImage:'radial-gradient(circle,white 1px,transparent 1px)', backgroundSize:'22px 22px' }}/>

          <div className="relative px-5 pt-5 pb-4 flex items-center gap-4">
            <div className="relative shrink-0">
              <GoldCoin size={86} spin={spinning}/>
              <AnimatePresence>
                {burst && (
                  <m.div key="burst"
                    initial={{ scale:.5, opacity:.9 }} animate={{ scale:2.8, opacity:0 }}
                    transition={{ duration:.75 }}
                    className="absolute inset-0 rounded-full bg-yellow-200 pointer-events-none"
                  />
                )}
              </AnimatePresence>
            </div>

            <div className="flex-1 text-white min-w-0">
              <p className="text-[11px] uppercase tracking-widest opacity-75 mb-0.5">Votre solde</p>
              <p className="text-4xl sm:text-5xl font-black leading-none mb-1">
                <CountUp to={balance}/>
              </p>
              <p className="text-xs opacity-80">MIAD Coins</p>
            </div>

            <div className="text-right shrink-0">
              <p className="text-[10px] text-white/60 uppercase mb-0.5">Valeur</p>
              <p className="text-white font-black text-sm">{toFCFA(balance)} FCFA</p>
              <p className="text-white/60 text-[10px]">${toUSD(balance)}</p>
              {streak > 1 && (
                <div className="mt-2 flex items-center gap-1 justify-end">
                  <Flame size={12} className="text-orange-200"/>
                  <span className="text-[11px] text-white/80 font-black">{streak}j</span>
                </div>
              )}
            </div>
          </div>

          {/* progress to next badge */}
          {getNextBadge(balance) && (
            <div className="px-5 pb-4">
              <div className="flex justify-between text-[10px] text-white/65 mb-1">
                <span>Vers {getNextBadge(balance)!.emoji} {getNextBadge(balance)!.label}</span>
                <span>{((getNextBadge(balance)!.min - balance) / 1000).toFixed(0)}k restants</span>
              </div>
              <div className="h-1.5 rounded-full bg-white/20 overflow-hidden">
                <m.div className="h-full w-full rounded-full bg-white/80 origin-left"
                  initial={{ scaleX:0 }}
                  animate={{ scaleX: Math.min((balance/(getNextBadge(balance)?.min??1)), 1) }}
                  transition={{ duration:1.2, ease:'easeOut' }}
                />
              </div>
            </div>
          )}
        </m.div>

        {/* ── Daily check-in ── */}
        <m.div
          initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }} transition={{ delay:.08 }}
          className={`rounded-2xl border-2 p-4 transition-all ${
            canClaim ? 'border-amber-300 bg-amber-50 shadow-md shadow-amber-100' : 'border-gray-100 bg-gray-50'
          }`}
        >
          <div className="flex items-center gap-3 mb-4">
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${
              canClaim ? 'bg-amber-400' : 'bg-gray-200'
            }`}>
              {claimed ? <Check size={22} className="text-white"/> : <Calendar size={22} className={canClaim?'text-white':'text-gray-400'}/>}
            </div>
            <div className="flex-1">
              <p className="font-black text-sm text-gray-800">Check-in quotidien</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {claimed ? '✓ Récupéré aujourd\'hui' : canClaim ? `+${COINS_DAILY} Coins disponibles !` : 'Reviens demain'}
              </p>
            </div>
            {streak > 0 && (
              <div className="text-center">
                <div className="flex items-center gap-0.5 justify-center">
                  <Flame size={14} className="text-orange-400"/>
                  <span className="text-lg font-black text-orange-500">{streak}</span>
                </div>
                <p className="text-[9px] text-gray-400">jours</p>
              </div>
            )}
            {canClaim && !claimed && (
              <button type="button" onClick={handleDaily} disabled={spinning}
                className="bg-amber-500 hover:bg-amber-600 text-white font-black text-xs px-4 py-2 rounded-xl transition-colors disabled:opacity-50 shrink-0">
                {spinning ? '…' : 'Récupérer'}
              </button>
            )}
          </div>
          <CheckInCalendar checked={calendar}/>
        </m.div>

        {/* ── Badge ── */}
        <m.div initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }} transition={{ delay:.12 }}>
          <BadgeRow balance={balance}/>
        </m.div>

        {/* ── Comment utiliser ── */}
        <m.div
          initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }} transition={{ delay:.15 }}
          className="rounded-2xl border border-amber-100 bg-amber-50 p-4"
        >
          <p className="font-black text-sm text-amber-800 mb-2 flex items-center gap-2">
            <Zap size={14} className="text-amber-500"/> Comment utiliser mes Coins ?
          </p>
          <div className="space-y-2 text-xs text-amber-700 leading-relaxed">
            <p>• Sur chaque produit, tes Coins s'appliquent comme <strong>réduction automatique</strong> sur le prix affiché.</p>
            <p>• <strong>100 000 Coins = 1 USD ≈ 600 FCFA</strong> de réduction effective.</p>
            <p>• Plus tu accumules, plus la réduction est visible sur l'étiquette produit.</p>
          </div>
        </m.div>

        {/* ── Ways to earn ── */}
        <m.div
          initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }} transition={{ delay:.18 }}
          className="rounded-2xl border border-gray-100 bg-white overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-gray-50 flex items-center gap-2">
            <TrendingUp size={14} className="text-emerald-500"/>
            <span className="font-black text-sm text-gray-800">Comment gagner des Coins</span>
          </div>
          {[
            { icon: Calendar,   label:'Connexion quotidienne',  coins:`+${COINS_DAILY}`,         color:'text-blue-500',   bg:'bg-blue-50'   },
            { icon: ShoppingBag,label:'Achat confirmé',          coins:`+${COINS_PER_PURCHASE}`,  color:'text-emerald-500',bg:'bg-emerald-50'},
            { icon: Share2,     label:'Partager un lien produit',coins:`+${COINS_PER_SHARE}`,     color:'text-purple-500', bg:'bg-purple-50' },
            { icon: Users,      label:'Inviter un ami',          coins:`+${COINS_REFERRAL}`,      color:'text-pink-500',   bg:'bg-pink-50'   },
            { icon: Star,       label:'Laisser un avis',         coins:'+30',                     color:'text-amber-500',  bg:'bg-amber-50'  },
          ].map(({ icon: Icon, label, coins, color, bg }) => (
            <div key={label} className="px-4 py-3 flex items-center gap-3 border-b border-gray-50 last:border-0">
              <div className={`w-9 h-9 rounded-xl ${bg} flex items-center justify-center shrink-0`}>
                <Icon size={16} className={color}/>
              </div>
              <span className="flex-1 text-sm text-gray-700">{label}</span>
              <span className="text-xs font-black text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">{coins}</span>
            </div>
          ))}
        </m.div>

        {/* ── History ── */}
        <m.div
          initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }} transition={{ delay:.22 }}
          className="rounded-2xl border border-gray-100 bg-white overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
            <span className="font-black text-sm text-gray-800">Historique</span>
            <span className="text-xs text-gray-400">{history.length} transactions</span>
          </div>

          {history.length === 0 ? (
            <div className="py-10 flex flex-col items-center gap-3 text-gray-400">
              <GoldCoin size={52}/>
              <p className="text-sm">Aucune transaction pour l'instant</p>
              <button type="button" onClick={() => { addCoins(500,'Achat simulé'); dispatch({ type: 'simulated', balance: getBalance(), history: getHistory() }) }}
                className="text-xs text-amber-600 underline underline-offset-2">
                Simuler un achat (+500 coins)
              </button>
            </div>
          ) : (
            history.slice(0, 20).map(tx => (
              <div key={tx.id} className="px-4 py-3 flex items-center gap-3 border-b border-gray-50 last:border-0">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                  tx.type==='earn' ? 'bg-emerald-50' : 'bg-red-50'
                }`}>
                  {tx.type==='earn'
                    ? <TrendingUp size={13} className="text-emerald-500"/>
                    : <ShoppingBag size={13} className="text-red-400"/>}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-gray-700 truncate">{tx.label}</p>
                  <p className="text-[10px] text-gray-400">
                    {new Date(tx.date).toLocaleDateString('fr-FR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}
                  </p>
                </div>
                <span className={`text-sm font-black ${tx.type==='earn'?'text-emerald-600':'text-red-500'}`}>
                  {tx.type==='earn'?'+':'-'}{tx.amount.toLocaleString('fr-FR')}
                </span>
              </div>
            ))
          )}
        </m.div>

        {/* ── CTA ── */}
        <m.div initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }} transition={{ delay:.26 }}>
          <Link href="/"
            className="flex items-center justify-between bg-gray-900 text-white rounded-2xl px-5 py-4 font-black text-sm">
            <span>Acheter pour gagner des Coins</span>
            <ChevronRight size={18}/>
          </Link>
        </m.div>

      </div>
    </div>
    </LazyMotion>
  )
}

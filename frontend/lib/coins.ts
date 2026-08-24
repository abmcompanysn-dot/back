// MIAD Coins — client-side loyalty store (localStorage)
// 1 Coin = 0.00001 USD  →  100 000 Coins = 1 USD ≈ 600 FCFA

export const COINS_VALUE_USD  = 0.00001          // valeur d'1 coin en USD
export const USD_TO_FCFA      = 600              // taux approximatif
export const COINS_PER_PURCHASE = 500
export const COINS_DAILY        = 50
export const COINS_PER_SHARE    = 200
export const COINS_REFERRAL     = 1000
const COINS_PER_REVIEW   = 30

export const BADGES = [
  { id: 'bronze', label: 'Bronze',   min: 10_000,  color: '#CD7F32', emoji: '🥉' },
  { id: 'silver', label: 'Argent',   min: 50_000,  color: '#C0C0C0', emoji: '🥈' },
  { id: 'gold',   label: 'Or',       min: 200_000, color: '#FFD700', emoji: '🥇' },
  { id: 'diamond',label: 'Diamant',  min: 500_000, color: '#B9F2FF', emoji: '💎' },
]

const KEY_BAL  = 'miad_coins_balance'
const KEY_DAY  = 'miad_coins_daily'
const KEY_HIST = 'miad_coins_history:v1'
const KEY_CAL  = 'miad_coins_calendar:v1'    // tableau de dates de check-in

export interface CoinTx {
  id: string
  type: 'earn' | 'spend'
  amount: number
  label: string
  date: string
}

// ── Balance ──────────────────────────────────────────────────────────
export function getBalance(): number {
  if (typeof window === 'undefined') return 0
  return parseInt(localStorage.getItem(KEY_BAL) || '0', 10)
}

export function addCoins(amount: number, label: string): number {
  const next = getBalance() + amount
  localStorage.setItem(KEY_BAL, String(next))
  _pushHistory({ type: 'earn', amount, label })
  return next
}

function spendCoins(amount: number, label: string): boolean {
  const bal = getBalance()
  if (bal < amount) return false
  localStorage.setItem(KEY_BAL, String(bal - amount))
  _pushHistory({ type: 'spend', amount, label })
  return true
}

// ── Daily check-in ───────────────────────────────────────────────────
export function canClaimDaily(): boolean {
  if (typeof window === 'undefined') return false
  const last = localStorage.getItem(KEY_DAY)
  if (!last) return true
  return new Date(last).toDateString() !== new Date().toDateString()
}

export function claimDaily(): number {
  if (!canClaimDaily()) return 0
  const now = new Date()
  localStorage.setItem(KEY_DAY, now.toISOString())
  // save to calendar
  const cal = getCalendar()
  const dateStr = now.toISOString().slice(0, 10)
  if (!cal.includes(dateStr)) {
    cal.push(dateStr)
    localStorage.setItem(KEY_CAL, JSON.stringify(cal.slice(-60)))
  }
  return addCoins(COINS_DAILY, 'Bonus quotidien')
}

// returns array of date strings 'YYYY-MM-DD' where user checked in
export function getCalendar(): string[] {
  if (typeof window === 'undefined') return []
  try { return JSON.parse(localStorage.getItem(KEY_CAL) || '[]') }
  catch { return [] }
}

// returns current streak (consecutive days)
export function getStreak(): number {
  const cal = getCalendar().sort().reverse()
  if (!cal.length) return 0
  let streak = 0
  let d = new Date()
  d.setHours(0, 0, 0, 0)
  for (const dateStr of cal) {
    const day = new Date(dateStr)
    day.setHours(0, 0, 0, 0)
    const diff = Math.round((d.getTime() - day.getTime()) / 86400000)
    if (diff === streak) { streak++; d = day }
    else if (diff > streak) break
  }
  return streak
}

// ── History ──────────────────────────────────────────────────────────
function _pushHistory(tx: Omit<CoinTx, 'id' | 'date'>) {
  const hist = getHistory()
  hist.unshift({ ...tx, id: Date.now().toString(), date: new Date().toISOString() })
  localStorage.setItem(KEY_HIST, JSON.stringify(hist.slice(0, 60)))
}

export function getHistory(): CoinTx[] {
  if (typeof window === 'undefined') return []
  try { return JSON.parse(localStorage.getItem(KEY_HIST) || '[]') }
  catch { return [] }
}

// ── Conversions ──────────────────────────────────────────────────────
export function toUSD(coins: number): string {
  return (coins * COINS_VALUE_USD).toFixed(4)
}

export function toFCFA(coins: number): string {
  return Math.round(coins * COINS_VALUE_USD * USD_TO_FCFA).toLocaleString('fr-FR')
}

// ── Badge ────────────────────────────────────────────────────────────
export function getBadge(balance: number) {
  return [...BADGES].reverse().find(b => balance >= b.min) || null
}

export function getNextBadge(balance: number) {
  return BADGES.find(b => balance < b.min) || null
}

// ── Real API sync (WordPress REST API) ──────────────────────────────
// Si le token JWT est présent → synchronise avec le vrai backend WooCommerce
// Sinon → reste en localStorage (mode démo)

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')

function getJwt(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('miad_token') || localStorage.getItem('token') || null
}

/** Synchronise le solde depuis le backend WordPress (si connecté) */
export async function syncCoinsFromAPI(): Promise<number | null> {
  const token = getJwt()
  if (!token) return null
  try {
    const res = await fetch(`${WOO_URL}/wp-json/miad/v1/coins`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    if (typeof data.balance === 'number') {
      localStorage.setItem(KEY_BAL, String(data.balance))
      if (Array.isArray(data.history) && data.history.length)
        localStorage.setItem(KEY_HIST, JSON.stringify(data.history))
      return data.balance
    }
    return null
  } catch { return null }
}

/** Réclame le bonus quotidien via l'API (si connecté) ou localStorage */
export async function claimDailyAPI(): Promise<number> {
  const token = getJwt()
  if (!token) return claimDaily()
  try {
    const res = await fetch(`${WOO_URL}/wp-json/miad/v1/coins/daily`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return claimDaily()
    const data = await res.json()
    if (data.claimed && typeof data.balance === 'number') {
      localStorage.setItem(KEY_BAL, String(data.balance))
      localStorage.setItem(KEY_DAY, new Date().toISOString())
      return data.balance
    }
    return getBalance()
  } catch { return claimDaily() }
}

/** Valide un coupon via le backend WordPress */
async function validateCouponAPI(code: string, subtotal: number): Promise<{
  valid: boolean; discount: number; message: string
}> {
  try {
    const res = await fetch(`${WOO_URL}/wp-json/miad/v1/coupons/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, subtotal }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return { valid: false, discount: 0, message: err.message || 'Code invalide' }
    }
    const data = await res.json()
    return { valid: true, discount: data.discount, message: `Code appliqué` }
  } catch {
    return { valid: false, discount: 0, message: 'Erreur réseau' }
  }
}

// ── Anchor pricing (displayed "before" price) ─────────────────────────
export function getAnchorPrice(price: number, regularPrice: number): {
  anchor: number
  discount: number
  isReal: boolean
} {
  if (regularPrice > price + 0.01) {
    return { anchor: regularPrice, discount: Math.round((1 - price / regularPrice) * 100), isReal: true }
  }
  return { anchor: Math.ceil(price * 1.15 * 100) / 100, discount: 13, isReal: false }
}

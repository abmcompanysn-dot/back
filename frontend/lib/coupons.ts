// ── Coupons disponibles ────────────────────────────────────────────────
// En production ces données viendraient du WooCommerce REST API
// GET /wp-json/wc/v3/coupons  (voir le snippet PHP miad-coins.php)
export const DEMO_COUPONS = [
  {
    code: 'MIAD10',
    type: 'percent' as const,
    value: 10,
    minPurchase: 30,
    currency: '$',
    label: '10% OFF',
    sublabel: 'Dès 30$',
    expiry: '2026-06-30',
    gradient: 'from-orange-500 to-amber-400',
    textColor: 'text-white',
  },
  {
    code: 'MIAD5',
    type: 'fixed' as const,
    value: 5,
    minPurchase: 20,
    currency: '$',
    label: '-5$',
    sublabel: 'Dès 20$',
    expiry: '2026-06-30',
    gradient: 'from-emerald-500 to-teal-400',
    textColor: 'text-white',
  },
  {
    code: 'AFRICA20',
    type: 'percent' as const,
    value: 20,
    minPurchase: 80,
    currency: '$',
    label: '20% OFF',
    sublabel: 'Dès 80$',
    expiry: '2026-07-15',
    gradient: 'from-red-500 to-rose-400',
    textColor: 'text-white',
  },
  {
    code: 'BIENVENUE',
    type: 'percent' as const,
    value: 15,
    minPurchase: 0,
    currency: '$',
    label: '15% OFF',
    sublabel: 'Nouveaux clients',
    expiry: '2026-12-31',
    gradient: 'from-purple-500 to-violet-400',
    textColor: 'text-white',
  },
  {
    code: 'MIAD3000',
    type: 'fixed_fcfa' as const,
    value: 3000,
    minPurchase: 10000,
    currency: 'FCFA',
    label: '-3 000 FCFA',
    sublabel: 'Dès 10 000 FCFA',
    expiry: '2026-06-30',
    gradient: 'from-blue-500 to-cyan-400',
    textColor: 'text-white',
  },
]

// Utilitaire : vérifier si un code est valide et calculer la réduction
export function validateCoupon(code: string, subtotal: number): {
  valid: boolean
  discount: number
  message: string
  type: string
} {
  const coupon = DEMO_COUPONS.find(c => c.code.toUpperCase() === code.toUpperCase().trim())
  if (!coupon) return { valid: false, discount: 0, message: 'Code invalide', type: '' }
  if (new Date(coupon.expiry) < new Date()) return { valid: false, discount: 0, message: 'Code expiré', type: '' }
  if (coupon.type !== 'fixed_fcfa' && subtotal < coupon.minPurchase)
    return { valid: false, discount: 0, message: `Minimum ${coupon.minPurchase}$ requis`, type: '' }

  let discount = 0
  if (coupon.type === 'percent') discount = (subtotal * coupon.value) / 100
  else if (coupon.type === 'fixed') discount = coupon.value
  else if (coupon.type === 'fixed_fcfa') discount = coupon.value / 600 // convert FCFA → USD

  return {
    valid: true,
    discount: Math.round(discount * 100) / 100,
    message: `Code appliqué : -${coupon.label}`,
    type: coupon.type,
  }
}

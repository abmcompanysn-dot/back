// Coupons — validés en base réelle (loyalty-svc, table `coupons`) via
// /api/coupons/validate. Plus de DEMO_COUPONS en dur : les codes se gèrent
// depuis le back-office (console admin → Marketing → Coupons).
//
// loyalty-svc renvoie { code, type: 'percent'|'fixed', amount, valid }.
//   - type 'percent' : amount = pourcentage (1-100)
//   - type 'fixed'   : amount = CENTIMES USD (500 = 5,00 $)
// Le calcul de la réduction sur le sous-total réel se fait ici.

export interface CouponResult {
  valid: boolean
  discount: number // en USD, déjà calculé sur le subtotal
  message: string
  type: string
}

export async function validateCoupon(code: string, subtotal: number): Promise<CouponResult> {
  const trimmed = code.trim()
  if (!trimmed) return { valid: false, discount: 0, message: 'Entrez un code', type: '' }

  let data: any
  try {
    const res = await fetch('/api/coupons/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: trimmed }),
    })
    data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { valid: false, discount: 0, message: data?.error || 'Code invalide', type: '' }
    }
  } catch {
    return { valid: false, discount: 0, message: 'Vérification impossible, réessayez', type: '' }
  }

  const amount = Number(data.amount) || 0
  let discount = 0
  if (data.type === 'percent') discount = (subtotal * amount) / 100
  else discount = amount / 100 // centimes → USD

  // Ne jamais dépasser le sous-total.
  discount = Math.min(discount, subtotal)

  return {
    valid: true,
    discount: Math.round(discount * 100) / 100,
    message: 'Code appliqué',
    type: data.type || '',
  }
}

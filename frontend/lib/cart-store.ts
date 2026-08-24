// Bus panier partagé — lecture/écriture localStorage + notification cross-arbre.
// Extrait de ProductDetailWrapper.tsx pour être réutilisable par n'importe quel
// arbre monté séparément (header, sections Server Component streamées côté
// accueil) qui n'a pas accès aux callbacks de MiadMarketClient.tsx.
import { type WooProduct, type WooProductVariation, type CartItem, toCartProduct } from './woocommerce'

const CART_KEY = 'miad_cart'

const cartListeners = new Set<() => void>()

// Notifie les abonnés dans le même arbre React (Set en mémoire) ET les autres
// arbres montés séparément via un CustomEvent — un simple Set ne suffit pas
// dès qu'on a plusieurs racines React indépendantes sur la même page.
function notifyCartChange(): void {
  cartListeners.forEach(l => l())
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('miad-cart-change'))
  }
}

// Le serveur rend toujours 0/[] (placeholder) — le client se synchronise sur
// la vraie valeur en un seul commit, sans flash après le premier paint.
function subscribeCart(listener: () => void): () => void {
  cartListeners.add(listener)
  if (typeof window === 'undefined') {
    return () => cartListeners.delete(listener)
  }
  const onStorage = (e: StorageEvent) => { if (e.key === CART_KEY) listener() }
  window.addEventListener('storage', onStorage)
  window.addEventListener('miad-cart-change', listener)
  return () => {
    cartListeners.delete(listener)
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('miad-cart-change', listener)
  }
}

function getCartCount(): number {
  try {
    const raw = localStorage.getItem(CART_KEY)
    const cart = raw ? JSON.parse(raw) : []
    return cart.reduce((s: number, i: any) => s + i.quantity, 0)
  } catch { return 0 }
}
function getServerCartCount(): number { return 0 }

// Référence stable pour useSyncExternalStore : ne reparse le JSON que si le
// contenu brut a changé depuis le dernier appel (Object.is sinon toujours
// "différent" à chaque appel, ce qui a déjà causé une boucle infinie ailleurs
// sur ce projet — voir CouponsSection.tsx pour le même correctif).
let cachedRaw: string | null = null
let cachedSnapshot: CartItem[] = []
const EMPTY_CART: CartItem[] = []

function getCartSnapshot(): CartItem[] {
  if (typeof window === 'undefined') return EMPTY_CART
  const raw = localStorage.getItem(CART_KEY)
  if (raw !== cachedRaw) {
    cachedRaw = raw
    try { cachedSnapshot = raw ? JSON.parse(raw) : EMPTY_CART } catch { cachedSnapshot = EMPTY_CART }
  }
  return cachedSnapshot
}
function getServerCartSnapshot(): CartItem[] { return EMPTY_CART }

function addItemToCart(product: WooProduct, quantity = 1, variation?: WooProductVariation): void {
  try {
    const raw = localStorage.getItem(CART_KEY)
    const cart: any[] = raw ? JSON.parse(raw) : []
    const cartKey = variation ? `${product.id}-${variation.id}` : String(product.id)
    const idx = cart.findIndex((i) =>
      (i.variation ? `${i.product.id}-${i.variation.id}` : String(i.product.id)) === cartKey
    )
    if (idx >= 0) {
      cart[idx].quantity += quantity
    } else {
      cart.push({ product: toCartProduct(product), quantity, variation })
    }
    localStorage.setItem(CART_KEY, JSON.stringify(cart))
    notifyCartChange()
  } catch {
    // localStorage indisponible — on ignore silencieusement
  }
}

export {
  CART_KEY,
  subscribeCart,
  getCartCount,
  getServerCartCount,
  getCartSnapshot,
  getServerCartSnapshot,
  addItemToCart,
  notifyCartChange,
}

import { mutate } from 'swr'

const SW_CACHE_NAME = 'miad-market-v6'

export async function clearAllCaches(options: {
  clearCart?: boolean
  reload?: boolean
} = {}) {
  // 1. Invalide tous les caches SWR (les données seront refetchées au prochain accès)
  await mutate(() => true, undefined, { revalidate: false })

  // 2. Vide le cache Service Worker
  if (typeof window !== 'undefined' && 'caches' in window) {
    await caches.delete(SW_CACHE_NAME).catch(() => {})
  }

  // 3. Vide le panier du localStorage (optionnel, ne touche pas au token)
  if (options.clearCart && typeof window !== 'undefined') {
    localStorage.removeItem('miad_cart')
  }

  // 4. Recharge la page si demandé
  if (options.reload && typeof window !== 'undefined') {
    window.location.reload()
  }
}

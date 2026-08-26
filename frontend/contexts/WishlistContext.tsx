"use client"

import { createContext, useContext, useCallback, useMemo, type ReactNode } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'

// Wishlist / favoris — construit le 2026-08-26. Charge une seule fois la
// liste complète des IDs favoris du client connecté (pas de requête par
// carte produit) : chaque ProductCard/ProductDetail consulte juste
// isFavorite(id) sur ce Set déjà en mémoire. Sauvegarde toujours côté
// serveur (jamais localStorage seul) — demandé explicitement : "se
// sauvegarde automatiquement" doit survivre à un changement d'appareil.

interface WishlistContextValue {
  ids: Set<string>
  isFavorite: (productId: string | number) => boolean
  toggle: (productId: string | number) => void
  loading: boolean
}

const WishlistContext = createContext<WishlistContextValue | null>(null)

const fetcher = (url: string) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('miad_token') : null
  return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then((r) => (r.ok ? r.json() : { products: [] }))
}

export function WishlistProvider({ children }: { children: ReactNode }) {
  const hasToken = typeof window !== 'undefined' && !!localStorage.getItem('miad_token')
  const { data, mutate, isLoading } = useSWR(hasToken ? '/api/wishlist' : null, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 30000,
  })

  const ids = useMemo(() => new Set<string>((data?.products || []).map((p: any) => String(p.id))), [data])

  const isFavorite = useCallback((productId: string | number) => ids.has(String(productId)), [ids])

  const toggle = useCallback(
    (productId: string | number) => {
      const token = localStorage.getItem('miad_token')
      if (!token) {
        toast.info('Connectez-vous pour sauvegarder vos favoris')
        return
      }
      const idStr = String(productId)
      const wasFavorite = ids.has(idStr)

      // Optimiste : le cœur change d'état immédiatement, avant la réponse
      // réseau — comportement attendu d'un bouton favori, jamais de
      // délai perceptible au clic.
      const optimisticProducts = wasFavorite
        ? (data?.products || []).filter((p: any) => String(p.id) !== idStr)
        : [...(data?.products || []), { id: productId }]
      mutate({ products: optimisticProducts }, { revalidate: false })

      const request = wasFavorite
        ? fetch(`/api/wishlist?product_id=${productId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
        : fetch('/api/wishlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ product_id: productId }),
          })

      request
        .then((res) => {
          if (!res.ok) throw new Error()
          // Revalide pour récupérer les vraies données produit (image/prix)
          // sur un ajout — l'entrée optimiste n'a que { id }.
          mutate()
        })
        .catch(() => {
          toast.error('Impossible de mettre à jour vos favoris')
          mutate() // repli sur l'état serveur réel
        })
    },
    [ids, data, mutate]
  )

  const value = useMemo(() => ({ ids, isFavorite, toggle, loading: isLoading }), [ids, isFavorite, toggle, isLoading])

  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>
}

export function useWishlist() {
  const ctx = useContext(WishlistContext)
  if (!ctx) {
    // Hors provider (ex: rendu isolé) : dégrade proprement plutôt que de
    // planter — un cœur qui ne fait rien plutôt qu'un crash de page.
    return { ids: new Set<string>(), isFavorite: () => false, toggle: () => {}, loading: false }
  }
  return ctx
}

'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Injecte une sentinelle initiale dans l'historique du navigateur.
 * MiadMarketClient intercepte tous les événements popstate et gère
 * lui-même la pile de navigation SPA.
 *
 * Passe par le routeur Next.js (router.push) plutot que par
 * window.history.pushState directement : toute entree d'historique que
 * Next.js App Router n'a pas lui-meme creee est traitee comme inconnue,
 * et un retour arriere vers une telle entree declenche un rechargement
 * complet de la page par securite (verifie : meme un pushState avec une
 * URL identique provoque ce rechargement). En passant par router.push,
 * Next.js suit l'entree et le retour reste une navigation douce.
 */
export default function BackNavigationGuard() {
  const router = useRouter()

  useEffect(() => {
    router.push(window.location.pathname + window.location.search, { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}

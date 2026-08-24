'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

/**
 * Détecte automatiquement le retour d'un lien magique Firebase (magic link email).
 * Doit être monté dans le layout global ou la page principale.
 *
 * Flux : user clique sur le lien → revient sur le site avec
 *   ?apiKey=...&oobCode=...&mode=signIn (ou ?auth=magic) dans l'URL
 * → ce composant complète la connexion Firebase → échange le token avec WordPress
 * → redirige vers le dashboard
 */
export default function MagicLinkHandler() {
  const router   = useRouter()
  const handled  = useRef(false)

  useEffect(() => {
    if (handled.current || typeof window === 'undefined') return

    const run = async () => {
      try {
        const { auth } = await import('@/lib/firebase')
        const { isSignInWithEmailLink, signInWithEmailLink } = await import('firebase/auth')

        if (!isSignInWithEmailLink(auth, window.location.href)) return

        handled.current = true

        // Récupérer l'email sauvegardé ou demander à l'utilisateur
        let email = localStorage.getItem('miad_email_for_signin') || ''
        if (!email) {
          email = window.prompt('Veuillez confirmer votre adresse email :') || ''
          if (!email) return
        }

        toast.loading('Connexion en cours…', { id: 'magic-link' })

        // Compléter la connexion Firebase
        const result = await signInWithEmailLink(auth, email, window.location.href)
        const idToken = await result.user.getIdToken()

        // Échanger le token Firebase contre un token WordPress
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ firebase_token: idToken }),
        })
        const data = await res.json()

        // Nettoyer l'email sauvegardé et l'URL
        localStorage.removeItem('miad_email_for_signin')
        window.history.replaceState({}, document.title, window.location.pathname)

        if (res.ok && data.token) {
          localStorage.setItem('miad_token', data.token)
          localStorage.setItem('miad_user', JSON.stringify({
            display_name:  data.user_display_name,
            user_email:    data.user_email || email,
            user_nicename: data.user_nicename,
            id:            data.id,
            avatar:        data.avatar,
          }))
          localStorage.setItem('miad_role', data.role || 'buyer')

          toast.success(`Bienvenue, ${data.user_display_name || email} !`, { id: 'magic-link' })

          // Rediriger vers le dashboard approprié
          const role = data.role || 'buyer'
          router.push(role === 'vendor' ? '/?view=vendorDashboard' : '/?view=clientDashboard')
        } else {
          toast.error(data.message || 'Connexion échouée. Réessayez.', { id: 'magic-link' })
        }
      } catch (err: any) {
        toast.error('Lien invalide ou expiré. Demandez un nouveau lien.', { id: 'magic-link' })
        console.error('[MagicLink]', err)
      }
    }

    run()
  }, [router])

  return null
}

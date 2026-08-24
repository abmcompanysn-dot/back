'use client'

import { useState, useEffect, Suspense } from 'react'
import Image from 'next/image'
import { useSearchParams, useRouter } from 'next/navigation'
import { Loader2, CheckCircle2, XCircle } from 'lucide-react'

/**
 * Page /auth — gestionnaire universel des liens Firebase.
 *
 * Firebase Console → Authentication → Templates → "Action URL"
 * doit pointer sur : https://www.miadmarket.com/auth
 *
 * Gère :
 *   mode=signIn       → connexion sans mot de passe (magic link)
 *   mode=resetPassword → réinitialisation de mot de passe
 *   mode=verifyEmail  → vérification d'email
 */

function AuthHandler() {
  const params  = useSearchParams()
  const router  = useRouter()
  const [step, setStep] = useState<'loading' | 'success' | 'error'>('loading')
  const [msg,  setMsg]  = useState('')

  const mode    = params.get('mode')    || ''
  const oobCode = params.get('oobCode') || ''

  useEffect(() => {
    if (!mode || !oobCode) {
      setStep('error')
      setMsg('Lien invalide ou expiré.')
      return
    }

    let redirectTimer: ReturnType<typeof setTimeout> | undefined

    const run = async () => {
      const { auth } = await import('@/lib/firebase')

      // ── Magic Link (connexion sans mot de passe) ──────────────────────────
      if (mode === 'signIn') {
        const { isSignInWithEmailLink, signInWithEmailLink } = await import('firebase/auth')

        if (!isSignInWithEmailLink(auth, window.location.href)) {
          setStep('error')
          setMsg('Ce lien est invalide ou a expiré. Demandez un nouveau lien.')
          return
        }

        let email = localStorage.getItem('miad_email_for_signin') || ''
        if (!email) {
          // Autre appareil que celui utilisé pour envoyer le lien
          email = (typeof window !== 'undefined'
            ? window.prompt('Confirmez votre adresse email pour vous connecter :')
            : null) || ''
          if (!email) {
            setStep('error')
            setMsg('Email requis pour terminer la connexion.')
            return
          }
        }

        try {
          const result = await signInWithEmailLink(auth, email, window.location.href)
          const idToken = await result.user.getIdToken()

          const res  = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ firebase_token: idToken }),
          })
          const data = await res.json()

          localStorage.removeItem('miad_email_for_signin')
          // Nettoyer l'URL
          window.history.replaceState({}, '', '/auth')

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

            setStep('success')
            setMsg(`Bienvenue${data.user_display_name ? ', ' + data.user_display_name : ''} !`)

            redirectTimer = setTimeout(() => {
              const dest = (data.role || 'buyer') === 'vendor'
                ? '/?view=vendorDashboard'
                : '/?view=clientDashboard'
              router.replace(dest)
            }, 1200)
          } else {
            setStep('error')
            setMsg(data.message || 'Connexion échouée. Réessayez.')
          }
        } catch (err: any) {
          const code = err?.code || ''
          setStep('error')
          setMsg(
            code === 'auth/invalid-action-code' || code === 'auth/expired-action-code'
              ? 'Ce lien a expiré. Demandez un nouveau lien de connexion.'
              : code === 'auth/invalid-email'
                ? 'L\'adresse email ne correspond pas à ce lien.'
                : 'Connexion impossible. Réessayez.'
          )
        }
        return
      }

      // ── Réinitialisation de mot de passe ─────────────────────────────────
      if (mode === 'resetPassword') {
        // Rediriger vers la page reset-password avec l'oobCode
        router.replace(`/reset-password?oobCode=${encodeURIComponent(oobCode)}`)
        return
      }

      // ── Vérification d'email ──────────────────────────────────────────────
      if (mode === 'verifyEmail') {
        try {
          const { applyActionCode } = await import('firebase/auth')
          await applyActionCode(auth, oobCode)
          setStep('success')
          setMsg('Votre email a été vérifié.')
          redirectTimer = setTimeout(() => router.replace('/'), 2000)
        } catch {
          setStep('error')
          setMsg('Vérification échouée. Le lien a peut-être expiré.')
        }
        return
      }

      setStep('error')
      setMsg('Action non reconnue.')
    }

    run()
    return () => clearTimeout(redirectTimer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="max-w-xs w-full text-center space-y-6">

        {/* Logo */}
        <div className="w-16 h-16 mx-auto rounded-2xl bg-muted flex items-center justify-center">
          <Image src="/logo/logo.png" alt="MIAD Market" width={40} height={40} className="w-10 h-10 object-contain" />
        </div>

        {step === 'loading' && (
          <>
            <Loader2 size={36} className="animate-spin text-primary mx-auto" />
            <div>
              <p className="font-black text-lg uppercase tracking-tight">
                {mode === 'signIn' ? 'Connexion en cours…' : 'Traitement en cours…'}
              </p>
              <p className="text-sm text-muted-foreground mt-1">Quelques secondes…</p>
            </div>
          </>
        )}

        {step === 'success' && (
          <>
            <CheckCircle2 size={48} className="text-green-500 mx-auto" />
            <div>
              <p className="font-black text-xl">{msg}</p>
              <p className="text-sm text-muted-foreground mt-1">Redirection…</p>
            </div>
          </>
        )}

        {step === 'error' && (
          <>
            <XCircle size={48} className="text-destructive mx-auto" />
            <div>
              <p className="font-bold text-base text-destructive">{msg}</p>
              <button
                type="button"
                onClick={() => router.replace('/Login')}
                className="mt-4 text-sm text-accent hover:underline font-semibold"
              >
                ← Retour à la connexion
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function AuthPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="animate-spin text-primary" size={32} />
      </div>
    }>
      <AuthHandler />
    </Suspense>
  )
}

"use client"

import { useState } from 'react'
import { Mail, ArrowLeft, CheckCircle2, ArrowRight, Loader2, ShieldCheck, RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { OtpInput } from './OtpInput'

interface LoginPageProps {
  onBack?: () => void
  onLoginSuccess: (userType: 'buyer' | 'vendor', user?: any) => void
}

type Step = 'email' | 'otp'

const BENEFITS = ['Des milliers de produits africains authentiques', 'Livraison MIAD Express vers 220+ pays', 'Paiement sécurisé : Wave, Orange Money, Carte', 'Vendeurs vérifiés et certifiés MIAD', 'Support client disponible 24h/7j']

export function LoginPage({ onBack, onLoginSuccess }: LoginPageProps) {
  const router = useRouter()

  const [email,     setEmail]     = useState('')
  const [otp,       setOtp]       = useState('')
  const [step,      setStep]      = useState<Step>('email')
  const [isLoading, setIsLoading] = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [resendIn,  setResendIn]  = useState(0)

  const startResendTimer = () => {
    setResendIn(60)
    const iv = setInterval(() => setResendIn(s => { if (s <= 1) { clearInterval(iv); return 0 } return s - 1 }), 1000)
  }

  // ── Étape 1 : envoyer le code ─────────────────────────────────────────────
  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email) { setError('Veuillez entrer votre adresse email.'); return }
    setIsLoading(true); setError(null)
    try {
      const res  = await fetch('/api/auth/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()
      if (res.ok) { setStep('otp'); startResendTimer() }
      else setError(data.error || data.message || 'Impossible d\'envoyer le code.')
    } catch { setError('Erreur réseau. Vérifiez votre connexion.') }
    finally { setIsLoading(false) }
  }

  // ── Étape 2 : vérifier le code ────────────────────────────────────────────
  const handleVerifyOtp = async () => {
    if (otp.length < 6) { setError('Entrez les 6 chiffres du code.'); return }
    setIsLoading(true); setError(null)
    try {
      // 1. Verify OTP via Firestore → get Firebase custom token
      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: otp }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Code incorrect.'); setOtp(''); return }

      let finalToken = data.token
      let finalData  = data

      if (data.customToken) {
        // Firebase mode: exchange custom token for WordPress session
        const { auth: firebaseAuth } = await import('@/lib/firebase')
        const { signInWithCustomToken } = await import('firebase/auth')
        const userCred = await signInWithCustomToken(firebaseAuth, data.customToken)
        const idToken  = await userCred.user.getIdToken()

        const loginRes = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ firebase_token: idToken }),
        })
        finalData = await loginRes.json()
        finalToken = finalData.token
        if (!loginRes.ok || !finalToken) {
          setError(finalData.message || 'Erreur de connexion WordPress.')
          return
        }
      }

      if (finalToken) {
        localStorage.removeItem('miad_token'); localStorage.removeItem('miad_user'); localStorage.removeItem('miad_role')
        localStorage.setItem('miad_token', finalToken)
        localStorage.setItem('miad_user',  JSON.stringify({ display_name: finalData.user_display_name, user_email: finalData.user_email || email, user_nicename: finalData.user_nicename, id: finalData.id, avatar: finalData.avatar }))
        localStorage.setItem('miad_role',  finalData.role || 'buyer')
        if (finalData.role === 'representant') { window.location.href = '/espace-representant'; return }
        onLoginSuccess((finalData.role || 'buyer') as 'buyer' | 'vendor', finalData)
      } else {
        setError('Erreur de connexion.')
      }
    } catch { setError('Erreur réseau.') }
    finally { setIsLoading(false) }
  }

  // ── Connexion Google ───────────────────────────────────────────────────────
  const handleGoogle = async () => {
    setIsLoading(true); setError(null)
    try {
      const { auth } = await import('@/lib/firebase')
      const { GoogleAuthProvider, signInWithPopup } = await import('firebase/auth')
      const result  = await signInWithPopup(auth, new GoogleAuthProvider())
      const idToken = await result.user.getIdToken()
      const res     = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firebase_token: idToken }),
      })
      const data = await res.json()
      if (res.ok) {
        localStorage.removeItem('miad_token'); localStorage.removeItem('miad_user'); localStorage.removeItem('miad_role')
        localStorage.setItem('miad_token', data.token)
        localStorage.setItem('miad_user',  JSON.stringify({ display_name: data.user_display_name, user_email: data.user_email || result.user.email, user_nicename: data.user_nicename, id: data.id, avatar: data.avatar }))
        localStorage.setItem('miad_role',  data.role || 'buyer')
        if (data.role === 'representant') { window.location.href = '/espace-representant'; return }
        onLoginSuccess((data.role || 'buyer') as 'buyer' | 'vendor', data)
      } else setError(data.message || 'Connexion Google échouée.')
    } catch (err: any) {
      if (err.code === 'auth/popup-closed-by-user') return
      if (err.code === 'auth/unauthorized-domain') {
        setError('Domaine non autorisé dans Firebase. Ajoutez ce domaine dans Firebase Console → Authentication → Authorized domains.')
      } else if (err.code === 'auth/popup-blocked') {
        setError('Le navigateur a bloqué la fenêtre Google. Autorisez les popups pour ce site.')
      } else {
        setError('Connexion Google impossible.' + (err.code ? ` (${err.code})` : ''))
      }
    } finally { setIsLoading(false) }
  }

  return (
    <div className="min-h-screen flex">
      {/* Branding */}
      <div className="hidden lg:flex lg:w-[42%] bg-primary relative flex-col justify-between p-12 overflow-hidden">
        <div className="absolute -top-20 -left-20 w-80 h-80 rounded-full bg-white/5" />
        <div className="absolute bottom-0 right-0 w-96 h-96 rounded-full bg-accent/10 translate-x-1/3 translate-y-1/3" />
        <div className="relative z-10">
          <button type="button" onClick={onBack ?? (() => router.back())} className="flex items-center gap-2 text-primary-foreground/70 hover:text-primary-foreground transition-colors mb-10">
            <ArrowLeft size={18} /><span className="text-sm">Retour</span>
          </button>
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-2xl bg-white relative flex items-center justify-center shadow-lg overflow-hidden p-2">
              <Image src="/logo/logo.png" alt="Logo" fill className="object-contain" />
            </div>
            <div><h1 className="text-3xl font-bold text-white">MIAD Market</h1><p className="text-primary-foreground/60 text-sm">Made in Africa · Shared with the World</p></div>
          </div>
        </div>
        <div className="relative z-10 space-y-3">
          {BENEFITS.map((b) => (
            <div key={b} className="flex items-start gap-3">
              <CheckCircle2 size={16} className="text-accent mt-0.5 shrink-0" />
              <span className="text-primary-foreground/85 text-sm">{b}</span>
            </div>
          ))}
        </div>
        <div className="relative z-10 grid grid-cols-3 gap-3 pt-8 border-t border-white/10">
          {[{ v: '50K+', l: 'Vendeurs' }, { v: '500K+', l: 'Produits' }, { v: '20+', l: 'Pays' }].map(s => (
            <div key={s.l} className="text-center">
              <p className="text-2xl font-bold text-accent">{s.v}</p>
              <p className="text-xs text-primary-foreground/60 mt-0.5">{s.l}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Formulaire */}
      <div className="flex-1 flex flex-col bg-background overflow-y-auto">
        <div className="lg:hidden flex items-center gap-4 p-5 border-b border-border">
          <button type="button" onClick={onBack ?? (() => router.back())} aria-label="Retour" className="p-2 rounded-lg hover:bg-muted"><ArrowLeft size={20} /></button>
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-white relative flex items-center justify-center overflow-hidden p-1"><Image src="/logo/logo.png" alt="" fill className="object-contain" /></div>
            <span className="font-bold">MIAD Market</span>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center p-6 lg:p-12">
          <div className="w-full max-w-sm">

            {/* Icône */}
            <div className="text-center mb-7">
              <div className="w-14 h-14 bg-primary/5 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <ShieldCheck size={28} className="text-primary" />
              </div>
              <h2 className="text-2xl font-black uppercase tracking-tighter">
                {step === 'email' ? 'Connexion' : 'Vérification'}
              </h2>
              <p className="text-muted-foreground text-sm mt-1.5">
                {step === 'email' ? 'Entrez votre email — on vous envoie un code' : `Code envoyé à ${email}`}
              </p>
            </div>

            {/* Erreur */}
            {error && (
              <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-xs font-bold mb-5 animate-in fade-in">
                {error}
              </div>
            )}

            {/* ── Étape 1 : Email ──────────────────────────────────── */}
            {step === 'email' && (
              <>
                <form onSubmit={handleSendCode} className="space-y-4 mb-6">
                  <div className="relative">
                    <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="email" value={email}
                      onChange={e => { setEmail(e.target.value); setError(null) }}
                      placeholder="votre@email.com"
                      className="w-full pl-9 pr-4 h-12 border border-border rounded-xl bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
                      required autoComplete="email"
                    />
                  </div>
                  <Button type="submit" disabled={isLoading} className="w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground font-bold gap-2">
                    {isLoading ? <Loader2 className="animate-spin" size={18} /> : <><Mail size={15} />Recevoir le code<ArrowRight size={14} /></>}
                  </Button>
                </form>
                <div className="flex items-center gap-3 mb-5"><div className="flex-1 h-px bg-border" /><span className="text-xs text-muted-foreground font-medium">ou</span><div className="flex-1 h-px bg-border" /></div>
                <button type="button" onClick={handleGoogle} disabled={isLoading} className="w-full flex items-center justify-center gap-3 h-12 border border-border rounded-xl hover:bg-muted transition-colors text-sm font-medium disabled:opacity-50">
                  <svg width="18" height="18" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  Continuer avec Google
                </button>
                <p className="text-center text-sm text-muted-foreground mt-6">
                  Pas encore de compte ?{' '}
                  <button type="button" onClick={() => router.push('/register')} className="text-accent font-semibold hover:underline">Créer un compte</button>
                </p>
              </>
            )}

            {/* ── Étape 2 : Code OTP ───────────────────────────────── */}
            {step === 'otp' && (
              <div className="space-y-6">
                <OtpInput value={otp} onChange={v => { setOtp(v); setError(null) }} disabled={isLoading} />

                <Button
                  onClick={handleVerifyOtp}
                  disabled={isLoading || otp.length < 6}
                  className="w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground font-bold gap-2"
                >
                  {isLoading ? <Loader2 className="animate-spin" size={18} /> : <><ShieldCheck size={16} />Confirmer le code</>}
                </Button>

                <div className="text-center space-y-2">
                  {resendIn > 0 ? (
                    <p className="text-xs text-muted-foreground">Renvoyer dans {resendIn}s</p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setOtp(''); setError(null); handleSendCode({ preventDefault: () => {} } as any) }}
                      className="flex items-center gap-1.5 text-xs text-accent hover:underline mx-auto font-medium"
                    >
                      <RefreshCw size={12} />Renvoyer un nouveau code
                    </button>
                  )}
                  <button type="button" onClick={() => { setStep('email'); setOtp(''); setError(null) }} className="text-xs text-muted-foreground hover:underline block mx-auto">
                    ← Changer d'adresse email
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  )
}

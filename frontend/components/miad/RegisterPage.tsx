"use client"

import { useState } from 'react'
import {
  Mail, ArrowLeft, CheckCircle2, ArrowRight, Loader2,
  ShieldCheck, Sparkles, User, Phone, RefreshCw
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { OtpInput } from './OtpInput'

type AccountType = 'buyer' | 'vendor'
type Step        = 'form' | 'otp'

interface RegisterPageProps {
  onBack?: () => void
  onLoginSuccess?: (userType: 'buyer' | 'vendor', user?: any) => void
}

const BENEFITS = [
  '50 000+ produits africains authentiques',
  'Vendeurs vérifiés et certifiés MIAD',
  'Livraison MIAD Express vers 220+ pays',
  'Gagnez des MIAD Coins à chaque achat',
  'Support client disponible 24h/7j',
]

export function RegisterPage({ onBack, onLoginSuccess }: RegisterPageProps) {
  const router = useRouter()

  // Inscription vendeur désactivée (2026-07-13) : plus de sélecteur de type
  // de compte, tout le monde s'inscrit comme acheteur.
  const accountType: AccountType = 'buyer'
  const [step, setStep] = useState<Step>('form')
  const [isLoading,   setIsLoading]   = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [email,       setEmail]       = useState('')
  const [name,        setName]        = useState('')
  const [phone,       setPhone]       = useState('')
  const [otp,         setOtp]         = useState('')
  const [resendIn,    setResendIn]    = useState(0)

  const handleBack = () => onBack ? onBack() : router.back()

  const startResendTimer = () => {
    setResendIn(60)
    const iv = setInterval(() => setResendIn(s => { if (s <= 1) { clearInterval(iv); return 0 } return s - 1 }), 1000)
  }

  const handleSendCode = async (e?: { preventDefault?: () => void }) => {
    e?.preventDefault?.()
    if (!name.trim()) { setError('Veuillez entrer votre nom complet.'); return }
    if (!email)       { setError('Veuillez entrer votre adresse email.'); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Adresse email invalide.'); return }

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

  const handleVerifyOtp = async () => {
    if (otp.length < 6) { setError('Entrez les 6 chiffres du code.'); return }
    setIsLoading(true); setError(null)
    try {
      const res  = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: otp, name: name.trim(), phone: phone.trim(), account_type: accountType }),
      })
      const data = await res.json()
      if (res.ok && data.token) {
        localStorage.setItem('miad_token', data.token)
        localStorage.setItem('miad_user',  JSON.stringify({ display_name: data.user_display_name, user_email: data.user_email, user_nicename: data.user_nicename, id: data.id, avatar: data.avatar }))
        localStorage.setItem('miad_role',  data.role || accountType)
        if (onLoginSuccess) {
          onLoginSuccess((data.role || accountType) as 'buyer' | 'vendor', data)
        } else {
          router.push('/')
        }
      } else {
        setError(data.error || data.message || 'Code incorrect.')
        setOtp('')
      }
    } catch { setError('Erreur réseau.') }
    finally { setIsLoading(false) }
  }

  return (
    <div className="min-h-screen flex">

      {/* ── Colonne gauche — Branding ─────────────────────────────────── */}
      <div className="hidden lg:flex lg:w-[42%] bg-primary relative flex-col justify-between p-12 overflow-hidden">
        <div className="absolute -top-20 -left-20 w-80 h-80 rounded-full bg-white/5" />
        <div className="absolute bottom-0 right-0 w-96 h-96 rounded-full bg-accent/10 translate-x-1/3 translate-y-1/3" />

        <div className="relative z-10">
          <button type="button" onClick={handleBack} className="flex items-center gap-2 text-primary-foreground/70 hover:text-primary-foreground transition-colors mb-10">
            <ArrowLeft size={18} /><span className="text-sm">Retour</span>
          </button>
          <div className="flex items-center gap-3 mb-2">
            <div className="relative w-14 h-14 rounded-2xl bg-white flex items-center justify-center shadow-lg overflow-hidden">
              <Image src="/logo/logo.png" alt="Logo" fill sizes="56px" className="object-contain p-2" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-white">MIAD Market</h1>
              <p className="text-primary-foreground/60 text-sm">Made in Africa · Shared with the World</p>
            </div>
          </div>
        </div>

        <div className="relative z-10 space-y-4">
          <p className="text-white font-semibold text-lg mb-2">Pourquoi rejoindre MIAD ?</p>
          {BENEFITS.map((b) => (
            <div key={b} className="flex items-start gap-3">
              <CheckCircle2 size={17} className="text-accent mt-0.5 shrink-0" />
              <span className="text-primary-foreground/85 text-sm leading-snug">{b}</span>
            </div>
          ))}
        </div>

        <div className="relative z-10 grid grid-cols-3 gap-3 pt-8 border-t border-white/10">
          {[{ value: '50K+', label: 'Vendeurs' }, { value: '500K+', label: 'Produits' }, { value: '20+', label: 'Pays' }].map(s => (
            <div key={s.label} className="text-center">
              <p className="text-2xl font-bold text-accent">{s.value}</p>
              <p className="text-xs text-primary-foreground/60 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Colonne droite — Formulaire ───────────────────────────────── */}
      <div className="flex-1 flex flex-col bg-background overflow-y-auto">
        <div className="lg:hidden flex items-center gap-4 p-5 border-b border-border">
          <button type="button" onClick={handleBack} aria-label="Retour" className="p-2 rounded-lg hover:bg-muted transition-colors"><ArrowLeft size={20} /></button>
          <div className="flex items-center gap-2">
            <div className="relative w-9 h-9 rounded-xl bg-white flex items-center justify-center overflow-hidden">
              <Image src="/logo/logo.png" alt="Logo" fill sizes="36px" className="object-contain p-1" />
            </div>
            <span className="font-bold">MIAD Market</span>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center p-6 lg:p-12">
          <div className="w-full max-w-sm">

            {/* Icône + titre */}
            <div className="text-center mb-7">
              <div className="w-14 h-14 bg-primary/5 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <ShieldCheck size={28} className="text-primary" />
              </div>
              <h2 className="text-2xl font-black uppercase tracking-tighter">
                {step === 'form' ? 'Créer un compte' : 'Vérification'}
              </h2>
              <p className="text-muted-foreground text-sm mt-1.5">
                {step === 'form' ? 'Rejoignez la marketplace panafricaine' : `Code envoyé à ${email}`}
              </p>
            </div>

            {/* Erreur */}
            {error && (
              <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-xs font-bold mb-4 animate-in fade-in">
                {error}
              </div>
            )}

            {/* ── Étape 1 : Formulaire ───────────────────────────────── */}
            {step === 'form' && (
              <form onSubmit={handleSendCode} className="space-y-4">

                {/* Nom */}
                <div className="relative">
                  <User size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    value={name}
                    onChange={e => { setName(e.target.value); setError(null) }}
                    placeholder="Nom complet *"
                    className="w-full pl-9 pr-4 h-12 border border-border rounded-xl bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
                    required
                    autoComplete="name"
                  />
                </div>

                {/* Email */}
                <div className="relative">
                  <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="email"
                    value={email}
                    onChange={e => { setEmail(e.target.value); setError(null) }}
                    placeholder="Adresse email *"
                    className="w-full pl-9 pr-4 h-12 border border-border rounded-xl bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
                    required
                    autoComplete="email"
                  />
                </div>

                {/* Téléphone */}
                <div className="relative">
                  <Phone size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="tel"
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    placeholder="Téléphone (optionnel)"
                    className="w-full pl-9 pr-4 h-12 border border-border rounded-xl bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
                    autoComplete="tel"
                  />
                </div>

                {/* CGU */}
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  En créant un compte, vous acceptez nos{' '}
                  <span className="text-accent font-semibold cursor-pointer hover:underline">Conditions d'utilisation</span>{' '}
                  et notre{' '}
                  <span className="text-accent font-semibold cursor-pointer hover:underline">Politique de confidentialité</span>.
                </p>

                <Button
                  type="submit"
                  disabled={isLoading}
                  className="w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground font-bold gap-2"
                >
                  {isLoading ? (
                    <Loader2 className="animate-spin" size={18} />
                  ) : (
                    <>
                      <Sparkles size={14} />
                      Recevoir mon code
                      <ArrowRight size={14} />
                    </>
                  )}
                </Button>

                <p className="text-center text-sm text-muted-foreground">
                  Déjà un compte ?{' '}
                  <button type="button" onClick={() => router.push('/Login')} className="text-accent font-semibold hover:underline">
                    Se connecter
                  </button>
                </p>
              </form>
            )}

            {/* ── Étape 2 : Code OTP ────────────────────────────────── */}
            {step === 'otp' && (
              <div className="space-y-6">
                <OtpInput value={otp} onChange={v => { setOtp(v); setError(null) }} disabled={isLoading} />

                <Button
                  onClick={handleVerifyOtp}
                  disabled={isLoading || otp.length < 6}
                  className="w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground font-bold gap-2"
                >
                  {isLoading ? <Loader2 className="animate-spin" size={18} /> : <><ShieldCheck size={16} />Créer mon compte</>}
                </Button>

                <div className="text-center space-y-2">
                  {resendIn > 0 ? (
                    <p className="text-xs text-muted-foreground">Renvoyer dans {resendIn}s</p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setOtp(''); setError(null); handleSendCode() }}
                      className="flex items-center gap-1.5 text-xs text-accent hover:underline mx-auto font-medium"
                    >
                      <RefreshCw size={12} />Renvoyer un nouveau code
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => { setStep('form'); setOtp(''); setError(null) }}
                    className="text-xs text-muted-foreground hover:underline block mx-auto"
                  >
                    ← Modifier mes informations
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

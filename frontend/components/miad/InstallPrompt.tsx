'use client'

import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import { X, Download, Smartphone, Bell, Wifi, Zap, Check } from 'lucide-react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const FEATURES = [
  { icon: Zap,       text: 'Accès instantané, même hors-ligne' },
  { icon: Bell,      text: 'Notifications commandes en temps réel' },
  { icon: Smartphone,text: 'Expérience app native sur mobile' },
]

export default function InstallPrompt() {
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null)
  const [visible, setVisible]   = useState(false)
  const [isIOS, setIsIOS]       = useState(false)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (
      window.matchMedia('(display-mode: standalone)').matches ||
      localStorage.getItem('pwa_install_dismissed')
    ) return

    // Chrome/Edge Android seulement (pas de support Safari/Samsung Internet) :
    // si le PWA est déjà installé mais qu'on navigue quand même dans le
    // navigateur (pas en mode standalone), il n'existe aucune API web pour
    // relancer automatiquement l'app déjà installée — mais on peut au moins
    // détecter le cas et ne pas remontrer la bannière d'installation, ce
    // qui n'avait pas de sens pour quelqu'un qui l'a déjà (signalé le
    // 2026-07-30, capture d'écran "Impossible d'installer l'application Web").
    let cancelled = false
    const nav = window.navigator as any
    if (typeof nav.getInstalledRelatedApps === 'function') {
      nav.getInstalledRelatedApps().then((apps: unknown[]) => {
        if (!cancelled && apps.length > 0) localStorage.setItem('pwa_install_dismissed', '1')
      }).catch(() => {})
    }

    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !(window as any).MSStream
    if (ios && !('standalone' in window.navigator && (window.navigator as any).standalone)) {
      setIsIOS(true)
      setTimeout(() => { if (!cancelled) setVisible(true) }, 5000)
      return () => { cancelled = true }
    }

    const handler = (e: Event) => {
      e.preventDefault()
      deferredPromptRef.current = e as BeforeInstallPromptEvent
      setTimeout(() => { if (!cancelled) setVisible(true) }, 4000)
    }
    window.addEventListener('beforeinstallprompt', handler)
    window.addEventListener('appinstalled', () => { setInstalled(true); setTimeout(() => setVisible(false), 2500) })
    return () => { cancelled = true; window.removeEventListener('beforeinstallprompt', handler) }
  }, [])

  const handleInstall = async () => {
    const deferredPrompt = deferredPromptRef.current
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') setInstalled(true)
    deferredPromptRef.current = null
  }

  const handleDismiss = () => {
    setVisible(false)
    localStorage.setItem('pwa_install_dismissed', '1')
  }

  if (!visible) return null

  return (
    <>
      {/* Backdrop */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Fermer"
        className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm"
        onClick={handleDismiss}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') handleDismiss() }}
      />

      {/* Panel */}
      <div className="fixed bottom-0 left-0 right-0 z-[201] animate-in slide-in-from-bottom duration-300 sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:max-w-sm sm:rounded-3xl overflow-hidden">
        <div className="bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl">

          {/* Handle bar (mobile) */}
          <div className="flex justify-center pt-3 pb-1 sm:hidden">
            <div className="w-10 h-1 rounded-full bg-gray-200" />
          </div>

          {/* Header */}
          <div className="relative px-6 pt-4 pb-5" style={{ background: 'linear-gradient(135deg,#005826 0%,#007a35 100%)' }}>
            <button
              type="button"
              onClick={handleDismiss}
              aria-label="Fermer"
              className="absolute top-4 right-4 p-1.5 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
            >
              <X size={16} className="text-white" />
            </button>

            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-2xl bg-white shadow-lg flex items-center justify-center overflow-hidden shrink-0">
                <Image src="/logo/logo.png" alt="MIAD" width={56} height={56} className="w-14 h-14 object-contain" />
              </div>
              <div>
                <h2 className="text-lg font-black text-white leading-tight">MIAD Market</h2>
                <p className="text-[11px] text-white/70 font-medium">miadmarket.com</p>
                <div className="flex items-center gap-1 mt-1">
                  {[1,2,3,4,5].map(i => (
                    <svg key={i} className="w-3 h-3 fill-amber-400" viewBox="0 0 20 20"><path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z"/></svg>
                  ))}
                  <span className="text-[10px] text-white/60 ml-1">4.9</span>
                </div>
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="px-6 py-5">
            {installed ? (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-3">
                  <Check size={28} className="text-emerald-600" />
                </div>
                <p className="font-black text-lg text-foreground">Installée avec succès !</p>
                <p className="text-sm text-muted-foreground mt-1">MIAD Market est maintenant sur votre écran d'accueil.</p>
              </div>
            ) : isIOS ? (
              <>
                <p className="text-sm font-bold text-foreground mb-4">Ajouter à l'écran d'accueil :</p>
                <ol className="space-y-3">
                  {[
                    "Appuyez sur l'icône Partager ⎋ en bas de Safari",
                    'Faites défiler et appuyez sur "Sur l\'écran d\'accueil"',
                    'Appuyez sur "Ajouter" en haut à droite',
                  ].map((step, i) => (
                    <li key={step} className="flex items-start gap-3 text-sm text-muted-foreground">
                      <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">{i+1}</span>
                      {step}
                    </li>
                  ))}
                </ol>
                <button type="button" onClick={handleDismiss} className="w-full mt-5 py-3 rounded-2xl bg-muted text-foreground text-sm font-bold">
                  Compris
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground mb-4">Installez l'application pour une expérience optimale :</p>
                <ul className="space-y-3 mb-5">
                  {FEATURES.map(({ icon: Icon, text }) => (
                    <li key={text} className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                        <Icon size={15} className="text-primary" />
                      </div>
                      <span className="text-sm font-medium text-foreground">{text}</span>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={handleInstall}
                  className="w-full py-3.5 rounded-2xl font-black text-sm text-white flex items-center justify-center gap-2 active:scale-95 transition-transform"
                  style={{ background: 'linear-gradient(135deg,#005826,#007a35)' }}
                >
                  <Download size={16} />
                  Installer l'application
                </button>
                <button type="button" onClick={handleDismiss} className="w-full mt-2 py-2.5 text-xs text-muted-foreground font-medium">
                  Pas maintenant
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

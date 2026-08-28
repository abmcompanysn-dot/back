"use client"

import { useEffect, useState, useRef } from 'react'
import Image from 'next/image'
import { Loader2, CheckCircle, AlertCircle, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// MobileMoneyDirectForm — flux "sans redirection" (2026-08-28) : le client
// choisit son opérateur + saisit son numéro directement sur notre page,
// au lieu d'être envoyé sur une page hébergée par l'agrégateur. Conçu
// agrégateur-agnostique (le nom "PawaPay" n'apparaît nulle part dans ce
// composant) même si PawaPay est le seul branché aujourd'hui — voir le
// plan pawapay-sans-redirection.md.
//
// Certains opérateurs (authType=REDIRECT_AUTH côté PawaPay) exigent
// quand même une redirection : gérée de façon TRANSPARENTE côté backend
// (initiateMobileMoneyDeposit bascule automatiquement), ce composant ne
// s'en préoccupe pas — il reçoit soit un redirectUrl (à suivre), soit un
// depositId (à interroger).

interface MobileMoneyProvider {
  code: string
  authType: string
}
interface MobileMoneyCountry {
  iso2: string
  iso3: string
  name: string
  currency: string
  dial_code: string
  providers: string[]
  providers_detail?: MobileMoneyProvider[]
}

// Libellés + logos pour les codes provider PawaPay (ex. ORANGE_SEN) —
// juste le préfixe avant le premier "_", suffisant pour l'affichage
// (le sélecteur de PAYS détermine déjà le pays, pas besoin de le répéter).
// Logos fournis par le fondateur le 2026-08-28 (public/logo/mobile-money/) —
// prefix sans logo dédié = pas d'image, juste le libellé texte (repli
// géré par MobileMoneyLogo ci-dessous, jamais d'icône cassée).
const PROVIDER_INFO: Record<string, { label: string; logo?: string }> = {
  ORANGE: { label: 'Orange Money', logo: '/logo/mobile-money/orange-money.png' },
  FREE: { label: 'Free Money' },
  WAVE: { label: 'Wave', logo: '/logo/mobile-money/wave.png' },
  EXPRESSO: { label: 'Expresso' },
  MTN: { label: 'MTN MoMo', logo: '/logo/mobile-money/mtn-momo.png' },
  MOOV: { label: 'Moov Money', logo: '/logo/mobile-money/moov-money.png' },
  TOGOCOM: { label: 'Togocom' },
  VODACOM: { label: 'M-Pesa (Vodacom)', logo: '/logo/mobile-money/vodacom.png' },
  AIRTEL: { label: 'Airtel Money', logo: '/logo/mobile-money/at-money.png' },
  MPESA: { label: 'M-Pesa', logo: '/logo/mobile-money/mpesa.png' },
  VODAFONE: { label: 'Vodafone Cash' },
  AIRTELTIGO: { label: 'AirtelTigo' },
  TIGO: { label: 'Tigo' },
  HALOTEL: { label: 'Halotel' },
  HALOPESA: { label: 'HaloPesa', logo: '/logo/mobile-money/halopesa.png' },
  ZAMTEL: { label: 'Zamtel', logo: '/logo/mobile-money/zamtel.png' },
  TNM: { label: 'TNM Mpamba', logo: '/logo/mobile-money/tnm.png' },
  MOVITEL: { label: 'M-Pesa (Movitel)', logo: '/logo/mobile-money/movitel.png' },
  AFRICELL: { label: 'Africell Money' },
  TELECEL: { label: 'Telecel Cash', logo: '/logo/mobile-money/telecel-cash.png' },
  CELTIIS: { label: 'Celtiis Cash', logo: '/logo/mobile-money/celtiis-cash.jpg' },
  MIXX: { label: 'Mixx by Yas', logo: '/logo/mobile-money/mixx-yas.png' },
}

function providerInfo(code: string): { label: string; logo?: string } {
  const prefix = code.split('_')[0]
  return PROVIDER_INFO[prefix] || { label: prefix }
}

interface Props {
  orderId: number
  countryISO2: string // pré-rempli depuis l'adresse de livraison déjà saisie
  phoneHint: string   // numéro déjà saisi au checkout, pré-rempli mais modifiable
  onSuccess: () => void
  onFailure: (message: string) => void
  onNeedsFormRestart: () => void // si la commande doit être recréée (échec avant tout dépôt)
}

const POLL_INTERVAL_MS = 3000
const WAITING_MESSAGE_AFTER_MS = 90_000

export function MobileMoneyDirectForm({ orderId, countryISO2, phoneHint, onSuccess, onFailure }: Props) {
  const [countries, setCountries] = useState<MobileMoneyCountry[]>([])
  const [countriesLoading, setCountriesLoading] = useState(true)
  const [country, setCountry] = useState(countryISO2.toUpperCase())
  const [provider, setProvider] = useState('')
  const [phone, setPhone] = useState(phoneHint)
  const [submitting, setSubmitting] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [showWaitingMessage, setShowWaitingMessage] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const waitingMessageTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    fetch('/api/payment-gateways/mobile-money-countries')
      .then((r) => r.json())
      .then((data) => {
        setCountries(data.countries || [])
        if (!data.countries?.some((c: MobileMoneyCountry) => c.iso2 === country)) {
          setCountry(data.default_iso2 || 'SN')
        }
      })
      .catch(() => {})
      .finally(() => setCountriesLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
      if (waitingMessageTimer.current) clearTimeout(waitingMessageTimer.current)
    }
  }, [])

  const selectedCountry = countries.find((c) => c.iso2 === country)
  const providers = selectedCountry?.providers_detail?.length
    ? selectedCountry.providers_detail
    : (selectedCountry?.providers || []).map((code) => ({ code, authType: '' }))

  function startPolling() {
    setWaiting(true)
    setShowWaitingMessage(false)
    waitingMessageTimer.current = setTimeout(() => setShowWaitingMessage(true), WAITING_MESSAGE_AFTER_MS)
    pollTimer.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/orders/${orderId}/confirm-pawapay`, { method: 'POST' })
        const data = await res.json()
        if (data.status === 'completed') {
          if (pollTimer.current) clearInterval(pollTimer.current)
          if (waitingMessageTimer.current) clearTimeout(waitingMessageTimer.current)
          onSuccess()
        } else if (data.status === 'failed') {
          if (pollTimer.current) clearInterval(pollTimer.current)
          if (waitingMessageTimer.current) clearTimeout(waitingMessageTimer.current)
          setWaiting(false)
          onFailure("Le paiement a échoué ou a été annulé sur votre téléphone.")
        }
        // 'pending' : on continue à interroger, rien à faire ici.
      } catch {
        // Erreur réseau ponctuelle pendant le polling — pas fatal, on
        // retente au prochain tick plutôt que d'abandonner le client en
        // plein paiement.
      }
    }, POLL_INTERVAL_MS)
  }

  async function handleSubmit() {
    if (!provider || !phone.trim()) {
      setError('Choisissez votre opérateur et saisissez votre numéro.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const token = localStorage.getItem('miad_token') || localStorage.getItem('token')
      const res = await fetch(`/api/orders/${orderId}/mobile-money-deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ provider, phone, country }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Échec du paiement')

      if (data.redirectUrl) {
        // Cet opérateur précis exige une redirection côté agrégateur
        // (REDIRECT_AUTH) — transparent pour le client, juste amené sur
        // la page de son opérateur comme avant ce nouveau flux.
        window.location.href = data.redirectUrl
        return
      }
      // Pas de redirectUrl : dépôt direct accepté, on passe en polling.
      startPolling()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec du paiement')
    } finally {
      setSubmitting(false)
    }
  }

  if (waiting) {
    return (
      <div className="text-center py-10">
        <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-accent/10 flex items-center justify-center">
          <Smartphone size={28} className="text-accent animate-pulse" />
        </div>
        <h3 className="font-black text-lg mb-2">Confirmez sur votre téléphone</h3>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
          Une demande de paiement a été envoyée à votre numéro. Entrez votre code PIN
          ou validez la notification pour finaliser.
        </p>
        <Loader2 size={20} className="animate-spin mx-auto mt-6 text-muted-foreground" />
        {showWaitingMessage && (
          <div className="flex items-start gap-2.5 max-w-sm mx-auto mt-6 px-4 py-3 bg-amber-50 border border-amber-200 rounded-2xl text-[11px] text-amber-800 font-bold leading-snug text-left">
            <AlertCircle size={15} className="shrink-0 mt-0.5 text-amber-600" />
            <span>
              Toujours en attente de confirmation — vérifiez que vous avez bien reçu la
              demande sur votre téléphone. Ne fermez pas cette page.
            </span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1.5 block">Pays</label>
        <select
          value={country}
          onChange={(e) => { setCountry(e.target.value); setProvider('') }}
          disabled={countriesLoading}
          className="w-full h-12 rounded-xl border border-input bg-background px-3 text-sm"
        >
          {countries.map((c) => (
            <option key={c.iso2} value={c.iso2}>{c.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1.5 block">Opérateur</label>
        <div className="grid grid-cols-2 gap-2">
          {providers.map((p) => {
            const info = providerInfo(p.code)
            return (
              <button
                key={p.code}
                type="button"
                onClick={() => setProvider(p.code)}
                className={`p-3 rounded-xl border-2 flex items-center gap-2.5 text-left text-xs font-bold transition-all ${provider === p.code ? 'border-accent bg-accent/5' : 'border-slate-100 hover:border-accent/30'}`}
              >
                {info.logo ? (
                  <Image src={info.logo} alt="" width={28} height={28} className="w-7 h-7 rounded-full object-contain shrink-0 border border-border/20 bg-white" />
                ) : (
                  <div className="w-7 h-7 rounded-full shrink-0 bg-muted flex items-center justify-center">
                    <Smartphone size={13} className="text-muted-foreground" />
                  </div>
                )}
                <span className="flex-1">{info.label}</span>
                {provider === p.code && <CheckCircle size={14} className="text-accent shrink-0" />}
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1.5 block">
          Numéro {selectedCountry ? `(+${selectedCountry.dial_code})` : ''}
        </label>
        <Input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="77 123 45 67"
          className="h-12"
        />
      </div>

      {error && (
        <div className="flex items-start gap-2.5 px-4 py-3 bg-red-50 border border-red-200 rounded-2xl text-[11px] text-red-800 font-bold leading-snug">
          <AlertCircle size={15} className="shrink-0 mt-0.5 text-red-600" />
          <span>{error}</span>
        </div>
      )}

      <Button onClick={handleSubmit} disabled={submitting || countriesLoading} className="w-full h-12 font-bold">
        {submitting ? <Loader2 size={18} className="animate-spin" /> : 'Payer maintenant'}
      </Button>
    </div>
  )
}

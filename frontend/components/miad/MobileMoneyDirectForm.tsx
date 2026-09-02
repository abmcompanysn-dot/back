"use client"

import { useEffect, useState, useRef } from 'react'
import Image from 'next/image'
import { Loader2, CheckCircle, AlertCircle, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// MobileMoneyDirectForm — flux "sans redirection" (2026-08-28) : le client
// choisit son opérateur + saisit son numéro directement sur notre page,
// au lieu d'être envoyé sur une page hébergée par l'agrégateur.
//
// Supporte DEUX agrégateurs (prop `aggregator`, valeur INITIALE reçue de
// CheckoutPage.tsx — le défaut global actif en Configuration) :
// - PawaPay : schéma de requête uniforme, sélecteur pays PUIS opérateur
//   (liste dépend du pays). Certains opérateurs (authType=REDIRECT_AUTH)
//   exigent quand même une redirection — gérée en transparent côté
//   backend (initiateMobileMoneyDeposit), ce composant reçoit juste soit
//   un redirectUrl (à suivre), soit rien (passe en polling).
// - PayDunya (SoftPay) : chaque opérateur a son PROPRE format de requête
//   (géré côté backend, paydunya-softpay.go) — la liste de providers
//   n'est PAS filtrée par pays choisi ici (chaque provider EST déjà lié
//   à un pays, ex. "MTN_CI"), certains exigent un OTP saisi par le
//   client AVANT l'appel (Orange Money CI/BF), un (Wizall) a un flux à
//   3 étapes (dépôt → OTP par SMS → confirmation séparée).
//
// Routage par opérateur (2026-09-02) : la commande est créée avec le
// défaut global comme agrégateur (`aggregator` prop, figé à ce stade —
// order-svc/payment-svc ne permettent qu'UN paiement par commande, voir
// payment-routing.go). Mais l'admin peut régler un agrégateur différent
// pour un opérateur précis (écran "Routage", ex. Wave forcé sur PayDunya
// même si PawaPay est le défaut global) — jusqu'ici ce réglage n'était
// jamais consulté par ce formulaire, donc jamais respecté (bug remonté
// 2026-09-02). effectiveAggregator ci-dessous résout le bon agrégateur
// PAR OPÉRATEUR SÉLECTIONNÉ via GET /api/payment-gateways/routing ; s'il
// diffère de `aggregator` (la valeur figée à la création de commande),
// handleSubmit appelle d'abord POST /payments/order/{id}/switch-provider
// pour rebasculer payments.provider avant de continuer.

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
interface PaydunyaProvider {
  code: string
  country_iso2: string
  label: string
  behavior: 'sync' | 'pending' | 'redirect'
  requires_otp: boolean
  otp_instruction: string
}
// RouteRow — une ligne de GET /api/payment-gateways/routing (relais de
// payment-svc GET /payments/routing), même forme que côté admin
// (PaymentRouting.tsx). active_aggregator est déjà résolu côté serveur
// (override si présent, sinon défaut global) — c'est la SEULE source de
// vérité pour savoir quel agrégateur utiliser pour un opérateur donné.
interface RouteRow {
  country_iso2: string
  operator_label: string
  pawapay_code: string | null
  paydunya_code: string | null
  active_aggregator: 'pawapay' | 'paydunya'
  operator_enabled: boolean
  country_enabled: boolean
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
  aggregator: 'pawapay' | 'paydunya'
  orderId: number
  countryISO2: string // pré-rempli depuis l'adresse de livraison déjà saisie
  phoneHint: string   // numéro déjà saisi au checkout, pré-rempli mais modifiable
  customerName?: string
  customerEmail?: string
  onSuccess: () => void
  onFailure: (message: string) => void
  onNeedsFormRestart: () => void // si la commande doit être recréée (échec avant tout dépôt)
}

const POLL_INTERVAL_MS = 3000
const WAITING_MESSAGE_AFTER_MS = 90_000

export function MobileMoneyDirectForm({ aggregator, orderId, countryISO2, phoneHint, customerName, customerEmail, onSuccess, onFailure }: Props) {
  const [countries, setCountries] = useState<MobileMoneyCountry[]>([])
  const [paydunyaProviders, setPaydunyaProviders] = useState<PaydunyaProvider[]>([])
  const [routes, setRoutes] = useState<RouteRow[]>([])
  const [countriesLoading, setCountriesLoading] = useState(true)
  const [country, setCountry] = useState(countryISO2.toUpperCase())
  const [provider, setProvider] = useState('')
  const [phone, setPhone] = useState(phoneHint)
  const [otp, setOtp] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [showWaitingMessage, setShowWaitingMessage] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Wizall (PayDunya) uniquement : dépôt initial accepté, en attente de
  // l'OTP reçu par SMS pour la 3e étape (confirm) — voir handleWizallConfirm.
  const [wizallTxId, setWizallTxId] = useState<string | null>(null)
  const [wizallOtp, setWizallOtp] = useState('')
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const waitingMessageTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Charge TOUJOURS les deux catalogues (PawaPay + PayDunya), peu importe
  // `aggregator` — nécessaire pour fusionner en une seule liste d'opérateurs
  // et permettre au client de choisir un opérateur dont l'agrégateur
  // effectif (routes[].active_aggregator) diffère du défaut initial.
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
    fetch('/api/payment-gateways/paydunya-providers')
      .then((r) => r.json())
      .then((data) => setPaydunyaProviders(data.providers || []))
      .catch(() => {})
    fetch(`/api/payment-gateways/routing?country_iso2=${countryISO2.toUpperCase()}`)
      .then((r) => r.json())
      .then((data) => setRoutes(data.routes || []))
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
  // Fusion des deux catalogues en une seule liste d'opérateurs, dédupliqués
  // par libellé normalisé (même logique que normalizeOperatorLabel côté Go
  // — premier mot du libellé) : un opérateur supporté par les deux
  // agrégateurs n'apparaît qu'une fois, avec son agrégateur EFFECTIF résolu
  // via `routes` (routing par opérateur, pas le défaut global).
  const pawapayList = (selectedCountry?.providers_detail?.length
    ? selectedCountry.providers_detail
    : (selectedCountry?.providers || []).map((code) => ({ code, authType: '' })))
  const paydunyaList = paydunyaProviders.filter((p) => p.country_iso2 === countryISO2.toUpperCase())

  function normalizeLabel(label: string): string {
    return label.split(/\s+/)[0]?.toUpperCase() || label.toUpperCase()
  }
  function routeFor(label: string): RouteRow | undefined {
    const key = normalizeLabel(label)
    return routes.find((r) => normalizeLabel(r.operator_label) === key)
  }

  type MergedProvider = { code: string; authType: string; effectiveAggregator: 'pawapay' | 'paydunya'; label: string }
  const mergedByLabel = new Map<string, MergedProvider>()
  for (const p of pawapayList) {
    const info = providerInfo(p.code)
    const route = routeFor(info.label)
    if (route && route.operator_enabled === false) continue
    mergedByLabel.set(normalizeLabel(info.label), {
      code: p.code,
      authType: p.authType,
      effectiveAggregator: route?.active_aggregator ?? 'pawapay',
      label: info.label,
    })
  }
  for (const p of paydunyaList) {
    const key = normalizeLabel(p.label)
    if (mergedByLabel.has(key)) continue // déjà couvert côté PawaPay
    const route = routeFor(p.label)
    if (route && route.operator_enabled === false) continue
    mergedByLabel.set(key, {
      code: p.code,
      authType: '',
      effectiveAggregator: route?.active_aggregator ?? 'paydunya',
      label: p.label,
    })
  }
  const providers = [...mergedByLabel.values()]

  const selectedMerged = providers.find((p) => p.code === provider)
  // Le CODE réellement utilisé pour appeler le backend dépend de
  // l'agrégateur effectif de l'opérateur choisi, pas de `aggregator`
  // (figé à la création de commande) — un opérateur PawaPay routé vers
  // PayDunya doit être appelé avec son code PayDunya, pas son code
  // PawaPay (formats différents, ex. ORANGE_SEN vs ORANGE_SN).
  const effectiveAggregator: 'pawapay' | 'paydunya' = selectedMerged?.effectiveAggregator ?? aggregator
  const effectiveCode = (() => {
    if (!selectedMerged) return provider
    if (effectiveAggregator === 'pawapay') {
      return pawapayList.find((p) => normalizeLabel(providerInfo(p.code).label) === normalizeLabel(selectedMerged.label))?.code ?? selectedMerged.code
    }
    return paydunyaList.find((p) => normalizeLabel(p.label) === normalizeLabel(selectedMerged.label))?.code ?? selectedMerged.code
  })()
  const selectedPaydunyaProvider = effectiveAggregator === 'paydunya' ? paydunyaProviders.find((p) => p.code === effectiveCode) : null

  // Endpoint de statut commun aux deux agrégateurs : confirm-pawapay et
  // confirm-paydunya relisent tous deux le statut agrégé de la commande
  // depuis order-svc (déjà mis à jour par leur webhook respectif) — même
  // contrat de réponse ({status: 'pending'|'completed'|'failed'}),
  // seul le chemin change. effectiveAggregator (pas `aggregator`, figé à
  // la création de commande) — sinon le polling interroge le mauvais
  // agrégateur après une bascule switch-provider.
  function startPolling() {
    const statusEndpoint = effectiveAggregator === 'pawapay' ? 'confirm-pawapay' : 'confirm-paydunya'
    setWaiting(true)
    setShowWaitingMessage(false)
    waitingMessageTimer.current = setTimeout(() => setShowWaitingMessage(true), WAITING_MESSAGE_AFTER_MS)
    pollTimer.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/orders/${orderId}/${statusEndpoint}`, { method: 'POST' })
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
    if (effectiveAggregator === 'paydunya' && selectedPaydunyaProvider?.requires_otp && !otp.trim()) {
      setError('Saisissez le code reçu après avoir suivi les instructions ci-dessus.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const token = localStorage.getItem('miad_token') || localStorage.getItem('token')

      // Bascule le paiement vers le bon agrégateur AVANT tout dépôt si
      // l'opérateur choisi a un routage différent du défaut initial
      // (`aggregator`, figé à la création de commande) — voir
      // switch-provider côté payment-svc. Sans ça, initiateMobileMoneyDeposit/
      // paydunyaSoftpayDepositHandler agiraient sur le mauvais provider déjà
      // enregistré en base (bug remonté 2026-09-02, cas Wave→PayDunya).
      if (effectiveAggregator !== aggregator) {
        const switchRes = await fetch(`/api/orders/${orderId}/switch-payment-provider`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ provider: effectiveAggregator }),
        })
        if (!switchRes.ok) {
          const switchData = await switchRes.json().catch(() => ({}))
          throw new Error(switchData.error || "Impossible de basculer vers l'agrégateur de cet opérateur")
        }
        // switch-provider vide provider_ref (nouvelle facture à créer).
        // Bascule vers PayDunya uniquement : paydunyaSoftpayDepositHandler
        // (contrairement à mobile-money-deposit côté PawaPay, qui recrée
        // son deposit lui-même via mobile_money_provider) suppose qu'une
        // facture PayDunya existe déjà en base — sans ce rappel explicite
        // à /payments/init, provider_ref reste vide et le dépôt réel
        // échoue en 404 "invoice_not_found" (bug remonté 2026-09-02,
        // repéré via une vraie tentative de paiement Wave, order #421).
        if (effectiveAggregator === 'paydunya') {
          const reinitRes = await fetch('/api/orders/reinit-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ order_id: orderId }),
          })
          if (!reinitRes.ok) {
            const reinitData = await reinitRes.json().catch(() => ({}))
            throw new Error(reinitData.error || 'Impossible de préparer le paiement pour cet opérateur')
          }
        }
      }

      if (effectiveAggregator === 'pawapay') {
        const res = await fetch(`/api/orders/${orderId}/mobile-money-deposit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ provider: effectiveCode, phone, country }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Échec du paiement')
        if (data.redirectUrl) {
          // Cet opérateur précis exige une redirection côté agrégateur
          // (REDIRECT_AUTH) — transparent pour le client, juste amené
          // sur la page de son opérateur comme avant ce nouveau flux.
          window.location.href = data.redirectUrl
          return
        }
        startPolling()
        return
      }

      // PayDunya SoftPay
      const res = await fetch(`/api/orders/${orderId}/paydunya-softpay-deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ provider: effectiveCode, phone, customerName, customerEmail, otp }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Échec du paiement')
      if (data.redirectUrl) {
        // Provider "redirect" (Wave, Djamo, Orange Money CI en QR) —
        // même principe que REDIRECT_AUTH côté PawaPay.
        window.location.href = data.redirectUrl
        return
      }
      if (data.wizallTxId) {
        // Flux à 3 étapes : le dépôt est accepté mais PAS confirmé — le
        // client va recevoir un OTP par SMS à saisir dans l'écran suivant.
        setWizallTxId(data.wizallTxId)
        setSubmitting(false)
        return
      }
      // sync ou pending : dans les deux cas success=true à ce stade, mais
      // "pending" veut dire que le client doit encore agir sur son
      // téléphone (composer un code, confirmer un SMS...) — le polling
      // couvre les deux : pour "sync" le webhook confirmera quasi
      // instantanément, pour "pending" ça prendra le temps que le client
      // termine son geste.
      startPolling()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec du paiement')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleWizallConfirm() {
    if (!wizallOtp.trim()) {
      setError('Saisissez le code reçu par SMS.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const token = localStorage.getItem('miad_token') || localStorage.getItem('token')
      const res = await fetch(`/api/orders/${orderId}/paydunya-wizall-confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ phone, transactionId: wizallTxId, authCode: wizallOtp }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error(data.error || data.message || 'Confirmation échouée')
      startPolling()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirmation échouée')
    } finally {
      setSubmitting(false)
    }
  }

  if (wizallTxId) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2.5 px-4 py-3 bg-blue-50 border border-blue-200 rounded-2xl text-[11px] text-blue-800 font-bold leading-snug">
          <Smartphone size={15} className="shrink-0 mt-0.5 text-blue-600" />
          <span>Un code vous a été envoyé par SMS. Saisissez-le ci-dessous pour finaliser votre paiement.</span>
        </div>
        <div>
          <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1.5 block">Code reçu par SMS</label>
          <Input value={wizallOtp} onChange={(e) => setWizallOtp(e.target.value)} placeholder="123456" className="h-12" />
        </div>
        {error && (
          <div className="flex items-start gap-2.5 px-4 py-3 bg-red-50 border border-red-200 rounded-2xl text-[11px] text-red-800 font-bold leading-snug">
            <AlertCircle size={15} className="shrink-0 mt-0.5 text-red-600" />
            <span>{error}</span>
          </div>
        )}
        <Button onClick={handleWizallConfirm} disabled={submitting} className="w-full h-12 font-bold">
          {submitting ? <Loader2 size={18} className="animate-spin" /> : 'Confirmer le paiement'}
        </Button>
      </div>
    )
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
      {aggregator === 'pawapay' && (
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
      )}

      <div>
        <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1.5 block">Opérateur</label>
        <div className="grid grid-cols-2 gap-2">
          {providers.map((p) => {
            // p.label déjà résolu lors de la fusion — providerInfo(p.code)
            // ne sert plus qu'au logo (même référentiel PROVIDER_INFO,
            // indexé par préfixe de code, valable pour les deux agrégateurs).
            const info = { ...providerInfo(p.code), label: p.label }
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

      {selectedPaydunyaProvider?.requires_otp && (
        <>
          <div className="flex items-start gap-2.5 px-4 py-3 bg-blue-50 border border-blue-200 rounded-2xl text-[11px] text-blue-800 font-bold leading-snug">
            <AlertCircle size={15} className="shrink-0 mt-0.5 text-blue-600" />
            <span>{selectedPaydunyaProvider.otp_instruction}</span>
          </div>
          <div>
            <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1.5 block">Code reçu</label>
            <Input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="123456" className="h-12" />
          </div>
        </>
      )}

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

"use client"

import React, { useState, useEffect } from 'react'
import { PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { loadStripe } from '@stripe/stripe-js'
import { Button } from '@/components/ui/button'
import { Loader2, ShieldCheck, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { trackEvent } from '@/lib/analytics'

// Confirmation d'un paiement avec une carte DÉJÀ enregistrée : ne passe pas
// par <Elements>/<PaymentElement> (pas besoin de ressaisir la carte) —
// stripe.confirmCardPayment() fonctionne avec juste l'objet stripe résolu
// par loadStripe(), sans wrapper <Elements>. Gère nativement un éventuel 3DS.
interface SavedCardConfirmButtonProps {
  clientSecret: string
  paymentMethodId: string
  total: number
  currency: string
  orderId: number
}

export function SavedCardConfirmButton({ clientSecret, paymentMethodId, total, currency, orderId }: SavedCardConfirmButtonProps) {
  const [isProcessing, setIsProcessing] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const handleConfirm = async () => {
    setIsProcessing(true)
    setErrorMessage(null)

    const stripe = await loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '')
    if (!stripe) {
      setErrorMessage("Impossible de charger le module de paiement.")
      setIsProcessing(false)
      return
    }

    const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
      payment_method: paymentMethodId,
    })

    if (error) {
      trackEvent('payment_failed', { cartValue: total, paymentFailureReason: (error.message || error.code || 'stripe_error').slice(0, 100), metadata: { paymentMethod: 'stripe_saved_card' } })
      setErrorMessage(error.message || "Une erreur est survenue lors du paiement.")
      toast.error(error.message)
      setIsProcessing(false)
      return
    }

    if (paymentIntent?.status === 'succeeded') {
      trackEvent('payment_success', { cartValue: total, metadata: { paymentMethod: 'stripe_saved_card' } })
      toast.success("Paiement validé !")
      window.location.href = `${window.location.origin}/order-received?order_id=${orderId}&payment_intent=${paymentIntent.id}`
      return
    }

    setIsProcessing(false)
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-500">
      {errorMessage && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-xs font-bold">
          {errorMessage}
        </div>
      )}
      <Button
        type="button"
        onClick={handleConfirm}
        disabled={isProcessing}
        className="w-full h-16 bg-primary text-white font-black uppercase rounded-2xl shadow-xl shadow-primary/20"
      >
        {isProcessing ? <Loader2 className="animate-spin mr-2" /> : <ShieldCheck className="mr-2" />}
        Payer {total.toFixed(2)} {currency}
      </Button>
      <p className="text-[10px] text-center text-muted-foreground uppercase tracking-widest font-bold">
        Transaction sécurisée par cryptage SSL 256-bit
      </p>
    </div>
  )
}

interface StripePaymentFormProps {
  total: number
  currency: string
  orderId: number
  onFallback: () => void
}

// Si Stripe Elements n'a pas fini de charger après ce délai (bloqueur de pub,
// VPN, réseau qui bloque m.stripe.network...), on considère l'échec et on
// propose un mode de paiement de secours au lieu de laisser l'utilisateur
// face à un squelette de chargement infini.
const ELEMENT_LOAD_TIMEOUT_MS = 8000

export function StripePaymentForm({ total, currency, orderId, onFallback }: StripePaymentFormProps) {
  const stripe = useStripe()
  const elements = useElements()
  const [isPayProcessing, setIsPayProcessing] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isElementReady, setIsElementReady] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    if (isElementReady) return
    const timeout = setTimeout(() => setLoadFailed(true), ELEMENT_LOAD_TIMEOUT_MS)
    return () => clearTimeout(timeout)
  }, [isElementReady])

  const handleStripeSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!stripe || !elements) return

    setIsPayProcessing(true)
    setErrorMessage(null)

    const { error: submitError } = await elements.submit()
    if (submitError) {
      setErrorMessage(submitError.message || "Erreur de validation")
      setIsPayProcessing(false)
      return
    }

    // return_url : Stripe y ajoute automatiquement payment_intent et
    // redirect_status après une vérification 3D Secure. On pointe vers
    // /order-received — la même page de confirmation que PayDunya, pour une
    // expérience identique quel que soit le mode de paiement.
    const returnUrl = `${window.location.origin}/order-received?order_id=${orderId}`

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
      confirmParams: { return_url: returnUrl },
    })

    if (error) {
      trackEvent('payment_failed', { cartValue: total, paymentFailureReason: (error.message || error.code || 'stripe_error').slice(0, 100), metadata: { paymentMethod: 'stripe' } })
      setErrorMessage(error.message || "Une erreur est survenue lors du paiement.")
      toast.error(error.message)
      setIsPayProcessing(false)
      return
    }

    if (paymentIntent?.status === 'succeeded') {
      // Pas de 3D Secure nécessaire : le paiement est déjà confirmé sans
      // quitter la page. On navigue quand même vers /order-received (même
      // page que le cas 3D Secure et que PayDunya) pour une expérience de
      // confirmation cohérente ; cette page appelle confirm-stripe elle-même.
      trackEvent('payment_success', { cartValue: total, metadata: { paymentMethod: 'stripe' } })
      toast.success("Paiement validé !")
      window.location.href = `${window.location.origin}/order-received?order_id=${orderId}&payment_intent=${paymentIntent.id}`
      return
    }

    setIsPayProcessing(false)
  }

  return (
    <form onSubmit={handleStripeSubmit} className="space-y-6 animate-in fade-in duration-500">
      <div className="bg-white p-4 rounded-2xl border border-border">
        <PaymentElement
          options={{ layout: 'tabs' }}
          onReady={() => setIsElementReady(true)}
          onLoadError={() => setLoadFailed(true)}
        />
      </div>

      {loadFailed && !isElementReady && (
        <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-800 space-y-3">
          <div className="flex gap-2 text-xs font-bold">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <p>
              Le paiement par carte ne se charge pas. Cela peut venir d'un bloqueur de publicité, d'un VPN
              ou de votre connexion. Désactivez ces outils et réessayez, ou choisissez un autre mode de paiement.
            </p>
          </div>
          <button
            type="button"
            onClick={onFallback}
            className="w-full h-11 bg-amber-800 text-white rounded-xl font-black uppercase text-xs tracking-wide"
          >
            Choisir un autre mode de paiement
          </button>
        </div>
      )}

      {errorMessage && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-xs font-bold">
          {errorMessage}
        </div>
      )}

      <Button
        type="submit"
        disabled={!stripe || !isElementReady || isPayProcessing}
        className="w-full h-16 bg-primary text-white font-black uppercase rounded-2xl shadow-xl shadow-primary/20"
      >
        {isPayProcessing ? <Loader2 className="animate-spin mr-2" /> : <ShieldCheck className="mr-2" />}
        Payer {total.toFixed(2)} {currency}
      </Button>

      <p className="text-[10px] text-center text-muted-foreground uppercase tracking-widest font-bold">
        Transaction sécurisée par cryptage SSL 256-bit
      </p>
    </form>
  )
}

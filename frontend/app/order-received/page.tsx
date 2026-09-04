"use client"

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Image from 'next/image'
import {
  CheckCircle,
  ShoppingBag,
  ChevronRight,
  Clock,
  XCircle,
  Truck,
  CreditCard,
  Loader2,
  MessageCircle,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatPrice } from '@/lib/woocommerce'
import { trackEvent } from '@/lib/analytics'
import { mktPurchase } from '@/lib/marketing-events'
import { RecommendedProducts } from '@/components/miad/RecommendedProducts'

interface PurchasedItem {
  productId: number
  name: string
  quantity: number
  image: string
}

/**
 * MIAD Market - Retour de paiement (PayDunya Mobile Money OU Stripe)
 * PayDunya redirige ici (actions.return_url) avec order_id + token.
 * Stripe redirige ici (confirmParams.return_url) avec order_id + payment_intent
 * (après vérification 3D Secure) — et StripePaymentForm y navigue aussi
 * directement en cas de succès immédiat, pour une expérience de confirmation
 * identique quel que soit le mode de paiement.
 * Le statut affiché vient directement de la commande WooCommerce, déjà mise à
 * jour de façon fiable par le webhook/la vérification serveur-à-serveur — pas
 * besoin de revérifier nous-mêmes auprès de PayDunya/Stripe depuis le front.
 */
// 'timeout' — ajouté le 2026-09-03 : avant ce correctif, après les 5
// tentatives de re-vérification (~1 min), une commande encore
// 'pending_payment' côté order-svc (ex. webhook PawaPay/PayDunya jamais
// arrivé) laissait le client bloqué indéfiniment sur l'écran "en attente"
// — aucun bouton, aucune explication, la page ne ressortait jamais de ce
// cycle pending→retry. Signalé par le fondateur : "il n'a que en attente
// et succès, il n'a pas de vrai résultat". Distinct de 'failed' (qui
// suppose un rejet confirmé) : ici on ne SAIT PAS si ça a échoué ou si la
// confirmation est juste lente — le message et l'action doivent rester
// honnêtes sur cette incertitude plutôt que d'annoncer un échec certain.
type ConfirmState = 'loading' | 'completed' | 'pending' | 'failed' | 'timeout'
type PaymentMethod = 'paydunya' | 'stripe' | 'pawapay'

const BANNER: Record<Exclude<ConfirmState, 'loading'>, { bg: string; text: string }> = {
  completed: { bg: 'bg-green-600', text: "Paiement réussi ! Votre commande sera traitée sous 24h." },
  pending: { bg: 'bg-orange-500', text: 'Paiement en cours de validation.' },
  failed: { bg: 'bg-red-600', text: "Paiement non confirmé pour cette commande." },
  timeout: { bg: 'bg-orange-600', text: "La confirmation prend plus de temps que prévu." },
}

function OrderReceivedContent() {
  const searchParams = useSearchParams()
  const orderId = searchParams.get('order_id')
  const token = searchParams.get('token')
  // Stripe ajoute automatiquement ces paramètres à return_url après une
  // vérification 3D Secure (ou StripePaymentForm les passe directement en
  // cas de succès immédiat, sans redirection navigateur).
  const paymentIntentId = searchParams.get('payment_intent')
  const redirectStatus = searchParams.get('redirect_status')
  // PawaPay redirige ici avec ?provider=pawapay (voir returnUrl construite
  // dans payment-svc/pawapay.go). Pas de token dans l'URL : le statut vient
  // de la commande, confirmée par le webhook serveur-à-serveur PawaPay.
  const providerParam = searchParams.get('provider')

  const method: PaymentMethod = paymentIntentId
    ? 'stripe'
    : providerParam === 'pawapay'
      ? 'pawapay'
      : 'paydunya'

  const [state, setState] = useState<ConfirmState>('loading')
  const [total, setTotal] = useState<string | null>(null)
  const [items, setItems] = useState<PurchasedItem[]>([])

  useEffect(() => {
    if (!orderId || (method === 'paydunya' && !token)) {
      setState('failed')
      return
    }
    // PawaPay : pas de token à vérifier — seul order_id est requis.
    // Stripe : redirect_status='failed' signifie que 3D Secure a échoué,
    // inutile d'appeler confirm-stripe dans ce cas.
    if (method === 'stripe' && redirectStatus === 'failed') {
      trackEvent('payment_failed', { paymentFailureReason: '3d_secure_failed', metadata: { paymentMethod: 'stripe' } })
      setState('failed')
      return
    }

    let cancelled = false
    const endpoint =
      method === 'stripe' ? 'confirm-stripe' : method === 'pawapay' ? 'confirm-pawapay' : 'confirm-paydunya'
    const payload =
      method === 'stripe' ? { payment_intent_id: paymentIntentId } : method === 'pawapay' ? {} : { token }
    // Le webhook Stripe/PayDunya qui confirme réellement la commande est
    // asynchrone et peut arriver quelques secondes APRÈS que le navigateur
    // ait atterri sur cette page (redirection immédiate après paiement) —
    // sans retry, un premier essai trop tôt affiche "non confirmé" alors
    // que le paiement a bel et bien réussi (le webhook confirme juste
    // après). Backoff : 2s, 4s, 8s, 16s, 32s — ~1 minute de tolérance,
    // cohérent avec le délai observé en pratique entre payment_intent.created
    // et payment_intent.succeeded.
    const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000]

    const check = (attempt: number) => {
      fetch(`/api/orders/${orderId}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => null)
          if (cancelled) return

          if (data?.status === 'completed' || (method === 'stripe' && data?.success)) {
            trackEvent('checkout_complete')
            trackEvent('payment_success', { cartValue: data.total ? parseFloat(data.total) : undefined, metadata: { paymentMethod: method } })
            // Purchase (Meta Pixel + CAPI) — sur la page de confirmation,
            // une seule fois par commande. La garde `state !== 'completed'`
            // ci-dessus (via setState plus bas) empêche un double envoi si
            // le composant re-render.
            mktPurchase({
              orderId,
              value: data.total ? parseFloat(data.total) : 0,
              contentIds: Array.isArray(data.items) ? data.items.map((it: any) => String(it.product_id ?? it.id)) : [],
              currency: 'USD',
            })
            setTotal(data.total ?? null)
            setItems(Array.isArray(data.items) ? data.items : [])
            setState('completed')
            if (typeof window !== 'undefined') {
              localStorage.removeItem('miad_cart')
              window.dispatchEvent(new Event('cart-updated'))
            }
          } else if (data?.status === 'pending') {
            if (attempt < RETRY_DELAYS_MS.length) {
              setState('pending')
              setTimeout(() => { if (!cancelled) check(attempt + 1) }, RETRY_DELAYS_MS[attempt])
            } else {
              // Dernière tentative épuisée (~1 min) toujours 'pending' —
              // avant, la page restait figée ici indéfiniment (aucun
              // setTimeout suivant programmé, mais aussi aucun changement
              // d'état pour en sortir). 'timeout' informe honnêtement le
              // client que la confirmation traîne, sans affirmer un échec
              // qu'on ne peut pas confirmer.
              trackEvent('payment_failed', { paymentFailureReason: 'confirm_timeout', metadata: { paymentMethod: method } })
              setState('timeout')
            }
          } else {
            trackEvent('payment_failed', { paymentFailureReason: 'confirm_endpoint_rejected', metadata: { paymentMethod: method } })
            setState('failed')
          }
        })
        .catch(() => {
          if (!cancelled) {
            trackEvent('payment_failed', { paymentFailureReason: 'confirm_endpoint_unreachable', metadata: { paymentMethod: method } })
            setState('failed')
          }
        })
    }

    check(0)
    return () => { cancelled = true }
  }, [orderId, token, method, paymentIntentId, redirectStatus])

  if (state === 'loading') {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 p-6">
        <Loader2 size={40} className="text-accent animate-spin" />
        <p className="font-bold text-muted-foreground">Vérification du paiement en cours...</p>
      </div>
    )
  }

  const isCompleted = state === 'completed'
  const isPending = state === 'pending'
  const isFailed = state === 'failed'
  const isTimeout = state === 'timeout'
  // Pour l'icône/les boutons : timeout se comporte comme failed (le client
  // doit pouvoir agir — réessayer ou contacter le support), seul le texte
  // affiché diffère (voir plus bas) pour ne jamais annoncer un échec
  // qu'on ne peut pas confirmer.
  const needsAction = isFailed || isTimeout
  const banner = BANNER[state]

  return (
    <div className="min-h-screen bg-background flex flex-col selection:bg-accent/20">
      {/* Bandeau de statut en haut, style AliExpress */}
      <div className={`${banner.bg} text-white text-center text-sm md:text-base font-bold py-3 px-4`}>
        {banner.text}
      </div>

      <main className="flex-1 container mx-auto px-4 py-12 md:py-20 flex flex-col items-center">

        <div className="text-center mb-12">
          <div className="mb-8 relative inline-block">
            <div className={`absolute inset-0 ${isCompleted ? 'bg-green-400' : isPending ? 'bg-orange-400' : isTimeout ? 'bg-orange-400' : 'bg-red-400'} rounded-full blur-3xl opacity-20 animate-pulse`}></div>
            <div className={`w-24 h-24 ${isCompleted ? 'bg-green-500' : isPending ? 'bg-orange-500' : isTimeout ? 'bg-orange-500' : 'bg-red-500'} rounded-full flex items-center justify-center relative z-10 shadow-2xl scale-110`}>
              {isCompleted ? <CheckCircle size={48} className="text-white" /> : (isPending || isTimeout) ? <Clock size={48} className="text-white" /> : <XCircle size={48} className="text-white" />}
            </div>
          </div>
          <h1 className="text-4xl md:text-6xl font-black mb-6 tracking-tighter">
            {isCompleted ? 'Merci pour votre achat !' : isPending ? 'Paiement en attente' : isTimeout ? 'La confirmation prend du retard' : 'Paiement non confirmé'}
          </h1>
          <p className="text-muted-foreground text-lg md:text-xl max-w-2xl mx-auto leading-relaxed">
            {isCompleted && `Votre commande #${orderId} est confirmée. Nous préparons vos articles pour l'expédition.`}
            {isTimeout && `La confirmation de votre commande #${orderId} prend plus de temps que prévu. Si le montant a été débité, votre commande sera automatiquement mise à jour dès réception — sinon, réessayez ou contactez le support.`}
            {isPending && (method === 'stripe'
              ? `Votre commande #${orderId} a été enregistrée. La vérification de votre carte est encore en cours — vous recevrez un email de confirmation sous peu.`
              : `Votre commande #${orderId} a été enregistrée. La transaction Mobile Money est en cours de finalisation — vous recevrez un email de confirmation sous peu.`)}
            {isFailed && `Nous n'avons pas pu confirmer le paiement de la commande${orderId ? ` #${orderId}` : ''}. Si le montant a été débité, contactez le support avant de réessayer.`}
          </p>
        </div>

        {isCompleted && (
          <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-12 gap-6 mb-16">
            <div className="md:col-span-7 bg-card border border-border rounded-[2.5rem] p-8 md:p-10 shadow-sm relative overflow-hidden">
              <div className="absolute top-0 right-0 p-8 opacity-[0.03] rotate-12">
                <ShoppingBag size={120} />
              </div>
              <div className="relative z-10">
                <div className="flex justify-between items-start mb-10">
                  <div>
                    <p className="text-[10px] font-black uppercase text-muted-foreground tracking-[0.2em] mb-1">Numéro de Commande</p>
                    <h2 className="text-3xl font-black">#{orderId}</h2>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-black uppercase text-muted-foreground tracking-[0.2em] mb-1">Total Payé</p>
                    <p className="text-3xl font-black text-accent">{total ? `${formatPrice(Number(total))} $` : 'Confirmé'}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-8 mb-8">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-[10px] font-black uppercase text-muted-foreground tracking-widest">
                      <Truck size={12} className="text-accent" /> Livraison
                    </div>
                    <p className="text-sm font-bold">MIAD Express</p>
                    <p className="text-[10px] text-muted-foreground">International (3-5 jours)</p>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-[10px] font-black uppercase text-muted-foreground tracking-widest">
                      <CreditCard size={12} className="text-accent" /> Paiement
                    </div>
                    <p className="text-sm font-bold">{method === 'stripe' ? 'Carte Bancaire (Stripe)' : 'Mobile Money'}</p>
                    <p className="text-[10px] text-muted-foreground">Sécurisé</p>
                  </div>
                </div>

                {items.length > 0 && (
                  <div className="space-y-3 pt-6 border-t border-border/50">
                    {items.map((item) => (
                      <div key={item.productId} className="flex items-center gap-3">
                        <div className="relative w-12 h-12 rounded-xl bg-muted overflow-hidden shrink-0">
                          {item.image ? (
                            <Image src={item.image} alt={item.name} fill className="object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <ShoppingBag size={18} className="text-muted-foreground/40" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold truncate">{item.name}</p>
                          <p className="text-[10px] text-muted-foreground">Qté : {item.quantity}</p>
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => window.location.href = '/?v=clientDashboard'}
                      className="text-xs font-black text-accent hover:underline pt-1"
                    >
                      Voir le détail complet de la commande →
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="md:col-span-5 bg-primary text-primary-foreground rounded-[2.5rem] p-8 md:p-10 flex flex-col shadow-xl">
              <h3 className="font-black text-xl mb-6 text-white">Prochaines étapes</h3>
              <div className="space-y-6 flex-1">
                <div className="flex gap-4">
                  <div className="shrink-0 w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold">1</div>
                  <p className="text-sm opacity-90 leading-snug">Vérifiez vos emails pour le <b>récapitulatif complet</b>.</p>
                </div>
                <div className="flex gap-4">
                  <div className="shrink-0 w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold">2</div>
                  <p className="text-sm opacity-90 leading-snug">Nous validons votre commande et préparons le colis sous <b>24h</b>.</p>
                </div>
                <div className="flex gap-4">
                  <div className="shrink-0 w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold">3</div>
                  <p className="text-sm opacity-90 leading-snug">Vous recevez un <b>lien de suivi MIAD Express</b> dès le départ du colis.</p>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md mb-16">
          {needsAction ? (
            <>
              {isTimeout ? (
                // "Mes Commandes" en premier pour un timeout — le paiement a
                // peut-être réussi et juste pas encore confirmé ; pousser vers
                // "Réessayer" en premier risquerait un double paiement. Le
                // client peut toujours réessayer via le panier s'il le faut.
                <Button
                  onClick={() => window.location.href = '/?v=clientDashboard'}
                  className="flex-1 h-16 rounded-2xl font-black bg-accent text-white gap-3 shadow-xl shadow-accent/20 hover:scale-[1.03] transition-all"
                >
                  Voir mes commandes <ChevronRight size={20} />
                </Button>
              ) : (
                <Button
                  onClick={() => window.location.href = '/?v=cart'}
                  className="flex-1 h-16 rounded-2xl font-black bg-accent text-white gap-3 shadow-xl shadow-accent/20 hover:scale-[1.03] transition-all"
                >
                  <RefreshCw size={20} /> Réessayer le paiement
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => window.location.href = isTimeout ? '/?v=cart' : '/?v=clientDashboard'}
                className="flex-1 h-16 rounded-2xl font-black border-2 gap-3 hover:bg-muted group"
              >
                {isTimeout ? <><RefreshCw size={20} /> Réessayer le paiement</> : <>Mes Commandes <ChevronRight size={20} className="group-hover:translate-x-1 transition-transform" /></>}
              </Button>
            </>
          ) : (
            <>
              <Button
                onClick={() => window.location.href = '/'}
                className="flex-1 h-16 rounded-2xl font-black bg-accent text-white gap-3 shadow-xl shadow-accent/20 hover:scale-[1.03] transition-all"
              >
                <ShoppingBag size={20} /> Continuer mes achats
              </Button>
              <Button
                variant="outline"
                onClick={() => window.location.href = '/?v=clientDashboard'}
                className="flex-1 h-16 rounded-2xl font-black border-2 gap-3 hover:bg-muted group"
              >
                Mes Commandes <ChevronRight size={20} className="group-hover:translate-x-1 transition-transform" />
              </Button>
            </>
          )}
        </div>

        {!needsAction && <RecommendedProducts excludeIds={items.map((i) => i.productId)} />}
      </main>

      {/* Footer de réassurance / aide, style AliExpress */}
      <footer className="border-t border-border bg-muted/30 py-8 px-4">
        <div className="container mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 max-w-4xl text-center sm:text-left">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
              <MessageCircle size={18} className="text-accent" />
            </div>
            <p className="text-sm text-muted-foreground">
              Besoin d'aide avec la commande {orderId ? `#${orderId}` : ''} ? Notre support est disponible 7j/7.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => window.location.href = '/helpcenter'}
            className="rounded-xl font-bold shrink-0"
          >
            Contacter le support
          </Button>
        </div>
      </footer>
    </div>
  )
}

export default function OrderReceivedPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center font-bold">Chargement...</div>}>
      <OrderReceivedContent />
    </Suspense>
  )
}

"use client"

import { useState, useEffect, useMemo, useCallback } from 'react'
import Script from 'next/script'
import Image from 'next/image'
import { cn } from '@/lib/utils'
import { LazyMotion, domAnimation, m, AnimatePresence } from 'framer-motion'
import { ArrowLeft, CheckCircle, Truck, Loader2, X, CreditCard, ExternalLink, ShieldCheck, Wallet, Ticket, Check, AlertCircle, MapPin } from 'lucide-react'
import { validateCoupon } from '@/lib/coupons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { type CartItem, translations } from '@/lib/woocommerce'
import { useCurrency } from '@/contexts/CurrencyContext'
import { toast } from 'sonner'
import { loadStripe } from '@stripe/stripe-js'
import { Elements } from '@stripe/react-stripe-js'
import { StripePaymentForm, SavedCardConfirmButton } from './StripePaymentForm'
import { SavedCardPicker } from './SavedCardPicker'
import { MobileMoneyDirectForm } from './MobileMoneyDirectForm'
import { getShippingCost, ALL_WORLD_COUNTRIES, isLocalDelivery, isSameZoneAfrica, COUNTRY_TO_ZONE, getDialCode, stripDialCode, buildFullPhone } from '@/lib/shipping-utils'
import { useShippingRates, calcShipping } from '@/hooks/useShippingRates'
import { trackEvent } from '@/lib/analytics'

interface CheckoutPageProps {
  language?: 'fr' | 'en'
  cart: CartItem[]
  onBack: () => void
  onOrderComplete: () => void
  shippingRates: Record<string, any>;
  userCountryCode?: string;
  stripeConfirmedOrderId?: number;
  // Déclenché sur un 401/403 (préremplissage profil ou soumission commande) —
  // délègue au flux centralisé de MiadMarketClient.tsx (toast + retour à la
  // connexion). Obligatoire (pas de repli local) : les 3 anciens replis de ce
  // fichier (silencieux au préremplissage, "Session expirée" à la soumission
  // sans token, "Session invalide" au 401/403 de paiement — 3 messages/
  // comportements différents pour le même cas) ont été supprimés le
  // 2026-07-30 pour ne garder qu'un seul flux, cohérent partout sur le site.
  onSessionExpired: () => void
}

// Utilisation de la clé PUBLIQUE (commence par pk_)
const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '');

// Variants pour les transitions de page fluides (AliExpress Style)
const pageVariants = {
  initial: { x: '20%', opacity: 0 },
  animate: { x: 0, opacity: 1 },
  exit: { x: '-20%', opacity: 0 },
};

export function CheckoutPage({ language = 'fr', cart, onBack, onOrderComplete, shippingRates, userCountryCode = 'sn', stripeConfirmedOrderId, onSessionExpired }: CheckoutPageProps) {
  const t = (translations[language] || translations['fr']) as any
  const { formatPrice: fp } = useCurrency()
  const shippingRatesConfig = useShippingRates()
  const [step, setStep] = useState<'form' | 'payment' | 'confirm'>('form')
  const [isProcessing, setIsProcessing] = useState(false)
  // 'mobile_money' est le choix affiché au client ; il est résolu en
  // 'paydunya' OU 'pawapay' à l'envoi selon le fournisseur actif côté
  // backend (GET /api/payment-gateways → gateway.enabled). L'admin bascule
  // entre les deux dans Configuration Système sans toucher au frontend.
  // Mobile Money par défaut sauf si userCountryCode (détection IP/pays de
  // livraison déjà connu à ce stade) est hors Afrique — évite d'ouvrir la
  // page checkout avec une option pré-sélectionnée que le client ne peut
  // pas utiliser (pas de numéro mobile money africain). Reste changeable
  // manuellement dans les deux sens, ce n'est qu'un défaut (2026-08-28).
  const [paymentMethod, setPaymentMethod] = useState<'stripe' | 'mobile_money'>(
    COUNTRY_TO_ZONE[userCountryCode.toUpperCase()] === 'AF' ? 'mobile_money' : 'stripe'
  )
  // Fournisseur mobile money réellement actif — 'pawapay' si activé, sinon
  // 'paydunya' (défaut). Rempli par l'effet ci-dessous.
  const [mobileMoneyProvider, setMobileMoneyProvider] = useState<'paydunya' | 'pawapay'>('paydunya')
  useEffect(() => {
    let cancelled = false
    fetch('/api/payment-gateways')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        const gw: Array<{ id: string; enabled: boolean }> = data?.gateways || []
        const pawapayOn = gw.some((g) => g.id === 'pawapay' && g.enabled)
        setMobileMoneyProvider(pawapayOn ? 'pawapay' : 'paydunya')
      })
      .catch(() => {
        /* repli silencieux sur paydunya — valeur par défaut de l'état */
      })
    return () => { cancelled = true }
  }, [])
  // Lire sessionStorage dans l'initialiseur useState produisait un mismatch
  // d'hydratation (Next.js error #418, même cause que WishlistContext.tsx
  // corrigé le 2026-08-26) : le SSR n'a jamais accès à window (toujours
  // 'standard'), tandis qu'un visiteur revenant avec 'express' déjà en
  // session obtenait une valeur différente dès le premier rendu client.
  const [shippingMethod, setShippingMethod] = useState<'standard' | 'express'>('standard')
  useEffect(() => {
    const saved = sessionStorage.getItem('miad_shipping_method') as 'standard' | 'express' | null
    if (saved) setShippingMethod(saved)
  }, [])
  const [isLoadingShipping, setIsLoadingShipping] = useState(false)
  const [stripeClientSecret, setStripeClientSecret] = useState<string | null>(null)
  const [createdOrderId, setCreatedOrderId] = useState<number | null>(null)
  // Flux mobile money SANS redirection (2026-08-28) : true dès que la
  // commande est créée avec succès et que pawapayUrl est vide (l'opérateur
  // n'est pas encore choisi — c'est justement ce que MobileMoneyDirectForm
  // va demander). false = comportement historique (Payment Page hébergée,
  // redirection immédiate).
  const [showMobileMoneyForm, setShowMobileMoneyForm] = useState(false)
  // Depuis le 2026-08-26, UN SEUL paiement par commande groupée (peu
  // importe le nombre de boutiques) — createdOrderId ET
  // parentOrderIdForRedirect valent donc désormais le même id (le parent)
  // dans tous les cas ; les deux états sont conservés distincts par
  // prudence (repli de l'un sur l'autre plus bas) plutôt que fusionnés,
  // au cas où /api/orders échouerait à résoudre l'un des deux.
  const [parentOrderIdForRedirect, setParentOrderIdForRedirect] = useState<number | null>(null)
  const [activeSection, setActiveSection] = useState<number>(0);
  const [authToken, setAuthToken] = useState<string | null>(null)
  const [selectedPaymentMethodId, setSelectedPaymentMethodId] = useState<string | 'new'>('new')
  const [saveNewCard, setSaveNewCard] = useState(false)

  // Retour depuis 3D Secure Stripe → afficher directement la confirmation
  // (ajustement pendant le rendu plutôt qu'un effet, pour éviter un rendu
  // supplémentaire et un flash de l'état précédent)
  const [prevStripeConfirmedOrderId, setPrevStripeConfirmedOrderId] = useState(stripeConfirmedOrderId)
  if (stripeConfirmedOrderId && stripeConfirmedOrderId !== prevStripeConfirmedOrderId) {
    setPrevStripeConfirmedOrderId(stripeConfirmedOrderId)
    setCreatedOrderId(stripeConfirmedOrderId)
    setStep('confirm')
  }
  const [showValidationErrors, setShowValidationErrors] = useState(false);
  
  const [formData, setFormData] = useState({
    first_name: '',
    last_name: '',
    company: '',
    email: '',
    phone: '',
    address: '',
    address_2: '',
    city: '',
    state: '',
    postcode: '',
    country: userCountryCode.toLowerCase(),
    quartier: '',
    lat: null as number | null,
    lng: null as number | null,
  })

  // 0. Auto-remplissage : Récupérer les infos de l'utilisateur au montage
  useEffect(() => {
    let cancelled = false
    const fetchUserData = async () => {
      const token = localStorage.getItem('miad_token');
      if (!token) return;
      setAuthToken(token)

      try {
        const res = await fetch('/api/customer', {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (res.status === 401) {
          if (cancelled) return
          onSessionExpired()
          return
        }

        const contentType = res.headers.get("content-type");
        if (!res.ok || !contentType || !contentType.includes("application/json")) {
          console.error("Réponse API invalide (HTML reçu)");
          return;
        }

        const json = await res.json();
        if (cancelled) return;
        if (json.success && json.data) {
          const { shipping, billing, email, phone } = json.data;
          const country = (shipping.country || billing.country)?.toLowerCase() || 'sn'
          setFormData(prev => ({
            ...prev,
            first_name: shipping.first_name || billing.first_name || '',
            last_name: shipping.last_name || billing.last_name || '',
            company: billing.company || '',
            email: email || billing.email || prev.email,
            phone: stripDialCode(phone || billing.phone || '', country),
            address: shipping.address_1 || billing.address_1 || '',
            address_2: shipping.address_2 || billing.address_2 || '',
            city: shipping.city || billing.city || '',
            state: shipping.state || billing.state || '',
            postcode: shipping.postcode || billing.postcode || '',
            country
          }));
        }
      } catch (err) {
        console.warn("Impossible de pré-remplir le profil");
      }
    };
    fetchUserData();
    return () => { cancelled = true }
  }, []);

  // Calcul précis basé sur le prix de la variante si elle existe
  const subtotal = cart.reduce((sum, item) => {
    const price = Number(item.variation?.price || item.product.price || 0);
    return sum + (price * Number(item.quantity));
  }, 0)

  // ── Livraison nationale Sénégal (distance vendeur → client) ──────────
  // Actif uniquement quand le pays du client est SN. Un devis est demandé
  // par vendeur présent dans le panier (chaque vendeur a sa propre origine
  // -> sa propre distance -> son propre tarif, cahier des charges du
  // 2026-08-16 section 5 "multi-vendeur"). Tant qu'un vendeur n'a pas
  // encore renseigné son adresse d'expédition, l'API renvoie un tarif de
  // secours plutôt que d'échouer (voir miad-shipping-domestic.php). Le prix
  // renvoyé par l'API est déjà converti en USD (tiers admin exprimés en
  // FCFA côté WordPress) — même unité que subtotal, pas de conversion ici.
  const isDomesticSN = formData.country === 'sn'
  const uniqueVendors = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of cart) {
      const id = item.product.vendor?.id
      if (id) map.set(String(id), item.product.vendor?.name || 'Boutique')
    }
    return Array.from(map, ([id, name]) => ({ id, name }))
  }, [cart])

  const [domesticQuotes, setDomesticQuotes] = useState<Record<string, { price: number; distance_km: number | null; tier_label: string | null; eta_label: string | null }>>({})
  const [domesticLoading, setDomesticLoading] = useState(false)
  const [locatingBuyer, setLocatingBuyer] = useState(false)

  useEffect(() => {
    if (!isDomesticSN || !formData.city || uniqueVendors.length === 0) return
    let cancelled = false
    setDomesticLoading(true)
    const timer = setTimeout(() => {
      Promise.all(uniqueVendors.map(async (v) => {
        try {
          const res = await fetch('/api/shipping-domestic/calculate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              vendorId: v.id,
              buyerCity: formData.city,
              buyerLat: formData.lat,
              buyerLng: formData.lng,
              cartTotal: subtotal,
            }),
          })
          const data = await res.json()
          return [v.id, { price: data.price ?? 0, distance_km: data.distance_km ?? null, tier_label: data.tier_label ?? null, eta_label: data.eta_label ?? null }] as const
        } catch {
          return [v.id, { price: 5, distance_km: null, tier_label: null, eta_label: null }] as const
        }
      })).then((results) => {
        if (cancelled) return
        setDomesticQuotes(Object.fromEntries(results))
        setDomesticLoading(false)
      })
    }, 500) // debounce le temps que le client finisse de taper la ville
    return () => { cancelled = true; clearTimeout(timer) }
  }, [isDomesticSN, formData.city, formData.lat, formData.lng, uniqueVendors, subtotal])

  const domesticReady = isDomesticSN && uniqueVendors.length > 0 && uniqueVendors.every(v => domesticQuotes[v.id])
  const domesticShippingTotal = useMemo(
    () => uniqueVendors.reduce((sum, v) => sum + (domesticQuotes[v.id]?.price || 0), 0),
    [uniqueVendors, domesticQuotes]
  )

  const handleLocateBuyer = () => {
    if (!navigator.geolocation) return
    setLocatingBuyer(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setFormData(f => ({ ...f, lat: position.coords.latitude, lng: position.coords.longitude }))
        setLocatingBuyer(false)
      },
      () => setLocatingBuyer(false),
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  // Nouvelle fonction de calcul partagée pour corriger l'erreur TS et harmoniser la logique
  // Tarifs dynamiques depuis l'admin WordPress
  const calculateShippingForMethod = useCallback((method: 'standard' | 'express') => {
    return cart.reduce((sum, item) => {
      return sum + calcShipping(item.product.countryCode || '', userCountryCode, method, shippingRatesConfig, COUNTRY_TO_ZONE) * item.quantity
    }, 0)
  }, [cart, userCountryCode, shippingRatesConfig]);

  const FREE_SHIPPING_THRESHOLD = 150
  const isFreeShipping = subtotal >= FREE_SHIPPING_THRESHOLD

  // Calcul des frais de livraison totaux — si le vendeur ET le client sont
  // au Sénégal et que le tarif par distance a pu être calculé pour chaque
  // vendeur du panier, il remplace le système international par zone
  // (MIAD Standard/Express) qui n'a pas de sens pour une livraison locale.
  const shippingTotal = useMemo(() =>
    isFreeShipping ? 0 : (domesticReady ? domesticShippingTotal : calculateShippingForMethod(shippingMethod)),
  [calculateShippingForMethod, shippingMethod, isFreeShipping, domesticReady, domesticShippingTotal]);

  const [couponInput,   setCouponInput]   = useState('')
  const [appliedCoupon, setAppliedCoupon] = useState<{ code: string; discount: number; message: string } | null>(null)
  const [couponError,   setCouponError]   = useState('')
  const [couponLoading, setCouponLoading] = useState(false)

  const applyCoupon = () => {
    if (!couponInput.trim()) return
    setCouponLoading(true)
    setCouponError('')
    setTimeout(() => {
      const result = validateCoupon(couponInput, subtotal)
      if (result.valid) {
        setAppliedCoupon({ code: couponInput.toUpperCase().trim(), discount: result.discount, message: result.message })
        setCouponError('')
      } else {
        setCouponError(result.message)
        setAppliedCoupon(null)
      }
      setCouponLoading(false)
    }, 500)
  }

  const couponDiscount = appliedCoupon?.discount ?? 0
  const total = subtotal + shippingTotal - couponDiscount;

  // 2. Calculer les frais de livraison réels quand l'adresse change

  const validateAddress = () => {
    if (!formData.first_name || !formData.last_name || !formData.email || !formData.address || !formData.city || !formData.phone) {
      setShowValidationErrors(true);
      toast.error("Veuillez remplir tous les champs obligatoires (Nom, Email, Téléphone, Adresse et Ville).");
      return false;
    }
    setShowValidationErrors(false);
    return true;
  };

  const handleSubmit = async () => {
    if (!validateAddress()) {
      setActiveSection(0); // Réouvrir la section adresse si erreur
      return;
    }
    await processFinalOrder()
  }

  const processFinalOrder = async () => {
    // Résout le choix client ('mobile_money') en fournisseur réel envoyé au
    // backend. 'stripe' passe tel quel.
    const resolvedMethod: 'stripe' | 'paydunya' | 'pawapay' =
      paymentMethod === 'stripe' ? 'stripe' : mobileMoneyProvider
    trackEvent('payment_attempt', { cartValue: total, metadata: { paymentMethod: resolvedMethod } })
    setIsProcessing(true)
    const token = localStorage.getItem('miad_token') || localStorage.getItem('token')

    if (!token) {
      onSessionExpired()
      setIsProcessing(false)
      return
    }

    try {
      // app/api/orders/route.ts (POST) attend un champ `lines` au format
      // order-svc (product_id/variation_id/vendor_id/name/quantity/
      // unit_price_usd) — ce code envoyait encore `line_items` au format
      // WooCommerce/Dokan (meta_data), un champ que la route ignore
      // totalement. Résultat : `lines` était toujours undefined côté
      // serveur, donc "Le panier est vide" (400) à chaque tentative de
      // paiement, peu importe le vrai contenu du panier (bug de prod
      // trouvé le 2026-08-26, sans lien avec Stripe — le message d'erreur
      // trompeur laissait croire à un problème de configuration paiement).
      const lines = cart.map(item => ({
        product_id: Number(item.product.id),
        variation_id: item.variation?.id ? parseInt(item.variation.id) : 0,
        vendor_id: item.product.vendor?.id ? Number(item.product.vendor.id) : 0,
        name: item.product.name,
        quantity: item.quantity,
        unit_price_usd: Number(item.variation?.price ?? item.product.price ?? 0),
      }))

      const fullPhone = buildFullPhone(formData.country, formData.phone)
      // Pas de champ WooCommerce dédié au quartier — repli sur address_2,
      // seul champ d'adresse restant libre pour cette précision utile au
      // livreur (livraison nationale Sénégal).
      const address2WithQuartier = formData.quartier
        ? [formData.address_2, formData.quartier].filter(Boolean).join(' — ')
        : formData.address_2

      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          payment_method: resolvedMethod,
          amount: total,
          shipping_total: shippingTotal,
          shipping_method_id: domesticReady ? 'miad_domestic' : (shippingMethod === 'express' ? 'miad_express' : 'miad_standard'),
          savePaymentMethod: paymentMethod === 'stripe' && selectedPaymentMethodId === 'new' ? saveNewCard : false,
          paymentMethodId: paymentMethod === 'stripe' && selectedPaymentMethodId !== 'new' ? selectedPaymentMethodId : undefined,
          lines,
          save_address: true, // Enregistre l'adresse sur le profil pour le pré-remplissage des prochaines commandes
          shipping: {
            first_name: formData.first_name,
            last_name: formData.last_name,
            company: formData.company,
            address_1: formData.address,
            address_2: address2WithQuartier,
            city: formData.city,
            state: formData.state,
            postcode: formData.postcode,
            country: formData.country.toUpperCase(),
            phone: fullPhone
          },
          billing: {
            first_name: formData.first_name,
            last_name: formData.last_name,
            company: formData.company,
            address_1: formData.address,
            address_2: address2WithQuartier,
            city: formData.city,
            state: formData.state,
            postcode: formData.postcode,
            country: formData.country.toUpperCase(),
            phone: fullPhone,
            email: formData.email,
          }
        })
      })

      const data = await response.json()

      if (!response.ok) {
        const httpError = new Error(data.error || "Erreur lors de la commande") as Error & { status?: number }
        httpError.status = response.status
        throw httpError
      }

      // Si c'est Stripe, on affiche le formulaire de carte
      if (resolvedMethod === 'stripe' && data.clientSecret) {
        setStripeClientSecret(data.clientSecret);
        setCreatedOrderId(data.orderId);
        setParentOrderIdForRedirect(data.parentOrderId ?? data.orderId);
        setStep('payment'); // On passe à la page de paiement dédiée
        // 'step' est un état interne (pas une navigation via navigateTo), donc
        // rien ne remettait le scroll en haut — si le formulaire d'adresse
        // était long et le client scrollé en bas, le formulaire de carte
        // Stripe apparaissait hors écran.
        window.scrollTo(0, 0)
        trackEvent('checkout_step', { checkoutStepNumber: 2, metadata: { step: 'payment', paymentMethod: resolvedMethod } })
      }
      // PawaPay : deux chemins possibles selon si l'opérateur a déjà été
      // choisi ou non à ce stade (il ne l'a jamais été ici — le choix se
      // fait sur MobileMoneyDirectForm.tsx, PAS avant, voir plus bas).
      // pawapayUrl présent = ancien comportement jamais déclenché depuis
      // ce chemin (gardé pour compatibilité si jamais buyer_phone seul
      // suffit un jour) ; en pratique on affiche toujours le formulaire.
      else if (resolvedMethod === 'pawapay') {
        setCreatedOrderId(data.orderId);
        setParentOrderIdForRedirect(data.parentOrderId ?? data.orderId);
        if (data.pawapayUrl) {
          trackEvent('checkout_step', { checkoutStepNumber: 2, metadata: { step: 'redirect', paymentMethod: 'pawapay' } })
          window.location.href = data.pawapayUrl;
        } else {
          // Flux sans redirection (2026-08-28) : la commande existe, le
          // paiement 'initiated' aussi — MobileMoneyDirectForm.tsx va
          // maintenant demander opérateur + numéro puis déclencher le
          // dépôt réel via POST /api/orders/{id}/mobile-money-deposit.
          trackEvent('checkout_step', { checkoutStepNumber: 2, metadata: { step: 'mobile_money_form', paymentMethod: 'pawapay' } })
          setShowMobileMoneyForm(true)
          window.scrollTo(0, 0)
        }
      }
      else if (resolvedMethod === 'paydunya' && data.paydunyaToken) {
        setCreatedOrderId(data.orderId);
        setParentOrderIdForRedirect(data.parentOrderId ?? data.orderId);
        // Ouverture de la modal PayDunya via le SDK chargé par Script
        if (typeof (window as any).PayDunyaCheckout !== 'undefined') {
          (window as any).PayDunyaCheckout.setup({
            token: data.paydunyaToken,
            onSuccess: () => {
              trackEvent('payment_success', { cartValue: total, metadata: { paymentMethod: 'paydunya' } })
              setStep('confirm');
              window.scrollTo(0, 0)
              trackEvent('checkout_step', { checkoutStepNumber: 3, metadata: { step: 'confirm', paymentMethod: 'paydunya' } })
              setTimeout(onOrderComplete, 5000);
            },
            onFailure: () => {
              trackEvent('payment_failed', { cartValue: total, paymentFailureReason: 'paydunya_failure', metadata: { paymentMethod: 'paydunya' } })
              toast.error("Le paiement a échoué. Veuillez réessayer.");
            },
            onClose: () => {
              trackEvent('cart_abandoned', { cartValue: total, metadata: { step: 'payment', paymentMethod: 'paydunya' } })
              toast("Paiement annulé.");
            }
          });
          (window as any).PayDunyaCheckout.open();
        } else {
          // Si le SDK n'est pas prêt, redirection vers l'URL directe
          window.location.href = data.paydunyaUrl;
        }
      }
      else {
        // resolvedMethod ne peut plus valoir 'pawapay' ici : le bloc
        // ci-dessus le capture désormais TOUJOURS (avec ou sans
        // redirectUrl) depuis le 2026-08-28 — seul 'paydunya' peut encore
        // atterrir dans ce cas d'erreur générique.
        const methodLabel = resolvedMethod === 'stripe' ? 'Stripe' : 'PayDunya';
        console.error(`[Checkout] Réponse d'initialisation incomplète pour ${methodLabel}`, data);
        throw new Error(`Erreur d'initialisation du paiement ${methodLabel}. Veuillez vérifier la configuration serveur.`);
      }
    } catch (err: any) {
      const isAuthError = err.status === 401 || err.status === 403
      const msg = isAuthError
        ? "Session invalide. Veuillez vous reconnecter."
        : (err.message || "Erreur de validation.");
      trackEvent('payment_failed', { cartValue: total, paymentFailureReason: msg.slice(0, 100), metadata: { paymentMethod } })

      // Le token stocké n'est plus valide (expiré ou révoqué) : on renvoie
      // vers la connexion plutôt que de laisser le client bloqué sur un
      // checkout qui échouera systématiquement — c'était la 1ère cause d'échec
      // de paiement observée (0% de commandes finalisées côté "Tentative paiement").
      if (isAuthError) {
        onSessionExpired()
      } else {
        toast.error(msg);
      }
    } finally {
      setIsProcessing(false)
    }
  }

  const handleBack = () => {
    if (step === 'payment') {
      setStep('form');
      window.scrollTo(0, 0)
    } else {
      onBack();
    }
  };

  if (step === 'confirm') {
    return (
      <LazyMotion features={domAnimation}>
      <main className="min-h-screen bg-muted/30 flex items-center justify-center py-10 animate-in fade-in duration-500">
        <div className="bg-card p-8 rounded-[2.5rem] border shadow-2xl shadow-primary/5 text-center max-w-md w-full mx-4">
          <div className="w-24 h-24 mx-auto mb-6 rounded-full bg-green-500/10 flex items-center justify-center animate-in zoom-in-50 duration-500 ease-out">
            <CheckCircle size={50} className="text-green-500" />
          </div>
          <m.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-card p-8 rounded-[2.5rem] border shadow-2xl text-center max-w-md w-full mx-4"
          >
            <CheckCircle size={60} className="text-green-500 mx-auto mb-6" />
            <h1 className="text-3xl font-black uppercase tracking-tighter mb-4">Succès !</h1>
            <div className="bg-muted p-4 rounded-2xl mb-6">
              <p className="text-[10px] text-muted-foreground uppercase font-black mb-1">Commande</p>
              <p className="text-xl font-mono font-black text-primary">#{createdOrderId}</p>
            </div>
            <p className="text-muted-foreground mb-8 text-sm">Elle arrive chez vous sous {shippingMethod === 'express' ? '3 à 5' : '15'} jours ouvrés.</p>
            <Button
              onClick={onOrderComplete}
              className="w-full h-16 bg-primary text-white font-black uppercase rounded-2xl"
            >
              Retour à la boutique
            </Button>
          </m.div>
        </div>
      </main>
      </LazyMotion>
    )
  }

  // --- VUE DÉDIÉE MOBILE MONEY SANS REDIRECTION (2026-08-28) ---
  if (showMobileMoneyForm && createdOrderId) {
    return (
      <LazyMotion features={domAnimation}>
      <main className="min-h-screen bg-muted/20 py-12">
        <div className="container mx-auto px-4 max-w-2xl">
          <button
            type="button"
            onClick={() => { setShowMobileMoneyForm(false); setStep('form') }}
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground mb-8 transition-colors font-bold uppercase text-xs tracking-widest"
          >
            <ArrowLeft size={16} />
            <span>Modifier mes informations</span>
          </button>
          <m.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="bg-white rounded-[2.5rem] border border-border p-8 md:p-12 shadow-2xl"
          >
            <div className="text-center mb-8">
              <h1 className="text-3xl font-black uppercase tracking-tighter italic">Mobile Money</h1>
              <p className="text-sm text-muted-foreground mt-2 font-medium">Commande #{createdOrderId} · Total : {fp(total)}</p>
            </div>
            <MobileMoneyDirectForm
              orderId={createdOrderId}
              countryISO2={formData.country}
              phoneHint={formData.phone}
              onSuccess={() => {
                trackEvent('payment_success', { cartValue: total, metadata: { paymentMethod: 'pawapay' } })
                setStep('confirm')
                window.scrollTo(0, 0)
                setTimeout(onOrderComplete, 5000)
              }}
              onFailure={(message) => {
                trackEvent('payment_failed', { cartValue: total, paymentFailureReason: 'pawapay_failure', metadata: { paymentMethod: 'pawapay' } })
                toast.error(message)
              }}
              onNeedsFormRestart={() => { setShowMobileMoneyForm(false); setStep('form') }}
            />
          </m.div>
        </div>
      </main>
      </LazyMotion>
    )
  }

  // --- VUE DÉDIÉE AU PAIEMENT (Page épurée) ---
  if (step === 'payment' && stripeClientSecret) {
    return (
      <LazyMotion features={domAnimation}>
      <main className="min-h-screen bg-muted/20 py-12">
        <Script src="https://app.paydunya.com/js/checkout.js" strategy="afterInteractive" />
        <div className="container mx-auto px-4 max-w-2xl">
          <button
            type="button"
            onClick={() => setStep('form')}
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground mb-8 transition-colors font-bold uppercase text-xs tracking-widest"
          >
            <ArrowLeft size={16} />
            <span>Modifier mes informations</span>
          </button>

          <m.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="bg-white rounded-[2.5rem] border border-border p-8 md:p-12 shadow-2xl"
          >
            <div className="text-center mb-10">
               <div className="flex justify-center gap-3 mb-4">
                  <div className="w-12 h-12 bg-white rounded-xl border border-border flex items-center justify-center p-2 shadow-sm">
                    <img src="/logo/ga.svg" alt="GA" className="w-full h-full object-contain" />
                  </div>
                  <div className="w-12 h-12 bg-white rounded-xl border border-border flex items-center justify-center p-2 shadow-sm">
                    <img src="/logo/limk.svg" alt="Limk" className="w-full h-full object-contain" />
                  </div>
               </div>
               <h1 className="text-3xl font-black uppercase tracking-tighter italic">Paiement Sécurisé</h1>
               <p className="text-sm text-muted-foreground mt-2 font-medium">Commande #{createdOrderId} · Total : {fp(total)}</p>
            </div>

            {selectedPaymentMethodId !== 'new' ? (
              // Carte déjà enregistrée : pas besoin de <Elements>/<PaymentElement>,
              // on confirme directement avec le payment_method existant.
              <SavedCardConfirmButton
                clientSecret={stripeClientSecret}
                paymentMethodId={selectedPaymentMethodId}
                total={total}
                currency={cart[0]?.product.currency || 'USD'}
                orderId={createdOrderId || 0}
                redirectOrderId={parentOrderIdForRedirect || createdOrderId || 0}
              />
            ) : (
              <Elements stripe={stripePromise} options={{ clientSecret: stripeClientSecret }}>
                <StripePaymentForm
                  total={total}
                  currency={cart[0]?.product.currency || 'USD'}
                  orderId={createdOrderId || 0}
                  redirectOrderId={parentOrderIdForRedirect || createdOrderId || 0}
                  onFallback={() => {
                    setPaymentMethod('mobile_money');
                    setStep('form');
                    window.scrollTo(0, 0)
                    toast("Choisissez un autre mode de paiement ci-dessous.");
                  }}
                />
              </Elements>
            )}

            <div className="mt-12 pt-8 border-t border-slate-100 flex flex-col items-center gap-4">
               <div className="flex items-center gap-2 text-[10px] font-black text-green-600 uppercase tracking-widest">
                  <ShieldCheck size={16} /> {t.buyerProtectionActive}
               </div>
            </div>
          </m.div>
        </div>
      </main>
      </LazyMotion>
    );
  }

  return (
    <LazyMotion features={domAnimation}>
    <main className="min-h-screen bg-background py-8">
        <Script src="https://app.paydunya.com/js/checkout.js" strategy="afterInteractive" />
      <div className="container mx-auto px-4 max-w-4xl">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <ArrowLeft size={20} />
          <span>{t.backToCart || 'Retour au panier'}</span>
        </button>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 pb-24 lg:pb-0">
          {/* Form */}
          <div className="lg:col-span-2">
            <AnimatePresence mode="wait">
              <m.div
                key={step}
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="bg-card rounded-3xl border border-border p-4 md:p-8 shadow-sm space-y-6"
              >
                <>
                  {/* 1. Adresse de Livraison (Pliable) */}
                  <div className={`border-b border-border pb-6 transition-all`}>
                    <button
                      type="button"
                      onClick={() => setActiveSection(0)}
                      className="w-full flex items-center justify-between group"
                    >
                      <div className="flex items-center gap-4">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center font-black text-sm ${activeSection === 0 ? 'bg-accent text-white' : 'bg-muted text-muted-foreground'}`}>1</div>
                        <h2 className={`text-lg font-bold flex items-center gap-2 ${activeSection === 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                          <Truck size={22} /> {t.shippingAddress || 'Adresse'}
                        </h2>
                      </div>
                      {activeSection !== 0 && <span className="text-[10px] font-black text-accent uppercase tracking-widest group-hover:underline">Modifier</span>}
                    </button>

                    <AnimatePresence>
                      {activeSection === 0 && (
                        <m.div layout initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                          <div className="pt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <Label>Prénom <span className="text-destructive">*</span></Label>
                              <Input
                                value={formData.first_name}
                                onChange={e => setFormData({...formData, first_name: e.target.value})}
                                className={cn("h-12 rounded-xl mt-1", showValidationErrors && !formData.first_name && "border-destructive ring-1 ring-destructive")}
                              />
                            </div>
                            <div>
                              <Label>Nom <span className="text-destructive">*</span></Label>
                              <Input
                                value={formData.last_name}
                                onChange={e => setFormData({...formData, last_name: e.target.value})}
                                className={cn("h-12 rounded-xl mt-1", showValidationErrors && !formData.last_name && "border-destructive ring-1 ring-destructive")}
                              />
                            </div>
                            <div className="md:col-span-2">
                              <Label>Entreprise <span className="text-muted-foreground text-xs">(optionnel)</span></Label>
                              <Input
                                value={formData.company}
                                onChange={e => setFormData({...formData, company: e.target.value})}
                                className="h-12 rounded-xl mt-1"
                              />
                            </div>
                            <div>
                              <Label>Email <span className="text-destructive">*</span></Label>
                              <Input
                                type="email"
                                value={formData.email}
                                onChange={e => setFormData({...formData, email: e.target.value})}
                                className={cn("h-12 rounded-xl mt-1", showValidationErrors && !formData.email && "border-destructive ring-1 ring-destructive")}
                              />
                            </div>
                            <div>
                              <Label>Téléphone <span className="text-destructive">*</span></Label>
                              <div className={cn("flex items-stretch mt-1 rounded-xl border border-input overflow-hidden", showValidationErrors && !formData.phone && "border-destructive ring-1 ring-destructive")}>
                                <span className="flex items-center px-3 bg-muted text-sm font-bold text-muted-foreground border-r border-input shrink-0">
                                  {getDialCode(formData.country)}
                                </span>
                                <Input
                                  value={formData.phone}
                                  onChange={e => setFormData({...formData, phone: e.target.value.replace(/[^\d]/g, '')})}
                                  placeholder="771234567"
                                  className="h-12 rounded-none border-0 focus-visible:ring-0"
                                />
                              </div>
                            </div>
                            <div>
                              <Label>Pays / Région <span className="text-destructive">*</span></Label>
                              <select aria-label="Pays / Région" value={formData.country} onChange={e => setFormData({...formData, country: e.target.value})} className="w-full h-12 rounded-xl border border-input bg-background px-3 mt-1 text-sm">
                                {ALL_WORLD_COUNTRIES.toSorted((a, b) => a.name.localeCompare(b.name, 'fr')).map((c) => <option key={c.code} value={c.code}>{c.flag} {c.name}</option>)}
                              </select>
                            </div>
                            <div>
                              <Label>État / Région</Label>
                              <Input
                                value={formData.state}
                                onChange={e => setFormData({...formData, state: e.target.value})}
                                className="h-12 rounded-xl mt-1"
                              />
                            </div>
                            <div className="md:col-span-2">
                              <Label>Adresse <span className="text-destructive">*</span></Label>
                              <Input
                                placeholder="Numéro et nom de rue"
                                value={formData.address}
                                onChange={e => setFormData({...formData, address: e.target.value})}
                                className={cn("h-12 rounded-xl mt-1", showValidationErrors && !formData.address && "border-destructive ring-1 ring-destructive")}
                              />
                            </div>
                            <div className="md:col-span-2">
                              <Input
                                placeholder="Appartement, bureau, etc. (optionnel)"
                                value={formData.address_2}
                                onChange={e => setFormData({...formData, address_2: e.target.value})}
                                className="h-12 rounded-xl mt-1"
                              />
                            </div>
                            <div>
                              <Label>Ville <span className="text-destructive">*</span></Label>
                              <Input
                                value={formData.city}
                                onChange={e => setFormData({...formData, city: e.target.value})}
                                className={cn("h-12 rounded-xl mt-1", showValidationErrors && !formData.city && "border-destructive ring-1 ring-destructive")}
                              />
                            </div>
                            <div>
                              <Label>Code postal</Label>
                              <Input
                                value={formData.postcode}
                                onChange={e => setFormData({...formData, postcode: e.target.value})}
                                className="h-12 rounded-xl mt-1"
                              />
                            </div>
                            {isDomesticSN && (
                              <>
                                <div>
                                  <Label>Quartier</Label>
                                  <Input
                                    value={formData.quartier}
                                    onChange={e => setFormData({...formData, quartier: e.target.value})}
                                    placeholder="Sacré-Cœur 3, Point E…"
                                    className="h-12 rounded-xl mt-1"
                                  />
                                </div>
                                <div className="flex flex-col justify-end">
                                  <button
                                    type="button"
                                    onClick={handleLocateBuyer}
                                    disabled={locatingBuyer}
                                    className="h-12 px-4 border border-input rounded-xl text-sm font-bold flex items-center justify-center gap-2 hover:bg-muted transition-colors disabled:opacity-50 mt-1"
                                  >
                                    {locatingBuyer ? <Loader2 size={15} className="animate-spin" /> : <MapPin size={15} />}
                                    {formData.lat ? 'Position enregistrée' : 'Ma position (précision livraison)'}
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                          <Button
                            onClick={() => {
                              if(validateAddress()) setActiveSection(1);
                            }} 
                            className="mt-8 bg-slate-900 text-white h-12 px-10 rounded-xl font-bold"
                          >
                            Continuer vers la livraison
                          </Button>
                        </m.div>
                      )}
                    </AnimatePresence>
                    {activeSection !== 0 && formData.address && (
                      <div className="mt-2 pl-14 text-xs font-medium text-muted-foreground truncate">{formData.first_name} {formData.last_name} • {formData.address}, {formData.city}</div>
                    )}
                  </div>

                  {/* 2. Mode de Livraison (Pliable) */}
                  <div className={`border-b border-border pb-6 transition-all`}>
                    <button type="button" onClick={() => setActiveSection(1)} className="w-full flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center font-black text-sm ${activeSection === 1 ? 'bg-accent text-white' : 'bg-muted text-muted-foreground'}`}>2</div>
                        <h2 className={`text-lg font-bold flex items-center gap-2 ${activeSection === 1 ? 'text-foreground' : 'text-muted-foreground'}`}>Mode de livraison</h2>
                      </div>
                    </button>

                    <AnimatePresence>
                      {activeSection === 1 && (
                        <m.div layout initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                          {domesticReady ? (
                            <div className="pt-8">
                              <div className="p-4 rounded-2xl border-2 border-primary bg-primary/5 shadow-md">
                                <div className="flex justify-between items-center mb-1">
                                  <span className="font-black text-xs uppercase flex items-center gap-1.5"><Truck size={14} /> Livraison nationale — Sénégal</span>
                                  <span className="font-bold text-accent">{fp(domesticShippingTotal)}</span>
                                </div>
                                <p className="text-[10px] text-muted-foreground mb-3">Tarif calculé selon la distance entre chaque boutique et votre adresse.</p>
                                <div className="space-y-1.5 pt-2 border-t border-primary/10">
                                  {uniqueVendors.map(v => {
                                    const q = domesticQuotes[v.id]
                                    if (!q) return null
                                    return (
                                      <div key={v.id} className="flex justify-between items-center text-[11px]">
                                        <span className="text-muted-foreground truncate">{v.name}{q.distance_km != null ? ` · ${q.distance_km} km` : ''}{q.eta_label ? ` · ${q.eta_label}` : ''}</span>
                                        <span className="font-bold shrink-0 ml-2">{fp(q.price)}</span>
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="pt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
                              <button type="button" onClick={() => setShippingMethod('standard')} className={`p-4 rounded-2xl border-2 text-left transition-all ${shippingMethod === 'standard' ? 'border-primary bg-primary/5 shadow-md' : 'border-slate-100'}`}>
                                <div className="flex justify-between items-center mb-1"><span className="font-black text-xs uppercase">MIAD Standard</span><span className="font-bold text-accent">{fp(calculateShippingForMethod('standard'))}</span></div>
                                <p className="text-[10px] text-muted-foreground">Arrivée sous 15 jours</p>
                              </button>
                              <button type="button" onClick={() => setShippingMethod('express')} className={`p-4 rounded-2xl border-2 text-left transition-all ${shippingMethod === 'express' ? 'border-accent bg-accent/5 shadow-md' : 'border-slate-100'}`}>
                                <div className="flex justify-between items-center mb-1"><span className="font-black text-xs uppercase">MIAD Express</span><span className="font-bold text-accent">{fp(calculateShippingForMethod('express'))}</span></div>
                                <p className="text-[10px] text-muted-foreground">Arrivée sous 3-5 jours</p>
                              </button>
                              {isDomesticSN && domesticLoading && (
                                <div className="sm:col-span-2 text-[11px] text-muted-foreground flex items-center gap-1.5">
                                  <Loader2 size={12} className="animate-spin" /> Calcul du tarif de livraison locale en cours…
                                </div>
                              )}
                            </div>
                          )}
                          <Button onClick={() => setActiveSection(2)} className="mt-8 bg-slate-900 text-white h-12 px-10 rounded-xl font-bold">Continuer vers le paiement</Button>
                        </m.div>
                      )}
                    </AnimatePresence>
                    {activeSection !== 1 && (
                      <div className="mt-2 pl-14 text-xs font-medium text-muted-foreground">{domesticReady ? 'Livraison nationale — Sénégal' : (shippingMethod === 'express' ? 'MIAD Express' : 'MIAD Standard')}</div>
                    )}
                  </div>

                  {/* 3. Mode de Paiement (Pliable) */}
                  <div className="pb-4">
                    <button type="button" onClick={() => setActiveSection(2)} className="w-full flex items-center justify-between mb-6">
                      <div className="flex items-center gap-4">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center font-black text-sm ${activeSection === 2 ? 'bg-accent text-white' : 'bg-muted text-muted-foreground'}`}>3</div>
                        <h2 className={`text-lg font-bold flex items-center gap-2 ${activeSection === 2 ? 'text-foreground' : 'text-muted-foreground'}`}>Paiement sécurisé</h2>
                      </div>
                    </button>

                    {/* Options de paiement toujours visibles (pas de repli sur mobile) */}
                    <div className="space-y-3">
                      {/* Option Mobile Money — le fournisseur réel (PawaPay ou
                          PayDunya) est choisi côté admin ; le client voit juste
                          "Mobile Money". Le choix de l'opérateur + la saisie du
                          numéro se font sur la page/modal du fournisseur après
                          ce bouton. */}
                      <button
                        type="button"
                        onClick={() => setPaymentMethod('mobile_money')}
                        className={`w-full p-5 bg-white rounded-3xl border-2 transition-all flex items-center gap-4 ${paymentMethod === 'mobile_money' ? 'border-accent shadow-md' : 'border-slate-100 hover:border-accent/30'}`}
                      >
                        <div className="flex gap-1 shrink-0 flex-wrap max-w-[100px] justify-center">
                          <Image src="/logo/om.png" alt="OM" width={24} height={24} className="h-6 w-auto object-contain bg-white rounded-sm border border-border/20" />
                          <Image src="/logo/ma.png" alt="MA" width={24} height={24} className="h-6 w-auto object-contain bg-white rounded-sm border border-border/20" />
                          <Image src="/logo/mt.png" alt="MT" width={24} height={24} className="h-6 w-auto object-contain bg-white rounded-sm border border-border/20" />
                          <Image src="/logo/dj.png" alt="DJ" width={24} height={24} className="h-6 w-auto object-contain bg-white rounded-sm border border-border/20" />
                          <Image src="/logo/ya.png" alt="YA" width={24} height={24} className="h-6 w-auto object-contain bg-white rounded-sm border border-border/20" />
                          <Image src="/logo/we.png" alt="WE" width={24} height={24} className="h-6 w-auto object-contain bg-white rounded-sm border border-border/20" />
                        </div>
                        <div className="text-left flex-1">
                          <p className="font-black text-foreground text-xs uppercase tracking-tighter">Mobile Money</p>
                          <p className="text-[10px] text-muted-foreground mt-1 font-bold">Wave, Orange Money, MTN, Moov, M-Pesa, Airtel...</p>
                        </div>
                        {paymentMethod === 'mobile_money' && (
                          <div className="w-6 h-6 rounded-full bg-accent flex items-center justify-center text-white shrink-0">
                            <CheckCircle size={16} />
                          </div>
                        )}
                      </button>

                      {/* Conseil Maxit / Orange Money : l'appli doit rester ouverte en
                          arrière-plan pendant la validation du paiement, sinon
                          l'autorisation n'aboutit pas — pas nécessaire pour Wave et les
                          autres opérateurs (demandé le 2026-08-01). Le choix du sous-canal
                          se fait sur la page du fournisseur après ce bouton, donc le
                          conseil couvre les deux cas plutôt qu'un sélecteur conditionnel. */}
                      {paymentMethod === 'mobile_money' && (
                        <div className="flex items-start gap-2.5 px-4 py-3 bg-amber-50 border border-amber-200 rounded-2xl text-[11px] text-amber-800 font-bold leading-snug">
                          <AlertCircle size={15} className="shrink-0 mt-0.5 text-amber-600" />
                          <span>
                            Si vous utilisez <strong>Maxit</strong> ou <strong>Orange Money</strong>,
                            laissez l'application ouverte en arrière-plan pendant toute la
                            validation du paiement — sinon l'autorisation risque de ne pas
                            aboutir. (Pas nécessaire pour Wave et les autres.)
                          </span>
                        </div>
                      )}

                      {/* Mobile Money nécessite un numéro d'un opérateur africain
                          (Wave, Orange Money, MTN...) — un client dont le pays de
                          livraison est hors Afrique (COUNTRY_TO_ZONE) n'en a
                          généralement pas. Pas de masquage de l'option (demandé
                          le 2026-08-28 : garder le choix visible), juste un
                          avertissement clair pour éviter l'échec silencieux au
                          moment de saisir le numéro sur la page du fournisseur. */}
                      {paymentMethod === 'mobile_money' && COUNTRY_TO_ZONE[formData.country.toUpperCase()] !== 'AF' && (
                        <div className="flex items-start gap-2.5 px-4 py-3 bg-blue-50 border border-blue-200 rounded-2xl text-[11px] text-blue-800 font-bold leading-snug">
                          <AlertCircle size={15} className="shrink-0 mt-0.5 text-blue-600" />
                          <span>
                            Mobile Money nécessite un numéro de téléphone d'un opérateur
                            africain (Wave, Orange Money, MTN, Moov, M-Pesa, Airtel...).
                            Si vous n'en avez pas, choisissez <strong>Carte bancaire</strong> ci-dessous.
                          </span>
                        </div>
                      )}

                      {/* Option Stripe */}
                      <button
                        type="button"
                        onClick={() => setPaymentMethod('stripe')}
                        className={`w-full p-5 bg-white rounded-3xl border-2 transition-all flex items-center gap-4 ${paymentMethod === 'stripe' ? 'border-accent shadow-md' : 'border-slate-100 hover:border-accent/30'}`}
                      >
                        <div className="flex gap-2 shrink-0">
                          <div className="w-12 h-12 rounded-xl bg-white border border-border flex items-center justify-center p-2 shadow-sm">
                            <img src="/logo/ga.svg" alt="GA" className="w-full h-full object-contain" />
                          </div>
                          <div className="w-12 h-12 rounded-xl bg-white border border-border flex items-center justify-center p-2 shadow-sm">
                            <img src="/logo/limk.svg" alt="Limk" className="w-full h-full object-contain" />
                          </div>
                        </div>
                        <div className="text-left">
                          <p className="font-black text-foreground text-xs uppercase tracking-tighter">Carte Bancaire / Apple Pay</p>
                          <p className="text-[10px] text-muted-foreground mt-1 font-bold">Sécurisé via Stripe</p>
                        </div>
                        {paymentMethod === 'stripe' && (
                          <div className="w-6 h-6 rounded-full bg-accent flex items-center justify-center text-white shrink-0">
                            <CheckCircle size={16} />
                          </div>
                        )}
                      </button>

                      {paymentMethod === 'stripe' && authToken && (
                        <div className="pt-1">
                          <SavedCardPicker
                            token={authToken}
                            selected={selectedPaymentMethodId}
                            onSelect={setSelectedPaymentMethodId}
                            saveNewCard={saveNewCard}
                            onSaveNewCardChange={setSaveNewCard}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </>
              </m.div>
            </AnimatePresence>
          </div>

          {/* Summary */}
          <div>
            <div className="bg-card rounded-2xl border border-border p-6 sticky top-24 shadow-sm">
              <h2 className="text-lg font-black uppercase tracking-tighter text-foreground mb-6">{t.yourOrder || 'Votre Commande'}</h2>
              
              <div className="space-y-4 mb-6 max-h-75 overflow-y-auto pr-2 scrollbar-hide">
                {cart.map((item) => {
                  const pc     = item.product.countryCode || ''
                  const local  = isLocalDelivery(pc, userCountryCode)
                  const afNeighbor = !local && isSameZoneAfrica(pc, userCountryCode)
                  const shipCost = calcShipping(pc, userCountryCode, 'standard', shippingRatesConfig, COUNTRY_TO_ZONE)
                  return (
                    <div key={`${item.product.id}-${item.variation?.id || '0'}`} className="flex justify-between items-start gap-4 border-b border-border/50 pb-3 last:border-0">
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-foreground line-clamp-1">{item.product.name}</p>
                        <p className="text-[10px] text-muted-foreground font-medium">Qté: {item.quantity} · {item.product.vendor?.name || 'Boutique'}</p>
                        <p className={`text-[9px] font-bold mt-0.5 flex items-center gap-0.5 ${local ? 'text-emerald-600' : afNeighbor ? 'text-blue-600' : 'text-muted-foreground'}`}>
                          <span>{local ? '🚚 Locale' : afNeighbor ? '🌍 Zone Afrique' : '✈️ International'}</span>
                          <span>— {fp(shipCost * item.quantity)}</span>
                        </p>
                      </div>
                      <span className="font-bold text-xs text-foreground shrink-0">
                        {fp(Number(item.variation?.price || item.product.price || 0) * item.quantity)}
                      </span>
                    </div>
                  )
                })}
              </div>

              {/* ── Coupon field ── */}
              <div className="pt-3 border-t border-dashed border-border">
                <p className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5">
                  <Ticket size={13} className="text-red-500"/> Code de réduction
                </p>
                {appliedCoupon ? (
                  <div className="flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Check size={14} className="text-emerald-600"/>
                      <div>
                        <p className="text-xs font-black text-emerald-700">{appliedCoupon.code}</p>
                        <p className="text-[10px] text-emerald-600">{appliedCoupon.message}</p>
                      </div>
                    </div>
                    <button type="button" aria-label="Retirer le code promo" onClick={() => { setAppliedCoupon(null); setCouponInput('') }}
                      className="text-gray-400 hover:text-red-500 transition-colors">
                      <X size={14}/>
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      value={couponInput}
                      onChange={e => { setCouponInput(e.target.value.toUpperCase()); setCouponError('') }}
                      onKeyDown={e => e.key === 'Enter' && applyCoupon()}
                      placeholder="Ex: MIAD10"
                      className="flex-1 text-xs border border-border rounded-xl px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-accent/30 font-mono uppercase"
                    />
                    <button
                      type="button"
                      onClick={applyCoupon}
                      disabled={couponLoading || !couponInput.trim()}
                      className="bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white text-xs font-black px-3 py-2 rounded-xl transition-colors shrink-0 flex items-center gap-1"
                    >
                      {couponLoading ? <Loader2 size={12} className="animate-spin"/> : 'Appliquer'}
                    </button>
                  </div>
                )}
                {couponError && (
                  <p className="text-[11px] text-red-500 mt-1.5 flex items-center gap-1">
                    <X size={10}/> {couponError}
                  </p>
                )}
              </div>

              <div className="space-y-3 pt-4 border-t-2 border-dashed border-border">
                <div className="flex justify-between text-muted-foreground">
                  <span>{t.subtotal || 'Sous-total'}</span>
                  <span>{fp(Number(subtotal || 0))}</span>
                </div>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Truck size={14} /> {shippingMethod === 'express' ? 'MIAD Express' : 'MIAD Standard'}
                  </span>
                  <span className="flex items-center gap-2 font-medium">
                    {isLoadingShipping && <Loader2 size={12} className="animate-spin" />}
                    {fp(Number(shippingTotal || 0))}
                  </span>
                </div>
                {couponDiscount > 0 && (
                  <div className="flex justify-between text-emerald-600 font-medium">
                    <span className="flex items-center gap-1"><Ticket size={13}/> Réduction {appliedCoupon?.code}</span>
                    <span>-{fp(couponDiscount)}</span>
                  </div>
                )}
                <div className="flex justify-between items-center font-black text-foreground pt-3 border-t border-border">
                  <span className="uppercase text-xs tracking-widest">{t.totalToPay || 'Total'}</span>
                  <span className="text-2xl text-accent tracking-tighter">{fp(Number(total || 0))}</span>
                </div>
              </div>

              {/* On cache ce bouton si le formulaire Stripe est déjà affiché */}
              {!stripeClientSecret && (
                <Button
                  onClick={handleSubmit}
                  disabled={isProcessing}
                  className="w-full mt-6 py-6 bg-accent text-accent-foreground hover:bg-accent/90 font-bold"
                >
                  {isProcessing ? <Loader2 className="animate-spin" /> : (t.confirmAndPay || 'Confirmer et Payer')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
    </LazyMotion>
  )
}
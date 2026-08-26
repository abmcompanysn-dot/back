"use client"

import { useState, useMemo, useEffect, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useCurrency } from '@/contexts/CurrencyContext'
import useSWR from 'swr'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import {
  Package, Heart, MessageCircle, Tag, MapPin, User,
  ArrowLeft, ChevronRight, Clock, Truck, CheckCircle,
  Shield, LogOut, ShoppingBag, Settings, Bell, Zap, Languages,
  QrCode, Share2, Send, ImagePlus, Smile, CreditCard
} from 'lucide-react'
import { QRCodeImage } from './QRCodeImage'
import { PaymentMethodsSection } from './PaymentMethodsSection'
import { Button } from '@/components/ui/button'
import { ProductCard } from './ProductCard'
import { type WooProduct } from '@/lib/woocommerce'
import { fetchRecentlyViewedProducts, fetchRecommendedProducts } from '@/lib/recommendations'

interface ClientDashboardProps {
  onBack: () => void
  onLogout: () => void
  // Déclenché sur un 401 détecté pendant la navigation dans le dashboard —
  // délègue au flux centralisé (toast "session invalide" + redirection vers
  // la connexion) au lieu de renvoyer silencieusement sur l'accueil comme
  // onLogout() seul le fait (signalé le 2026-07-16). Obligatoire depuis le
  // 2026-07-30 : le repli local avait son propre message ("Votre session a
  // expiré...", différent de celui du flux centralisé) et rappelait
  // onLogout() directement — supprimé pour ne garder qu'un seul message/flux
  // partout sur le site.
  onSessionExpired: () => void
  language: 'fr' | 'en'
  onLanguageChange: (l: 'fr' | 'en') => void
  initialSection?: Section
}

const fetcher = async (url: string) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('miad_token') : null
  
  // Sécurité : évite d'envoyer "Bearer null" au serveur
  if (!token || token === 'null' || token === 'undefined') {
    console.error("[Auth] Token invalide ou manquant");
    throw new Error("Session expirée. Veuillez vous reconnecter.");
  }

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  const contentType = res.headers.get("content-type");
  if (!contentType || !contentType.includes("application/json")) {
    throw new Error(`Le serveur a renvoyé une réponse inattendue (${res.status}). Vérifiez la configuration du pare-feu.`);
  }

  const data = await res.json();

  if (!res.ok) {
    const error = new Error(data.message || 'Erreur lors de la récupération des données');
    (error as any).status = res.status;
    throw error;
  }

  return data;
}

type Section = 'overview' | 'orders' | 'wishlist' | 'activity' | 'messages' | 'coupons' | 'addresses' | 'payment-methods' | 'settings' | 'qrcode'
type OrderFilter = 'all' | 'pending' | 'processing' | 'shipped' | 'completed' | 'cancelled'

// Infos "prise en charge par le représentant" extraites des meta_data WooCommerce
const getRepInfo = (order: any) => {
  const meta = order?.meta_data || []
  const repName = meta.find((m: any) => m.key === '_miad_rep_acknowledged_by')?.value
  const repAt = meta.find((m: any) => m.key === '_miad_rep_acknowledged_at')?.value
  return repName ? { repName, repAt } : null
}

// Marque/4 derniers chiffres de la carte Stripe utilisée pour cette commande
// (posés en meta_data par miad_confirm_stripe_order côté WP) — absent pour
// les commandes PayDunya ou les commandes Stripe passées avant cette fonctionnalité.
const CARD_BRAND_LABELS: Record<string, string> = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex',
  discover: 'Discover', diners: 'Diners', jcb: 'JCB', unionpay: 'UnionPay',
}
const getOrderCardInfo = (order: any) => {
  const meta = order?.meta_data || []
  const brand = meta.find((m: any) => m.key === '_stripe_card_brand')?.value
  const last4 = meta.find((m: any) => m.key === '_stripe_card_last4')?.value
  if (!brand || !last4) return null
  return `${CARD_BRAND_LABELS[brand] || brand.toUpperCase()} •••• ${last4}`
}

// Messages système dérivés du statut de commande
const getSystemMessages = (order: any) => {
  const msgs: { text: string; time: string; fromMe: boolean }[] = []
  const fmt = (d: string) => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  msgs.push({ text: `Votre commande #${order.id} a bien été reçue. Merci pour votre achat sur MIAD Market !`, time: fmt(order.date_created), fromMe: false })
  if (['processing', 'completed'].includes(order.status))
    msgs.push({ text: `✅ Paiement confirmé. Nos équipes préparent votre colis avec soin.`, time: fmt(order.date_modified || order.date_created), fromMe: false })
  const stage = order.meta_data?.find((m: any) => m.key === '_miad_delivery_stage')?.value || ''
  if (stage === 'local_pickup')
    msgs.push({ text: `🚚 Votre colis a été pris en charge par le transporteur local.`, time: fmt(order.date_modified || order.date_created), fromMe: false })
  if (stage === 'intl_handoff')
    msgs.push({ text: `✈️ Colis remis au transporteur international. Suivi disponible sous 24h.`, time: fmt(order.date_modified || order.date_created), fromMe: false })
  if (stage === 'delivered' || order.status === 'completed')
    msgs.push({ text: `🎉 Commande livrée ! Nous espérons que vous êtes satisfait(e). N'hésitez pas à laisser un avis.`, time: fmt(order.date_modified || order.date_created), fromMe: false })
  return msgs
}

const getStatusLabel = (status: string) => {
  const labels: Record<string, { text: string, color: string }> = {
    'pending': { text: 'En attente', color: 'bg-orange-100 text-orange-700' },
    'processing': { text: 'À expédier', color: 'bg-blue-100 text-blue-700' },
    'on-hold': { text: 'Confirmé', color: 'bg-purple-100 text-purple-700' },
    'completed': { text: 'Terminé', color: 'bg-green-100 text-green-700' },
    'cancelled': { text: 'Annulé', color: 'bg-red-100 text-red-700' },
    'failed': { text: 'Échoué', color: 'bg-red-100 text-red-700' },
  }
  return labels[status] || { text: status, color: 'bg-muted text-muted-foreground' }
}

const NAV_ITEMS: { id: Section; label: string; icon: typeof Package }[] = [
  { id: 'overview', label: 'Aperçu', icon: User },
  { id: 'orders', label: 'Mes commandes', icon: Package },
  { id: 'wishlist', label: 'Liste de souhaits', icon: Heart },
  { id: 'activity', label: 'Mon activité', icon: Clock },
  { id: 'messages', label: 'Messages', icon: MessageCircle },
  { id: 'coupons', label: 'Coupons & Points', icon: Tag },
  { id: 'addresses', label: 'Mes adresses', icon: MapPin },
  { id: 'payment-methods', label: 'Moyens de paiement', icon: CreditCard },
  { id: 'settings', label: 'Paramètres', icon: Settings },
  { id: 'qrcode', label: 'Mon QR Code', icon: QrCode },
]

const ORDER_TABS: { id: OrderFilter; label: string }[] = [
  { id: 'all', label: 'Toutes' },
  { id: 'pending', label: 'À Payer' },
  { id: 'processing', label: 'À Expédier' },
  { id: 'shipped', label: 'Expédiés' },
  { id: 'completed', label: 'Terminé' },
  { id: 'cancelled', label: 'Annulés' },
]

// Barre de progression des étapes de livraison MIAD
const DELIVERY_STAGE_ORDER = ['vendor_confirmed', 'rep_received', 'local_pickup', 'intl_handoff', 'delivered']
const DELIVERY_STEPS = [
  { label: 'Payé',      short: '💳' },
  { label: 'Vendeur',   short: '✅' },
  { label: 'Collecte',  short: '📥' },
  { label: 'Locale',    short: '🚚' },
  { label: 'Intl.',     short: '✈️' },
  { label: 'Livré',     short: '🎉' },
]

function OrderDeliveryProgress({ order }: { order: any }) {
  const deliveryStage: string =
    order.meta_data?.find((m: any) => m.key === '_miad_delivery_stage')?.value || ''
  const wcStatus: string = order.status

  // Commandes non démarrées / annulées → pas de barre
  if (['cancelled', 'failed', 'pending', 'refunded'].includes(wcStatus)) return null

  let currentStep = 0
  if (wcStatus === 'completed') {
    currentStep = DELIVERY_STEPS.length - 1
  } else if (deliveryStage) {
    const idx = DELIVERY_STAGE_ORDER.indexOf(deliveryStage)
    currentStep = idx >= 0 ? idx + 1 : 0
  }

  const pct = currentStep === 0 ? 0 : Math.round((currentStep / (DELIVERY_STEPS.length - 1)) * 100)

  return (
    <div className="mt-3 pt-3 border-t border-border">
      <p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground mb-2">
        Suivi livraison
      </p>
      <div className="relative px-1">
        {/* Ligne de fond */}
        <div className="absolute left-4 right-4 top-3 h-0.5 bg-border rounded-full" />
        {/* Ligne de progression */}
        <div
          className="absolute left-4 top-3 h-0.5 bg-green-500 rounded-full transition-all duration-700"
          style={{ width: `calc(${pct}% - 2rem)` }}
        />
        {/* Étapes */}
        <div className="relative flex justify-between">
          {DELIVERY_STEPS.map((step, i) => {
            const done   = i <= currentStep
            const active = i === currentStep
            return (
              <div key={step.label} className="flex flex-col items-center gap-0.5">
                <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center text-[9px] font-black transition-all duration-300
                  ${done
                    ? 'bg-green-500 border-green-500 text-white'
                    : 'bg-white border-border text-muted-foreground/40'}
                  ${active ? 'scale-125 shadow-md shadow-green-200/60' : ''}
                `}>
                  {done ? '✓' : i + 1}
                </div>
                <span className={`text-[7px] font-bold leading-tight text-center max-w-10 truncate
                  ${done ? 'text-green-700' : 'text-muted-foreground/40'}`}>
                  {step.label}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function ClientDashboard({ onBack, onLogout, onSessionExpired, language, onLanguageChange, initialSection }: ClientDashboardProps) {
  // Récupération du profil complet (incluant adresses et stats) via l'API proxy
  // Cela garantit que toutes les sections (adresses, emails, etc.) sont à jour.
  const token = typeof window !== 'undefined' ? localStorage.getItem('miad_token') : null;
  // On vérifie que le token est une vraie valeur, pas juste la chaîne "null"
  const hasValidToken = token && token !== 'null' && token !== 'undefined';

  const { data: profileData, error: profileError, isLoading: isProfileLoading, mutate: mutateProfile } = useSWR(
    hasValidToken ? '/api/customer' : null,
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000,
      shouldRetryOnError: false
    }
  )

  // Récupération des commandes réelles
  const { data: ordersData, error: ordersError } = useSWR(
    hasValidToken ? '/api/orders' : null,
    fetcher
  )

  // Déconnexion uniquement si le serveur confirme explicitement un token invalide
  useEffect(() => {
    const isAuthError = (err: any) =>
      err?.status === 401 && (err?.message?.toLowerCase().includes('expir') || err?.message?.toLowerCase().includes('invalid') || err?.message?.toLowerCase().includes('session'));
    if (isAuthError(profileError) || isAuthError(ordersError)) {
      onSessionExpired();
    }
  }, [profileError, ordersError, onSessionExpired]);

  // On garde un fallback sur le localStorage pour l'affichage immédiat avant que l'API ne réponde
  const localUser = useMemo(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem('miad_user') : null
    return stored ? JSON.parse(stored) : null
  }, [])

  const userData = profileData?.data || localUser
  const isRepUser = typeof window !== 'undefined' && localStorage.getItem('miad_role') === 'representant'

  const { formatPrice: fp } = useCurrency()
  const [activeSection, setActiveSection] = useState<Section>(initialSection || 'overview')
  const [ordersFilter, setOrdersFilter] = useState<OrderFilter>('all')
  const [recentlyViewed, setRecentlyViewed] = useState<WooProduct[]>([])
  const [recommended, setRecommended] = useState<WooProduct[]>([])
  const [activityLoading, setActivityLoading] = useState(true)

  // Wishlist — même clé SWR que WishlistContext (le bouton cœur des
  // cartes produit), donc pas de second fetch réseau si déjà en cache.
  // Ne charge qu'à l'ouverture de l'onglet, pas au montage du dashboard.
  const { data: wishlistData, isLoading: wishlistLoading } = useSWR(
    hasValidToken && activeSection === 'wishlist' ? '/api/wishlist' : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 30000 }
  )
  const wishlistProducts: WooProduct[] = wishlistData?.products || []

  // Chargée à la demande (pas au montage) : localStorage + appels /api/products,
  // inutile de payer ce coût tant que l'utilisateur ne visite pas cet onglet.
  useEffect(() => {
    if (activeSection !== 'activity') return
    let cancelled = false
    setActivityLoading(true)
    Promise.all([fetchRecentlyViewedProducts(8), fetchRecommendedProducts([], 8)])
      .then(([viewed, recs]) => {
        if (cancelled) return
        setRecentlyViewed(viewed)
        setRecommended(recs)
      })
      .finally(() => { if (!cancelled) setActivityLoading(false) })
    return () => { cancelled = true }
  }, [activeSection])
  const [isEditingAddress, setIsEditingAddress] = useState<'billing' | 'shipping' | null>(null);
  const [addressForm, setAddressForm] = useState({
    first_name: '',
    last_name: '',
    address_1: '',
    city: '',
    state: '',
    postcode: '',
    country: 'SN',
    phone: ''
  });

  const handleStartEdit = (type: 'billing' | 'shipping') => {
    const addr = userData?.[type] || {};
    setAddressForm({
      first_name: addr.first_name || userData?.firstName || '',
      last_name: addr.last_name || userData?.lastName || '',
      address_1: addr.address_1 || '',
      city: addr.city || '',
      state: addr.state || '',
      postcode: addr.postcode || '',
      country: addr.country || 'SN',
      phone: addr.phone || userData?.phone || ''
    });
    setIsEditingAddress(type);
  };

  const isSavingAddressRef = useRef(false);

  const handleSaveAddress = async () => {
    if (!isEditingAddress) return;
    isSavingAddressRef.current = true;
    try {
      const token = localStorage.getItem('miad_token');
      const res = await fetch('/api/customer', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ type: isEditingAddress, address: addressForm }),
      });
      if (res.ok) {
        toast.success('Adresse mise à jour avec succès');
        setIsEditingAddress(null);
        // Sans ça, le GET /api/customer déjà en cache (revalidateOnFocus
        // désactivé) continuait d'afficher l'ancienne adresse jusqu'au
        // prochain rechargement complet de la page (corrigé le 2026-08-26,
        // en même temps que le mapping billing/shipping côté GET).
        mutateProfile();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Impossible de sauvegarder l\'adresse.');
      }
    } catch {
      toast.error('Erreur réseau. Vérifiez votre connexion.');
    } finally {
      isSavingAddressRef.current = false;
    }
  };
  // ── Modification de l'adresse de livraison d'une commande déjà passée ──────
  const SHIPPING_EDITABLE_STATUSES = ['pending', 'processing', 'on-hold', 'miad-rep-charge']
  const [editingOrderShipping, setEditingOrderShipping] = useState<number | null>(null)
  const [shippingForm, setShippingForm] = useState({
    first_name: '', last_name: '', address_1: '', address_2: '', city: '', state: '', postcode: '', country: 'SN', phone: ''
  })
  const [isSavingShipping, setIsSavingShipping] = useState(false)

  const startEditShipping = (order: any) => {
    const s = order.shipping?.address_1 ? order.shipping : order.billing
    setShippingForm({
      first_name: s?.first_name || '',
      last_name: s?.last_name || '',
      address_1: s?.address_1 || '',
      address_2: s?.address_2 || '',
      city: s?.city || '',
      state: s?.state || '',
      postcode: s?.postcode || '',
      country: s?.country || 'SN',
      phone: s?.phone || '',
    })
    setEditingOrderShipping(order.id)
  }

  const saveOrderShippingAddress = async () => {
    if (!editingOrderShipping) return
    setIsSavingShipping(true)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch(`/api/orders/${editingOrderShipping}/shipping-address`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ shipping: shippingForm }),
      })
      if (res.ok) {
        toast.success('Adresse de livraison mise à jour.')
        setEditingOrderShipping(null)
      } else {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error || 'Impossible de modifier cette adresse.')
      }
    } catch {
      toast.error('Erreur réseau. Vérifiez votre connexion.')
    } finally {
      setIsSavingShipping(false)
    }
  }

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // ── Messagerie ──────────────────────────────────────────────
  const [selectedConvId, setSelectedConvId]   = useState<number | null>(null)
  const [newMessage,     setNewMessage]        = useState('')
  const [isSending,      setIsSending]         = useState(false)
  const [localMessages,  setLocalMessages]     = useState<
    Record<number, { text: string; time: string; fromMe: boolean }[]>
  >({})

  const handleSendMessage = () => {
    if (!newMessage.trim() || !selectedConvId) return
    setIsSending(true)
    const msg = { text: newMessage.trim(), time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), fromMe: true }
    setLocalMessages(prev => ({ ...prev, [selectedConvId]: [...(prev[selectedConvId] || []), msg] }))
    setNewMessage('')
    // Simuler une réponse automatique après 1.5s
    setTimeout(() => {
      const auto = { text: `Merci pour votre message concernant la commande #${selectedConvId}. Notre équipe vous répondra dans les plus brefs délais.`, time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), fromMe: false }
      setLocalMessages(prev => ({ ...prev, [selectedConvId]: [...(prev[selectedConvId] || []), auto] }))
      setIsSending(false)
    }, 1500)
  }
  // ────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    if (profileData?.data?.orderStats) {
      const s = profileData.data.orderStats;
      return {
        total: s.totalOrders.toString(),
        pending: s.toPay.toString(),
        processing: s.toShip.toString(),
        shipped: s.shipped.toString(),
        delivered: s.completed.toString(),
      }
    }
    const orders = ordersData && Array.isArray(ordersData.orders) ? ordersData.orders : [];
    return {
      total: (orders.length || 0).toString(),
      pending: (orders as any[]).filter((o) => o?.status === 'pending' || o?.status === 'on-hold').length.toString(),
      processing: (orders as any[]).filter((o) => o?.status === 'processing').length.toString(),
      shipped: (orders as any[]).filter((o) => o?.status === 'shipped').length.toString(),
      delivered: (orders as any[]).filter((o) => o?.status === 'completed').length.toString(),
    }
  }, [ordersData, profileData])

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Header */}
      <header className="bg-primary text-primary-foreground sticky top-0 z-40 shadow-md">
        <div className="container mx-auto px-4">
          <div className="flex items-center h-16 gap-4">
            <button type="button" onClick={onBack} aria-label="Retour" className="p-2 hover:bg-white/10 rounded-lg transition-colors">
              <ArrowLeft size={20} />
            </button>
            <h1 className="font-black text-xl tracking-tighter uppercase italic">Mon Espace</h1>

            <div className="ml-auto flex items-center gap-2">
              <div className="relative group">
                <select
                  value={language}
                  onChange={(e) => onLanguageChange(e.target.value as 'fr' | 'en')}
                  aria-label="Langue"
                  className="bg-white/10 hover:bg-white/20 border-none rounded-full text-xs font-black uppercase py-1.5 pl-8 pr-4 appearance-none cursor-pointer focus:ring-2 focus:ring-accent/50 outline-none transition-all"
                >
                  <option value="fr" className="text-foreground">FR</option>
                  <option value="en" className="text-foreground">EN</option>
                </select>
                <Languages size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none opacity-80" />
              </div>
              <button type="button" aria-label="Notifications" className="p-2 hover:bg-white/10 rounded-lg">
                <Bell size={20} />
              </button>
              {/* Mobile nav toggle */}
              <button
                type="button"
                aria-label="Menu"
                className="lg:hidden p-2 hover:bg-white/10 rounded-lg"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              >
                <Settings size={20} />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Bannière représentant — apparaît si l'utilisateur a le rôle representant */}
      {isRepUser && (
        <div className="bg-primary/10 border-b border-primary/20 px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="text-lg">⭐</span>
            <p className="text-sm font-bold text-primary">Vous êtes Représentant MIAD</p>
          </div>
          <Link
            href="/espace-representant"
            className="shrink-0 bg-primary text-primary-foreground text-xs font-black px-4 py-1.5 rounded-full hover:bg-primary/90 transition-colors"
          >
            Accéder à mon espace →
          </Link>
        </div>
      )}

      <div className="container mx-auto px-4 py-6">
        <div className="flex flex-col lg:flex-row gap-6">

          {/* Sidebar */}
          <aside className={`lg:w-72 shrink-0 space-y-4 ${mobileMenuOpen ? 'block' : 'hidden lg:block'}`}>
            {/* User card */}
            <div className="bg-white rounded-3xl border border-border/50 p-6 shadow-sm">
              <div className="flex flex-col items-center text-center gap-3">
                <div className="w-20 h-20 rounded-full bg-linear-to-tr from-accent to-primary flex items-center justify-center shadow-inner relative">
                  <User size={40} className="text-white" />
                  <div className="absolute bottom-0 right-0 w-6 h-6 bg-green-500 border-4 border-white rounded-full"></div>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-black text-lg text-foreground truncate">
                    {userData?.first_name || userData?.display_name || localUser?.display_name || 'Utilisateur'}
                  </p>
                  <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
                    {userData?.email || localUser?.user_email || 'Membre MIAD'}
                  </p>
                  <div className="mt-4 flex justify-center gap-2">
                    <span className="px-3 py-1 bg-accent/10 text-accent rounded-full text-[10px] font-black uppercase">
                      {userData?.role === 'seller' ? 'Vendeur' : 'Acheteur'}
                    </span>
                    {userData?.dateCreated && (
                      <span className="px-3 py-1 bg-primary/10 text-primary rounded-full text-[10px] font-black uppercase tracking-tighter">
                        Depuis {new Date(userData.dateCreated).getFullYear()}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Nav links */}
            <nav className="bg-card rounded-xl border border-border overflow-hidden">
              {NAV_ITEMS.map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => { setActiveSection(item.id); setMobileMenuOpen(false) }}
                  className={`w-full flex items-center justify-between px-4 py-3.5 transition-colors ${
                    idx < NAV_ITEMS.length - 1 ? 'border-b border-border' : ''
                  } ${
                    activeSection === item.id
                      ? 'bg-accent/10 text-accent border-l-[3px] border-l-accent'
                      : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <item.icon size={17} />
                    <span className="text-sm font-medium">{item.label}</span>
                  </div>
                  <ChevronRight size={15} className="text-muted-foreground" />
                </button>
              ))}
              <button
                type="button"
                onClick={onLogout}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-destructive hover:bg-destructive/5 transition-colors"
              >
                <LogOut size={17} />
                <span className="text-sm font-medium">Déconnexion</span>
              </button>
            </nav>
          </aside>

          {/* Main content */}
          <main className="flex-1 min-w-0">

            {isProfileLoading && (
              <div className="bg-card rounded-xl border border-border p-12 flex flex-col items-center justify-center animate-pulse">
                <Clock className="text-muted-foreground animate-spin mb-4" />
                <p className="text-muted-foreground text-sm font-medium">Chargement de votre profil...</p>
              </div>
            )}

            {/* OVERVIEW */}
            {!isProfileLoading && activeSection === 'overview' && (
              <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-300">
                {/* Nouveau Header Bi-colore : Origines & Dynamique */}
                <div className="grid grid-cols-1 md:grid-cols-2 overflow-hidden rounded-[2.5rem] border border-border shadow-sm">
                  {/* Moitié Couleur : Les Origines */}
                  <div className="bg-primary p-8 text-primary-foreground flex flex-col justify-center">
                    <h2 className="text-3xl font-black tracking-tighter mb-2 uppercase">Mes Origines</h2>
                    <p className="text-sm opacity-80 mb-6 leading-relaxed">Vos pays favoris basés sur vos commandes récentes sur MIAD.</p>
                    <div className="flex gap-3">
                      {['sn', 'ci', 'gn', 'cm'].map(code => (
                        <div key={code} className="w-10 h-10 rounded-full border-2 border-white/20 overflow-hidden shadow-lg hover:scale-110 transition-transform cursor-pointer">
                          <img src={`https://flagcdn.com/w80/${code}.png`} className="w-full h-full object-cover" alt="" />
                        </div>
                      ))}
                      <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-[10px] font-black">+2</div>
                    </div>
                  </div>
                  
                  {/* Moitié Dynamique : Recommandations Pro */}
                  <div className="bg-white p-8 flex flex-col justify-center">
                    <div className="flex items-center gap-2 text-accent mb-2">
                      <Zap size={16} className="fill-current" />
                      <span className="text-[10px] font-black uppercase tracking-widest">Section Dynamique Pro</span>
                    </div>
                    <p className="text-xl font-black text-foreground mb-4 tracking-tight">Recommandé pour vous</p>
                    <div className="flex gap-4 items-center bg-muted/30 p-3 rounded-2xl border border-border/50">
                       <div className="relative w-16 h-16 rounded-xl bg-muted shrink-0 overflow-hidden border border-border">
                         <Image src="/logo/logo.png" fill className="object-contain p-2" alt="" />
                       </div>
                       <div className="min-w-0">
                         <p className="text-xs font-black text-foreground truncate uppercase">Arrivage : Mode Dakar</p>
                         <p className="text-[10px] text-muted-foreground">Sélectionné pour votre profil</p>
                         <button type="button" className="text-[10px] font-black text-accent mt-1.5 hover:underline flex items-center gap-1">
                           VOIR L'OFFRE <ChevronRight size={10} />
                         </button>
                       </div>
                    </div>
                  </div>
                </div>

                {/* Order quick stats */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[
                    { label: 'Commandes', value: stats.total, icon: Package, color: 'bg-blue-50 text-blue-600' },
                    { label: 'À Payer', value: stats.pending, icon: Clock, color: 'bg-orange-50 text-orange-600' },
                    { label: 'À Expédier', value: stats.processing, icon: Zap, color: 'bg-yellow-50 text-yellow-600' },
                    { label: 'Terminé', value: stats.delivered, icon: CheckCircle, color: 'bg-green-50 text-green-600' },
                  ].map(stat => (
                    <button
                      key={stat.label}
                      type="button"
                      onClick={() => setActiveSection('orders')}
                      className="bg-card rounded-xl border border-border p-5 text-left hover:shadow-md hover:border-accent/40 transition-all"
                    >
                      <div className={`w-10 h-10 rounded-lg ${stat.color} flex items-center justify-center mb-3 relative`}>
                        <stat.icon size={20} />
                        {parseInt(stat.value) > 0 && (
                          <span className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-destructive text-white text-[10px] font-black rounded-full flex items-center justify-center border-2 border-white">
                            {stat.value}
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] font-black uppercase text-muted-foreground tracking-tighter">{stat.label}</p>
                    </button>
                  ))}
                </div>

                {/* Dernières Commandes (AliExpress Style) */}
                <div className="bg-card rounded-3xl border border-border p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="font-black uppercase text-xs tracking-widest text-foreground">Commandes Récentes</h3>
                    <button type="button" onClick={() => setActiveSection('orders')} className="text-[10px] font-black text-accent hover:underline">VOIR TOUT</button>
                  </div>
                  
                  {userData?.recentOrders && userData.recentOrders.length > 0 ? (
                    <div className="space-y-4">
                      {userData.recentOrders.map((order: any) => {
                        const repInfo = getRepInfo(order)
                        return (
                        <div key={order.id} className="p-3 hover:bg-muted/30 rounded-2xl transition-colors border border-transparent hover:border-border">
                          <div className="flex items-center gap-4">
                            <div className="w-14 h-14 bg-muted rounded-xl flex items-center justify-center shrink-0 overflow-hidden border border-border/50">
                              <img src={order.line_items?.[0]?.image?.src || "/logo/logo.png"} className="w-full h-full object-cover" alt="" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-black truncate text-foreground uppercase tracking-tight">#{order.id} - {order.line_items?.[0]?.name}</p>
                              <p className="text-[10px] text-muted-foreground font-bold" suppressHydrationWarning>{new Date(order.date_created).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-sm font-black text-accent">{fp(Number(order.total))}</p>
                              <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded-full ${getStatusLabel(order.status).color}`}>
                                {getStatusLabel(order.status).text}
                              </span>
                            </div>
                          </div>
                          <OrderDeliveryProgress order={order} />
                          {repInfo && (
                            <div className="mt-2 flex items-center gap-1.5 text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-2.5 py-1.5">
                              <Shield size={11} className="shrink-0" />
                              <span>Pris en charge par <b>{repInfo.repName}</b></span>
                            </div>
                          )}
                        </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="text-center py-10 opacity-40">
                      <ShoppingBag className="mx-auto mb-2" size={32} />
                      <p className="text-xs font-bold">Aucune commande récente</p>
                    </div>
                  )}
                </div>

                {/* Promo banner */}
                <div className="bg-linear-to-r from-accent to-accent/80 rounded-xl p-6 flex items-center justify-between text-accent-foreground">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Zap size={16} className="fill-current" />
                      <span className="text-sm font-semibold opacity-90">Offre de bienvenue</span>
                    </div>
                    <p className="text-xl font-bold">10% sur votre 1ère commande</p>
                    <p className="text-sm opacity-80 mt-0.5">Code: MIAD10 — Valable 7 jours</p>
                  </div>
                  <div className="text-5xl opacity-20">🎉</div>
                </div>

                {/* Security */}
                <div className="bg-card rounded-xl border border-border p-6">
                  <div className="flex items-center gap-3 mb-4">
                    <Shield size={20} className="text-primary" />
                    <h3 className="font-semibold text-foreground">Sécurité du compte</h3>
                  </div>
                  <div className="space-y-0">
                    {[
                      { label: 'Email vérifié', done: true },
                      { label: 'Numéro de téléphone', done: false },
                      { label: 'Authentification 2 facteurs', done: false },
                    ].map((item, i) => (
                      <div
                        key={item.label}
                        className={`flex items-center justify-between py-3 ${i < 2 ? 'border-b border-border' : ''}`}
                      >
                        <span className="text-sm text-foreground">{item.label}</span>
                        {item.done ? (
                          <span className="text-xs text-green-600 flex items-center gap-1 font-medium">
                            <CheckCircle size={14} /> Configuré
                          </span>
                        ) : (
                          <Button variant="outline" size="sm" className="h-7 text-xs px-3">
                            Configurer
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ORDERS */}
            {activeSection === 'orders' && !isProfileLoading && (
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="p-6 border-b border-border">
                  <h2 className="font-bold text-foreground text-lg">Mes commandes</h2>
                </div>
                {/* Filter tabs */}
                <div className="flex overflow-x-auto scrollbar-hide border-b border-border">
                  {ORDER_TABS.map(tab => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setOrdersFilter(tab.id)}
                      className={`shrink-0 px-5 py-3.5 text-sm font-medium transition-colors border-b-2 ${
                        ordersFilter === tab.id
                          ? 'text-accent border-accent'
                          : 'text-muted-foreground border-transparent hover:text-foreground'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                
                {Array.isArray(ordersData?.orders) && ordersData.orders.length > 0 ? (
                  <div className="divide-y divide-border">
                    {ordersData.orders.reduce((acc: any[], order: any) => {
                      if (!order || (ordersFilter !== 'all' && order.status !== ordersFilter)) return acc
                      const repInfo = getRepInfo(order)
                      const canEditShipping = SHIPPING_EDITABLE_STATUSES.includes(order.status)
                      acc.push(
                        <div key={order.id} className="p-6 hover:bg-muted/10 transition-colors">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-4">
                              <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center shrink-0 overflow-hidden">
                                {order.line_items?.[0]?.image?.src
                                  ? <img src={order.line_items[0].image.src} alt="" className="w-full h-full object-cover" />
                                  : <Package size={20} className="text-muted-foreground" />
                                }
                              </div>
                              <div>
                                <p className="font-bold text-sm">Commande #{order.id}</p>
                                <p className="text-xs text-muted-foreground" suppressHydrationWarning>
                                  {new Date(order.date_created).toLocaleDateString('fr-FR')} · {order.line_items?.length ?? 0} article(s)
                                </p>
                                {getOrderCardInfo(order) && (
                                  <p className="text-[10px] text-muted-foreground font-bold mt-0.5">
                                    💳 {getOrderCardInfo(order)}
                                  </p>
                                )}
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="font-black text-accent">{fp(Number(order.total))}</p>
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${getStatusLabel(order.status).color}`}>
                                {getStatusLabel(order.status).text}
                              </span>
                            </div>
                          </div>
                          <OrderDeliveryProgress order={order} />

                          {repInfo && (
                            <div className="mt-3 flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
                              <Shield size={13} className="shrink-0" />
                              <span suppressHydrationWarning>
                                Prise en charge par <b>{repInfo.repName}</b>
                                {repInfo.repAt && ` le ${new Date(repInfo.repAt).toLocaleDateString('fr-FR')}`}
                              </span>
                            </div>
                          )}

                          {canEditShipping && (
                            <div className="mt-3">
                              {editingOrderShipping === order.id ? (
                                <div className="bg-muted/30 border border-border rounded-2xl p-4 space-y-3">
                                  <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Modifier l'adresse de livraison</p>
                                  <div className="grid grid-cols-2 gap-2">
                                    <Input placeholder="Prénom" value={shippingForm.first_name} onChange={e => setShippingForm({ ...shippingForm, first_name: e.target.value })} />
                                    <Input placeholder="Nom" value={shippingForm.last_name} onChange={e => setShippingForm({ ...shippingForm, last_name: e.target.value })} />
                                  </div>
                                  <Input placeholder="Adresse" value={shippingForm.address_1} onChange={e => setShippingForm({ ...shippingForm, address_1: e.target.value })} />
                                  <Input placeholder="Appartement, bureau (optionnel)" value={shippingForm.address_2} onChange={e => setShippingForm({ ...shippingForm, address_2: e.target.value })} />
                                  <div className="grid grid-cols-2 gap-2">
                                    <Input placeholder="Ville" value={shippingForm.city} onChange={e => setShippingForm({ ...shippingForm, city: e.target.value })} />
                                    <Input placeholder="Code postal" value={shippingForm.postcode} onChange={e => setShippingForm({ ...shippingForm, postcode: e.target.value })} />
                                  </div>
                                  <Input placeholder="Téléphone" value={shippingForm.phone} onChange={e => setShippingForm({ ...shippingForm, phone: e.target.value })} />
                                  <div className="flex gap-2 justify-end">
                                    <Button size="sm" variant="outline" onClick={() => setEditingOrderShipping(null)}>Annuler</Button>
                                    <Button size="sm" className="bg-accent" disabled={isSavingShipping} onClick={saveOrderShippingAddress}>
                                      {isSavingShipping ? 'Enregistrement…' : 'Enregistrer'}
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => startEditShipping(order)}
                                  className="text-xs font-bold text-accent hover:underline flex items-center gap-1"
                                >
                                  <MapPin size={12} /> Modifier l'adresse de livraison
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )
                      return acc
                    }, [])}
                  </div>
                ) : (
                  <div className="py-20 flex flex-col items-center text-center px-4">
                    <ShoppingBag size={56} className="text-muted-foreground/20 mb-4" />
                    <p className="font-semibold text-foreground mb-2">Aucune commande</p>
                    <p className="text-sm text-muted-foreground mb-6 max-w-xs">
                      Vos commandes apparaîtront ici après votre premier achat sur MIAD Market
                    </p>
                    <Button onClick={onBack} className="bg-accent text-accent-foreground hover:bg-accent/90">
                      Commencer mes achats
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* WISHLIST — construit le 2026-08-26 (jusqu'ici section
                purement décorative, jamais de vrai fetch). WishlistContext
                gère déjà le cache SWR de '/api/wishlist' pour le bouton
                cœur des cartes produit ; on relit la même clé ici plutôt
                que de refaire un second fetch redondant. */}
            {activeSection === 'wishlist' && !isProfileLoading && (
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="p-6 border-b border-border">
                  <h2 className="font-bold text-foreground text-lg">Ma liste de souhaits</h2>
                </div>
                {wishlistLoading ? (
                  <div className="py-20 text-center text-sm text-muted-foreground">Chargement…</div>
                ) : wishlistProducts.length > 0 ? (
                  <div className="p-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {wishlistProducts.map((p) => (
                      <ProductCard
                        key={p.id}
                        product={p}
                        onClick={(prod) => { window.location.href = `/product/${prod.slug || prod.id}` }}
                        onAddToCart={(prod) => { window.location.href = `/product/${prod.slug || prod.id}` }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="py-20 flex flex-col items-center text-center px-4">
                    <Heart size={56} className="text-muted-foreground/20 mb-4" />
                    <p className="font-semibold text-foreground mb-2">Aucun produit sauvegardé</p>
                    <p className="text-sm text-muted-foreground mb-6 max-w-xs">
                      Cliquez sur le cœur d'un produit pour le sauvegarder ici
                    </p>
                    <Button onClick={onBack} className="bg-accent text-accent-foreground hover:bg-accent/90">
                      Explorer les produits
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* MON ACTIVITÉ — produits vus récemment (localStorage) + recommandations
                (similarité sémantique Vectorize sur le dernier produit vu, avec repli
                catégorie+popularité — voir lib/recommendations.ts) */}
            {activeSection === 'activity' && !isProfileLoading && (
              <div className="space-y-8">
                <div className="bg-card rounded-xl border border-border overflow-hidden">
                  <div className="p-6 border-b border-border">
                    <h2 className="font-bold text-foreground text-lg">Produits vus récemment</h2>
                  </div>
                  {activityLoading ? (
                    <div className="py-20 text-center text-sm text-muted-foreground">Chargement…</div>
                  ) : recentlyViewed.length > 0 ? (
                    <div className="p-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                      {recentlyViewed.map((p) => (
                        <ProductCard
                          key={p.id}
                          product={p}
                          onClick={(prod) => { window.location.href = `/product/${prod.slug || prod.id}` }}
                          onAddToCart={(prod) => { window.location.href = `/product/${prod.slug || prod.id}` }}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="py-20 flex flex-col items-center text-center px-4">
                      <Clock size={56} className="text-muted-foreground/20 mb-4" />
                      <p className="font-semibold text-foreground mb-2">Aucun produit consulté pour l'instant</p>
                      <p className="text-sm text-muted-foreground mb-6 max-w-xs">
                        Les produits que vous regardez apparaîtront ici
                      </p>
                      <Button onClick={onBack} className="bg-accent text-accent-foreground hover:bg-accent/90">
                        Explorer les produits
                      </Button>
                    </div>
                  )}
                </div>

                {!activityLoading && recommended.length > 0 && (
                  <div className="bg-card rounded-xl border border-border overflow-hidden">
                    <div className="p-6 border-b border-border">
                      <h2 className="font-bold text-foreground text-lg">Recommandé pour vous</h2>
                    </div>
                    <div className="p-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                      {recommended.map((p) => (
                        <ProductCard
                          key={p.id}
                          product={p}
                          onClick={(prod) => { window.location.href = `/product/${prod.slug || prod.id}` }}
                          onAddToCart={(prod) => { window.location.href = `/product/${prod.slug || prod.id}` }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* MESSAGES — style AliExpress */}
            {activeSection === 'messages' && !isProfileLoading && (() => {
              const orders: any[] = Array.isArray(ordersData?.orders) ? ordersData.orders : []
              const conv = orders.find((o: any) => o.id === selectedConvId)
              const allMsgs = conv
                ? [...getSystemMessages(conv), ...(localMessages[conv.id] || [])]
                : []

              return (
                <div className="bg-card rounded-xl border border-border overflow-hidden flex"
                  style={{ height: 'calc(100dvh - 180px)', minHeight: 520 }}>

                  {/* ── Liste conversations ── */}
                  <div className={`flex flex-col border-r border-border ${selectedConvId ? 'hidden md:flex w-72 shrink-0' : 'flex w-full md:w-72 shrink-0'}`}>
                    <div className="p-4 border-b border-border">
                      <h2 className="font-black text-sm uppercase tracking-widest">Messages</h2>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{orders.length} conversation{orders.length !== 1 ? 's' : ''}</p>
                    </div>

                    <div className="overflow-y-auto flex-1">
                      {orders.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full px-6 text-center py-16">
                          <MessageCircle size={36} className="text-muted-foreground/20 mb-3" />
                          <p className="text-sm font-medium text-muted-foreground">Aucune conversation</p>
                          <p className="text-xs text-muted-foreground/60 mt-1">Passez une commande pour démarrer</p>
                        </div>
                      ) : (
                        orders.map((o: any) => {
                          const isActive = selectedConvId === o.id
                          const preview = getSystemMessages(o).at(-1)?.text.slice(0, 40) + '…' || ''
                          return (
                            <button
                              key={o.id}
                              type="button"
                              onClick={() => setSelectedConvId(o.id)}
                              className={`w-full flex items-center gap-3 px-4 py-3.5 border-b border-border/50 hover:bg-muted/40 transition-colors text-left
                                ${isActive ? 'bg-accent/8 border-l-[3px] border-l-accent' : ''}`}
                            >
                              <div className="w-10 h-10 rounded-full bg-muted shrink-0 overflow-hidden border border-border/50">
                                <img
                                  src={o.line_items?.[0]?.image?.src || '/logo/logo.png'}
                                  alt="" className="w-full h-full object-cover"
                                  onError={(e) => { (e.target as HTMLImageElement).src = '/logo/logo.png' }}
                                />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-1">
                                  <p className="text-xs font-black truncate">MIAD Market</p>
                                  <span className="text-[9px] text-muted-foreground shrink-0" suppressHydrationWarning>
                                    {new Date(o.date_created).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}
                                  </span>
                                </div>
                                <p className="text-[11px] text-muted-foreground truncate">#{o.id} — {preview}</p>
                              </div>
                            </button>
                          )
                        })
                      )}
                    </div>
                  </div>

                  {/* ── Zone chat ── */}
                  {selectedConvId && conv ? (
                    <div className="flex-1 flex flex-col min-w-0">
                      {/* Chat header */}
                      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-white/50">
                        <button type="button" aria-label="Retour" className="md:hidden p-1.5 rounded-lg hover:bg-muted" onClick={() => setSelectedConvId(null)}>
                          <ArrowLeft size={16} />
                        </button>
                        <div className="relative w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0">
                          <Image src="/logo/logo.png" alt="" fill className="object-contain p-1" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black">MIAD Market</p>
                          <p className="text-[10px] text-muted-foreground">Commande #{conv.id} · {conv.line_items?.[0]?.name}</p>
                        </div>
                        <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full shrink-0 ${{
                          'completed': 'bg-green-100 text-green-700',
                          'processing': 'bg-blue-100 text-blue-700',
                          'pending': 'bg-orange-100 text-orange-700',
                          'cancelled': 'bg-red-100 text-red-700',
                        }[conv.status as string] || 'bg-muted text-muted-foreground'}`}>
                          {conv.status}
                        </span>
                      </div>

                      {/* Messages */}
                      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
                        style={{ background: 'linear-gradient(180deg,#fafafa,#f4f4f4)' }}>
                        {/* Date badge */}
                        <div className="flex justify-center">
                          <span className="text-[9px] bg-white border border-border px-3 py-1 rounded-full text-muted-foreground font-bold shadow-sm">
                            Commande du {new Date(conv.date_created).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}
                          </span>
                        </div>

                        {allMsgs.map((msg, i) => (
                          <div key={i} className={`flex ${msg.fromMe ? 'justify-end' : 'justify-start'} gap-2`}>
                            {!msg.fromMe && (
                              <div className="relative w-7 h-7 rounded-full bg-primary flex items-center justify-center shrink-0 self-end">
                                <Image src="/logo/logo.png" alt="" fill className="object-contain p-0.5" />
                              </div>
                            )}
                            <div className={`max-w-[72%] flex flex-col gap-0.5 ${msg.fromMe ? 'items-end' : 'items-start'}`}>
                              <div className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed shadow-sm
                                ${msg.fromMe
                                  ? 'bg-accent text-white rounded-br-sm'
                                  : 'bg-white text-foreground rounded-bl-sm border border-border/50'}`}>
                                {msg.text}
                              </div>
                              <span className="text-[9px] text-muted-foreground/60 px-1">{msg.time}</span>
                            </div>
                          </div>
                        ))}

                        {isSending && (
                          <div className="flex justify-start gap-2">
                            <div className="relative w-7 h-7 rounded-full bg-primary flex items-center justify-center shrink-0 self-end">
                              <Image src="/logo/logo.png" alt="" fill className="object-contain p-0.5" />
                            </div>
                            <div className="bg-white border border-border/50 px-4 py-2.5 rounded-2xl rounded-bl-sm shadow-sm">
                              <div className="flex gap-1 items-center h-4">
                                <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                                <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                                <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '300ms' }} />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Input */}
                      <div className="p-3 border-t border-border bg-white">
                        <div className="flex items-center gap-2 bg-muted/50 rounded-2xl px-4 py-2.5 border border-border/50">
                          <button type="button" aria-label="Emoji" className="text-muted-foreground hover:text-foreground transition-colors shrink-0">
                            <Smile size={18} />
                          </button>
                          <input
                            type="text"
                            placeholder="Écrire un message…"
                            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 min-w-0"
                            value={newMessage}
                            onChange={e => setNewMessage(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage() } }}
                          />
                          <button type="button" aria-label="Joindre une image" className="text-muted-foreground hover:text-foreground transition-colors shrink-0">
                            <ImagePlus size={18} />
                          </button>
                          <button
                            type="button"
                            onClick={handleSendMessage}
                            disabled={!newMessage.trim() || isSending}
                            aria-label="Envoyer"
                            className="w-8 h-8 rounded-full flex items-center justify-center transition-all shrink-0
                              bg-accent text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-accent/90 active:scale-95"
                          >
                            <Send size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* Aucune conversation sélectionnée (desktop) */
                    <div className="flex-1 hidden md:flex flex-col items-center justify-center gap-3 text-center px-8">
                      <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
                        <MessageCircle size={28} className="text-muted-foreground/30" />
                      </div>
                      <p className="font-bold text-foreground">Sélectionnez une conversation</p>
                      <p className="text-sm text-muted-foreground max-w-xs">
                        Choisissez une commande à gauche pour voir l'historique de vos échanges avec MIAD Market
                      </p>
                    </div>
                  )}
                </div>
              )
            })()}

            {/* COUPONS */}
            {activeSection === 'coupons' && !isProfileLoading && (
              <div className="space-y-4">
                {/* Points card */}
                <div className="bg-linear-to-r from-primary to-primary/80 rounded-xl p-6 text-primary-foreground">
                  <p className="text-sm opacity-80">Vos points MIAD</p>
                  <p className="text-5xl font-bold mt-2">0</p>
                  <p className="text-sm opacity-70 mt-1">points disponibles</p>
                  <div className="mt-4 p-3 bg-white/10 rounded-lg text-xs">
                    Gagnez 1 point pour chaque dollar dépensé. 100 points = $1 de réduction.
                  </div>
                </div>

                <div className="bg-card rounded-xl border border-border overflow-hidden">
                  <div className="p-6 border-b border-border flex items-center justify-between">
                    <h2 className="font-bold text-foreground text-lg">Mes coupons</h2>
                  </div>
                  {/* Welcome coupon */}
                  <div className="p-6">
                    <div className="border-2 border-dashed border-accent/50 rounded-xl p-5 flex items-center justify-between bg-accent/5">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <Tag size={16} className="text-accent" />
                          <span className="font-bold text-foreground text-lg">MIAD10</span>
                        </div>
                        <p className="text-sm text-muted-foreground">10% de réduction sur votre 1ère commande</p>
                        <p className="text-xs text-muted-foreground mt-1">Expire dans 7 jours</p>
                      </div>
                      <Button size="sm" variant="outline" className="border-accent text-accent hover:bg-accent hover:text-accent-foreground">
                        Utiliser
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ADDRESSES */}
            {activeSection === 'addresses' && !isProfileLoading && (
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="p-6 border-b border-border">
                  <h2 className="font-bold text-foreground text-lg">Mes adresses</h2>
                  {/* Bouton "+ Ajouter une adresse" retiré (2026-08-26) — sans
                      onClick, il ne faisait rien. Seuls billing/shipping
                      existent comme emplacements (pas une liste extensible),
                      chacun a déjà son propre bouton Ajouter/Modifier ci-dessous. */}
                </div>
                <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Adresse de Facturation */}
                  <div className="bg-white rounded-2xl border border-border p-5 shadow-sm flex flex-col justify-between">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <MapPin size={20} className="text-primary" />
                      </div>
                      <div>
                        <h3 className="font-bold text-foreground text-base">Adresse de Facturation</h3>
                        <p className="text-xs text-muted-foreground">Votre adresse pour les factures</p>
                      </div>
                    </div>
                    {isEditingAddress === 'billing' ? (
                      <div className="space-y-3 animate-in fade-in zoom-in-95 duration-200">
                        <div className="grid grid-cols-2 gap-2">
                          <Input placeholder="Prénom" value={addressForm.first_name} onChange={e => setAddressForm({...addressForm, first_name: e.target.value})} />
                          <Input placeholder="Nom" value={addressForm.last_name} onChange={e => setAddressForm({...addressForm, last_name: e.target.value})} />
                        </div>
                        <Input placeholder="Adresse" value={addressForm.address_1} onChange={e => setAddressForm({...addressForm, address_1: e.target.value})} />
                        <div className="grid grid-cols-2 gap-2">
                          <Input placeholder="Ville" value={addressForm.city} onChange={e => setAddressForm({...addressForm, city: e.target.value})} />
                          <Input placeholder="Province/Région" value={addressForm.state} onChange={e => setAddressForm({...addressForm, state: e.target.value})} />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <Input placeholder="Code Postal" value={addressForm.postcode} onChange={e => setAddressForm({...addressForm, postcode: e.target.value})} />
                          <Input placeholder="Téléphone" value={addressForm.phone} onChange={e => setAddressForm({...addressForm, phone: e.target.value})} />
                        </div>
                        <div className="flex gap-2 pt-2">
                          <Button size="sm" className="bg-accent" onClick={handleSaveAddress}>Enregistrer</Button>
                          <Button size="sm" variant="ghost" onClick={() => setIsEditingAddress(null)}>Annuler</Button>
                        </div>
                      </div>
                    ) : userData?.billing?.address_1 ? (
                      <div className="text-sm space-y-1 text-muted-foreground">
                        <p className="font-bold">{userData.billing.first_name} {userData.billing.last_name}</p>
                        <p>{userData.billing.address_1}</p>
                        <p>{userData.billing.city}, {userData.billing.state || ''} {userData.billing.postcode}</p>
                        <p>{userData.billing.country}</p>
                        <p className="font-bold text-accent pt-2">{userData.billing.phone}</p>
                        <Button variant="outline" size="sm" className="mt-4 w-full" onClick={() => handleStartEdit('billing')}>Modifier</Button>
                      </div>
                    ) : (
                      <div className="text-center py-8">
                        <p className="text-sm text-muted-foreground mb-4">Aucune adresse de facturation renseignée.</p>
                        <Button variant="outline" size="sm" onClick={() => handleStartEdit('billing')}>Ajouter une adresse</Button>
                      </div>
                    )}
                  </div>

                  {/* Adresse de Livraison */}
                  <div className="bg-white rounded-2xl border border-border p-5 shadow-sm flex flex-col justify-between">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
                        <Truck size={20} className="text-accent" />
                      </div>
                      <div>
                        <h3 className="font-bold text-foreground text-base">Adresse de Livraison</h3>
                        <p className="text-xs text-muted-foreground">Où vos commandes seront livrées</p>
                      </div>
                    </div>
                    {isEditingAddress === 'shipping' ? (
                      <div className="space-y-3 animate-in fade-in zoom-in-95 duration-200">
                        <div className="grid grid-cols-2 gap-2">
                          <Input placeholder="Prénom" value={addressForm.first_name} onChange={e => setAddressForm({...addressForm, first_name: e.target.value})} />
                          <Input placeholder="Nom" value={addressForm.last_name} onChange={e => setAddressForm({...addressForm, last_name: e.target.value})} />
                        </div>
                        <Input placeholder="Adresse" value={addressForm.address_1} onChange={e => setAddressForm({...addressForm, address_1: e.target.value})} />
                        <div className="grid grid-cols-2 gap-2">
                          <Input placeholder="Ville" value={addressForm.city} onChange={e => setAddressForm({...addressForm, city: e.target.value})} />
                          <Input placeholder="Province/Région" value={addressForm.state} onChange={e => setAddressForm({...addressForm, state: e.target.value})} />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <Input placeholder="Code Postal" value={addressForm.postcode} onChange={e => setAddressForm({...addressForm, postcode: e.target.value})} />
                          <Input placeholder="Téléphone" value={addressForm.phone} onChange={e => setAddressForm({...addressForm, phone: e.target.value})} />
                        </div>
                        <div className="flex gap-2 pt-2">
                          <Button size="sm" className="bg-accent" onClick={handleSaveAddress}>Enregistrer</Button>
                          <Button size="sm" variant="ghost" onClick={() => setIsEditingAddress(null)}>Annuler</Button>
                        </div>
                      </div>
                    ) : userData?.shipping?.address_1 ? (
                      <div className="text-sm space-y-1 text-muted-foreground">
                        <p className="font-bold">{userData.shipping.first_name} {userData.shipping.last_name}</p>
                        <p>{userData.shipping.address_1}</p>
                        <p>{userData.shipping.city}, {userData.shipping.state || ''} {userData.shipping.postcode}</p>
                        <p>{userData.shipping.country}</p>
                        {/* Assuming shipping also has a phone number, if not, it will fallback to billing phone or be empty */}
                        <p className="font-bold text-accent pt-2">{userData.shipping.phone || userData.billing?.phone}</p>
                        <Button variant="outline" size="sm" className="mt-4 w-full" onClick={() => handleStartEdit('shipping')}>Modifier</Button>
                      </div>
                    ) : (
                      <div className="text-center py-8">
                        <p className="text-sm text-muted-foreground mb-4">Aucune adresse de livraison renseignée.</p>
                        <Button variant="outline" size="sm" onClick={() => handleStartEdit('shipping')}>Ajouter une adresse</Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* MOYENS DE PAIEMENT */}
            {activeSection === 'payment-methods' && !isProfileLoading && (
              <PaymentMethodsSection token={token} />
            )}

            {/* SETTINGS */}
            {activeSection === 'settings' && !isProfileLoading && (
              <div className="space-y-5">
                {/* Personal info */}
                <div className="bg-card rounded-xl border border-border overflow-hidden">
                  <div className="p-6 border-b border-border">
                    <h2 className="font-bold text-foreground text-lg">Informations personnelles</h2>
                  </div>
                  <div className="p-6 space-y-4">
                    {[
                    { label: 'Prénom', value: userData?.first_name || userData?.name?.split(' ')[0] || '', type: 'text' },
                    { label: 'Nom', value: userData?.last_name || userData?.name?.split(' ').slice(1).join(' ') || '', type: 'text' },
                    { label: 'Email', value: userData?.email || '', type: 'email' },
                    { label: 'Téléphone', value: userData?.billing?.phone || userData?.phone || '', type: 'tel' },
                    ].map(field => {
                      const fieldId = `personal-info-${field.label.replace(/\s+/g, '-')}`
                      return (
                      <div key={field.label}>
                        <label htmlFor={fieldId} className="text-sm font-medium text-foreground block mb-1.5">
                          {field.label}
                        </label>
                        <input
                          id={fieldId}
                          type={field.type}
                        defaultValue={field.value}
                          className="w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40 transition-shadow"
                        />
                      </div>
                      )
                    })}
                    <Button className="bg-accent text-accent-foreground hover:bg-accent/90 mt-2">
                      Sauvegarder les modifications
                    </Button>
                  </div>
                </div>

                {/* Password */}
                <div className="bg-card rounded-xl border border-border overflow-hidden">
                  <div className="p-6 border-b border-border">
                    <h2 className="font-bold text-foreground text-lg">Mot de passe</h2>
                  </div>
                  <div className="p-6 space-y-4">
                    {[
                      { label: 'Mot de passe actuel', placeholder: '••••••••' },
                      { label: 'Nouveau mot de passe', placeholder: '••••••••' },
                      { label: 'Confirmer le nouveau mot de passe', placeholder: '••••••••' },
                    ].map(field => {
                      const fieldId = `password-${field.label.replace(/\s+/g, '-')}`
                      return (
                      <div key={field.label}>
                        <label htmlFor={fieldId} className="text-sm font-medium text-foreground block mb-1.5">
                          {field.label}
                        </label>
                        <input
                          id={fieldId}
                          type="password"
                          placeholder={field.placeholder}
                          className="w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40"
                        />
                      </div>
                      )
                    })}
                    <Button variant="outline" className="mt-2">
                      Changer le mot de passe
                    </Button>
                  </div>
                </div>

                {/* Notifications */}
                <div className="bg-card rounded-xl border border-border overflow-hidden">
                  <div className="p-6 border-b border-border">
                    <h2 className="font-bold text-foreground text-lg">Notifications</h2>
                  </div>
                  <div className="p-6 space-y-0">
                    {[
                      { label: 'Mises à jour des commandes', enabled: true },
                      { label: 'Nouvelles promotions', enabled: true },
                      { label: 'Messages des vendeurs', enabled: true },
                      { label: 'Newsletter MIAD Market', enabled: false },
                    ].map((item, i, arr) => (
                      <div
                        key={item.label}
                        className={`flex items-center justify-between py-3.5 ${i < arr.length - 1 ? 'border-b border-border' : ''}`}
                      >
                        <span className="text-sm text-foreground">{item.label}</span>
                        <div
                          className={`w-11 h-6 rounded-full flex items-center px-0.5 transition-colors ${
                            item.enabled ? 'bg-accent justify-end' : 'bg-muted justify-start'
                          }`}
                        >
                          <div className="w-5 h-5 bg-white rounded-full shadow-sm" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Danger zone */}
                <div className="bg-card rounded-xl border border-destructive/30 overflow-hidden">
                  <div className="p-6 border-b border-border">
                    <h2 className="font-bold text-foreground text-lg">Zone dangereuse</h2>
                  </div>
                  <div className="p-6">
                    <p className="text-sm text-muted-foreground mb-4">
                      La suppression de votre compte est irréversible. Toutes vos données seront définitivement effacées.
                    </p>
                    <Button variant="outline" className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground">
                      Supprimer mon compte
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {activeSection === 'qrcode' && !isProfileLoading && (
              <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="max-w-sm mx-auto">
                  <div className="bg-white rounded-[2.5rem] border border-border p-10 text-center shadow-sm">
                    <div className="w-16 h-16 bg-accent/10 text-accent rounded-2xl flex items-center justify-center mx-auto mb-6">
                      <QrCode size={28} />
                    </div>
                    <h3 className="text-xl font-black uppercase tracking-tight mb-2 italic">Mon QR Code</h3>
                    <p className="text-xs text-muted-foreground mb-8 font-medium">
                      Partagez ce code pour accéder directement à votre profil MIAD Market.
                    </p>
                    {(() => {
                      const profileUrl = `https://www.miadmarket.com`
                      const email = userData?.email || ''
                      const displayName = userData?.display_name || userData?.name || 'Compte'
                      const handleShare = async () => {
                        if (navigator.share) {
                          await navigator.share({ title: `Profil MIAD Market — ${displayName}`, url: profileUrl })
                        } else {
                          await navigator.clipboard.writeText(profileUrl)
                        }
                      }
                      const handleDownload = () => {
                        import('qrcode').then(QRCode => {
                          QRCode.toDataURL(profileUrl, { width: 512, margin: 2, color: { dark: '#0f172a', light: '#ffffff' }, errorCorrectionLevel: 'H' })
                            .then(dataUrl => {
                              const a = document.createElement('a')
                              a.href = dataUrl
                              a.download = `qr-miad-${displayName.replace(/\s+/g, '-')}.png`
                              a.click()
                            })
                        })
                      }
                      return (
                        <>
                          <div className="w-52 h-52 mx-auto rounded-3xl overflow-hidden border-4 border-slate-100 shadow-inner mb-6 flex items-center justify-center bg-white">
                            <QRCodeImage url={profileUrl} size={192} />
                          </div>
                          {email && <p className="text-[10px] font-bold text-muted-foreground truncate mb-8">{email}</p>}
                          <div className="flex gap-2">
                            <Button onClick={handleShare} className="flex-1 bg-accent text-white font-black uppercase text-[10px] tracking-widest h-12 rounded-xl gap-2">
                              <Share2 size={14} /> Partager
                            </Button>
                            <Button onClick={handleDownload} variant="outline" className="flex-1 border-slate-900 text-slate-900 font-black uppercase text-[10px] tracking-widest h-12 rounded-xl">
                              Télécharger
                            </Button>
                          </div>
                        </>
                      )
                    })()}
                  </div>
                </div>
              </div>
            )}

          </main>
        </div>
      </div>
    </div>
  )
}

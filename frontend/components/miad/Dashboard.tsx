"use client"

import React, { useState, useRef, useEffect } from 'react'
import { useCurrency } from '@/contexts/CurrencyContext'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  LayoutDashboard, Package, ShoppingCart, Settings,
  TrendingUp, ArrowLeft, Plus, Edit, Trash2,
  Star, Store, ExternalLink, AlertCircle,
  DollarSign, BarChart2, Save, Loader2, Image as ImageIcon,
  QrCode, Share2, Upload, Camera, CheckCircle, LogOut, ChevronDown, ChevronRight, RefreshCcw
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { type WooProduct } from '@/lib/woocommerce'
import { QRCodeImage } from './QRCodeImage'
import { LazyImage } from './LazyImage'
import { VendorShippingAddressForm } from './VendorShippingAddressForm'
import { PriceInputWithCurrency } from './PriceInputWithCurrency'

type DashboardProps = {
  onBack: () => void
  onLogout: () => void
  // Déclenché sur un 401 détecté pendant la navigation dans le dashboard
  // vendeur — jusqu'ici authFetcher ignorait le statut HTTP et ne
  // détectait jamais une session expirée (signalé le 2026-07-16).
  // Obligatoire depuis le 2026-07-30 : le repli local (onLogout() seul)
  // renvoyait silencieusement à l'accueil sans le toast "session invalide"
  // ni la redirection vers la connexion — supprimé pour ne garder qu'un seul
  // flux partout sur le site.
  onSessionExpired: () => void
  storeName?: string
  vendorId?: string
  vendorSlug?: string
  initialSection?: Tab
}

type Tab = 'overview' | 'products' | 'orders' | 'reviews' | 'vitrine' | 'analytics' | 'settings'

const tabs: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview',  label: 'Aperçu',       icon: LayoutDashboard },
  { id: 'products',  label: 'Produits',      icon: Package },
  { id: 'orders',    label: 'Commandes',     icon: ShoppingCart },
  { id: 'reviews',   label: 'Avis Clients',  icon: Star },
  { id: 'vitrine',   label: 'Vitrine / QR',  icon: QrCode },
  { id: 'analytics', label: 'Analytiques',   icon: BarChart2 },
  { id: 'settings',  label: 'Paramètres',    icon: Settings },
]

const ORDER_STATUSES: { id: string; label: string; color: string; dot: string }[] = [
  { id: 'all',         label: 'Toutes',       color: 'bg-slate-50 text-slate-600',   dot: 'bg-slate-400' },
  { id: 'pending',     label: 'En attente',   color: 'bg-yellow-50 text-yellow-700', dot: 'bg-yellow-400' },
  { id: 'processing',  label: 'En cours',     color: 'bg-blue-50 text-blue-700',     dot: 'bg-blue-400' },
  { id: 'completed',   label: 'Livrées',      color: 'bg-green-50 text-green-700',   dot: 'bg-green-500' },
  { id: 'cancelled',   label: 'Annulées',     color: 'bg-red-50 text-red-700',       dot: 'bg-red-400' },
]

function statusLabel(s: string) {
  return ORDER_STATUSES.find(x => x.id === s) || ORDER_STATUSES[0]
}

const authFetcher = (url: string) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('miad_token') : null
  return fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }).then(async r => {
    if (!r.ok) {
      const err: any = new Error('Erreur API vendeur')
      err.status = r.status
      throw err
    }
    return r.json()
  })
}

export function Dashboard({ onBack, onLogout, onSessionExpired, storeName = 'Ma Boutique', vendorId, vendorSlug, initialSection }: DashboardProps) {
  const { formatPrice: fp } = useCurrency()
  const [activeTab, setActiveTab]     = useState<Tab>(initialSection || 'overview')
  const [isAddingProduct, setIsAddingProduct] = useState(false)
  const [editingProductId, setEditingProductId] = useState<number | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [orderFilter, setOrderFilter] = useState('all')
  const [expandedOrder, setExpandedOrder] = useState<number | null>(null)
  const [updatingOrderId, setUpdatingOrderId] = useState<number | null>(null)

  // ── DATA — endpoint unique /api/vendor/dashboard ──────────────────────────
  const { data: dashData, error: dashError, isLoading: meLoading, mutate: mutateDash } = useSWR(
    '/api/vendor/dashboard', authFetcher, { revalidateOnFocus: false, dedupingInterval: 30000, shouldRetryOnError: false }
  )

  // Commandes filtrées par statut (re-fetch quand le filtre change)
  const ordersKey = `/api/vendor/orders?status=${orderFilter === 'all' ? 'any' : orderFilter}&per_page=50`
  const { data: ordersData, error: ordersError, isLoading: ordersLoading, mutate: mutateOrders } = useSWR(
    ordersKey, authFetcher, { revalidateOnFocus: false, dedupingInterval: 30000, shouldRetryOnError: false }
  )

  // Catalogue du vendeur — /api/vendor/dashboard ne renvoie JAMAIS de champ
  // "products" (seulement des compteurs), contrairement à ce que ce fichier
  // supposait jusqu'ici : l'onglet "Mon Catalogue" affichait donc toujours
  // "Aucun produit publié", quel que soit le nombre réel de produits du
  // vendeur (bug trouvé en audit le 2026-08-26). /api/vendor/products
  // existe déjà et fonctionne, juste jamais appelé depuis ce composant.
  const { data: productsData, error: productsError, isLoading: productsFetchLoading, mutate: mutateProductsList } = useSWR(
    '/api/vendor/products?per_page=100', authFetcher, { revalidateOnFocus: false, dedupingInterval: 30000, shouldRetryOnError: false }
  )

  // Profil boutique (nom/contact/logo/bannière) — même bug de champ
  // fantôme que products : dashData.seller n'a jamais existé côté
  // vendor-svc, donc ni l'aperçu photo ni le formulaire Paramètres
  // n'affichaient jamais l'état réel. GET /api/vendor/settings ajouté
  // le 2026-08-26 (voir app/api/vendor/settings/route.ts).
  const { data: profileData, mutate: mutateProfile } = useSWR(
    '/api/vendor/settings', authFetcher, { revalidateOnFocus: false, dedupingInterval: 30000, shouldRetryOnError: false }
  )

  // Déconnexion uniquement si le serveur confirme explicitement un token
  // invalide (même pattern que ClientDashboard.tsx) — authFetcher ignorait
  // jusqu'ici le statut HTTP, donc une session expirée ne redirigeait
  // jamais vers la connexion depuis le dashboard vendeur (2026-07-16).
  useEffect(() => {
    const isAuthError = (err: any) => err?.status === 401
    if (isAuthError(dashError) || isAuthError(ordersError)) {
      onSessionExpired()
    }
  }, [dashError, ordersError, onSessionExpired])

  const { data: categoriesData } = useSWR(
    '/api/categories', authFetcher, { revalidateOnFocus: false, dedupingInterval: 300000 }
  )

  // Solde + demandes de retrait — le vendeur "réclame son argent" lui-même
  // (demandé le 2026-08-26), l'admin approuve/rejette ensuite depuis
  // Finances > Payouts. mutate() après une demande pour refléter le nouveau
  // statut "en attente" immédiatement.
  const { data: walletData, mutate: mutateWallet } = useSWR(
    '/api/vendor/wallet', authFetcher, { revalidateOnFocus: false, dedupingInterval: 15000 }
  )

  // Aliases pratiques depuis dashData — GET /vendor/{id}/dashboard
  // (vendor-svc) ne renvoie QUE vendor_id, products_total, orders_total,
  // revenue_usd, orders_by_status (vérifié dans services/vendor-svc/main.go
  // vendorDashboard, 2026-08-26) : tous les autres champs lus ici avant ce
  // correctif (userId, seller.*, revenue, products, products_published,
  // orders_pending, orders_completed, recentOrders) n'ont jamais existé
  // côté backend — toujours undefined, silencieusement.
  const effectiveVendorId   = vendorId || dashData?.vendor_id
  const effectiveVendorSlug = vendorSlug
  const publishedProducts: WooProduct[] = productsData?.products || []
  const orders: any[]        = ordersData?.orders || []
  const siteCategories: { id: string; name: string; slug: string; parent: string; isRoot: boolean }[] = categoriesData?.categories || []

  const statsLoading   = meLoading
  const productsLoading = productsFetchLoading
  const mutateStats    = mutateDash
  const mutateProducts = mutateProductsList

  // ── STATS ─────────────────────────────────────────────────────────────────
  // revenue_usd (vendor-svc, agrégé depuis order-svc) est la source de
  // vérité — le calcul local sur `orders` reste un repli si dashData
  // n'a pas encore chargé, pour ne pas afficher 0 pendant le premier rendu.
  const localRevenue  = orders
    .filter((o: any) => ['completed', 'processing', 'on-hold'].includes(o.status))
    .reduce((sum: number, o: any) => sum + (o.total || 0), 0)
  const displayRevenue = typeof dashData?.revenue_usd === 'number' ? dashData.revenue_usd : localRevenue

  const totalOrders   = ordersData?.total || dashData?.orders_total || 0
  const pendingOrders = orders.filter((o: any) => o.status === 'pending').length || dashData?.orders_by_status?.pending || 0
  const completedOrdersCount = orders.filter((o: any) => o.status === 'completed').length || dashData?.orders_by_status?.completed || 0
  const totalProducts = dashData?.products_total ?? publishedProducts.length

  const stats = [
    { label: 'Revenus (total)', value: meLoading ? '...' : fp(displayRevenue), sub: `${completedOrdersCount} commandes complétées`, icon: DollarSign, color: 'bg-green-50 text-green-600' },
    { label: 'Commandes',       value: meLoading ? '...' : String(totalOrders), sub: `${pendingOrders} en attente`, icon: ShoppingCart, color: 'bg-blue-50 text-blue-600' },
    { label: 'Produits actifs', value: meLoading ? '...' : String(totalProducts), sub: `${totalProducts} au total`, icon: Package, color: 'bg-purple-50 text-purple-600' },
    { label: 'Avis reçus',      value: meLoading ? '...' : String(dashData?.reviews_count || 0), sub: 'Évaluation globale', icon: Star, color: 'bg-orange-50 text-orange-600' },
  ]

  // ── PRODUCT FORM ──────────────────────────────────────────────────────────
  type VariationRow = {
    id?: number
    attrs: Record<string, string>
    price: string
    regularPrice: string
    salePrice: string
    stock: string
    imageUrl: string
    imageId: number
  }

  const [productForm, setProductForm] = useState({
    name: '', price: '', regularPrice: '', salePrice: '', stock: '',
    mainImage: '', mainImageId: 0, galleryImages: '', galleryImageIds: [] as number[],
    category: '', description: '', type: 'simple',
    attributes: [] as { id: number; name: string; options: string }[],
    variations: [] as VariationRow[],
  })

  const handleVariationImageUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    varIdx: number
  ) => {
    const file = e.target.files?.[0]
    if (!file) return
    const toastId = toast.loading('Envoi image variation…')
    try {
      const token = localStorage.getItem('miad_token')
      const form = new FormData(); form.append('file', file)
      const res  = await fetch('/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Erreur upload")
      setProductForm(f => {
        const vars = [...f.variations]
        vars[varIdx] = { ...vars[varIdx], imageUrl: data.url, imageId: data.id }
        return { ...f, variations: vars }
      })
      toast.success('Image variation prête !', { id: toastId })
    } catch (err: any) { toast.error(err.message, { id: toastId }) }
  }

  const generateVariations = () => {
    const attrWithOptions = productForm.attributes.filter(a => a.name && a.options)
    if (attrWithOptions.length === 0) return
    // Produit cartésien des attributs
    const combinations: Record<string, string>[] = [{}]
    for (const attr of attrWithOptions) {
      const opts = attr.options.split(',').flatMap(o => { const t = o.trim(); return t ? [t] : [] })
      const newCombos: Record<string, string>[] = []
      for (const combo of combinations) {
        for (const opt of opts) {
          newCombos.push({ ...combo, [attr.name]: opt })
        }
      }
      combinations.splice(0, combinations.length, ...newCombos)
    }
    setProductForm(f => ({
      ...f,
      variations: combinations.map(attrs => ({
        attrs,
        price: f.price,
        regularPrice: f.regularPrice,
        salePrice: f.salePrice,
        stock: f.stock,
        imageUrl: '',
        imageId: 0,
      })),
    }))
  }

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: 'main' | 'gallery') => {
    const file = e.target.files?.[0]
    if (!file) return
    const formData = new FormData()
    formData.append('file', file)
    const toastId = toast.loading("Envoi de l'image...")
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch('/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Échec de l'upload")
      if (type === 'main') {
        setProductForm(f => ({ ...f, mainImage: data.url, mainImageId: data.id }))
      } else {
        setProductForm(f => ({
          ...f,
          galleryImages: f.galleryImages ? `${f.galleryImages},${data.url}` : data.url,
          galleryImageIds: [...f.galleryImageIds, data.id],
        }))
      }
      toast.success("Image prête !", { id: toastId })
    } catch (err: any) {
      toast.error(err.message, { id: toastId })
    }
  }

  const handleEditClick = async (p: any) => {
    setEditingProductId(p.id)
    const isVariable = p.type === 'variable'

    // Charger les variations existantes si produit variable
    let existingVariations: VariationRow[] = []
    if (isVariable) {
      try {
        const token = localStorage.getItem('miad_token')
        const res = await fetch(`/api/products/${p.id}/variations`, { headers: { Authorization: `Bearer ${token}` } })
        const data = await res.json()
        if (res.ok && data.variations) {
          existingVariations = data.variations.map((v: any) => ({
            id:            v.id,
            attrs:         Object.fromEntries((v.attributes || []).map((a: any) => [a.name, a.option])),
            price:         v.price?.toString() || '',
            regularPrice:  v.regular_price?.toString() || '',
            salePrice:     v.sale_price?.toString() || '',
            stock:         (v.stock_quantity ?? '').toString(),
            imageUrl:      v.image?.src || '',
            imageId:       v.image?.id || 0,
          }))
        }
      } catch {}
    }

    setProductForm({
      name:            p.name,
      price:           p.price?.toString() || '',
      regularPrice:    p.regularPrice?.toString() || '',
      salePrice:       p.salePrice?.toString() || '',
      stock:           p.stock?.toString() || '',
      mainImage:       p.image || '',
      mainImageId:     0,
      galleryImages:   p.images?.join(',') || '',
      galleryImageIds: [],
      category:        p.categorySlug || '',
      description:     p.description || '',
      type:            p.type || 'simple',
      attributes:      (p.attributes || []).map((a: any) => ({ id: nextAttrId.current++, name: a.name, options: a.options?.join(', ') || '' })),
      variations:      existingVariations,
    })
    setIsAddingProduct(true)
  }

  const handleDeleteProduct = async (productId: number) => {
    if (!confirm('Supprimer ce produit ?')) return
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch(`/api/products/${productId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error()
      toast.success('Produit supprimé')
      mutateProducts()
    } catch {
      toast.error('Impossible de supprimer ce produit')
    }
  }

  const handleSubmitProduct = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      const token = localStorage.getItem('miad_token')
      const url    = editingProductId ? `/api/products/${editingProductId}` : '/api/products'
      const method = editingProductId ? 'PUT' : 'POST'

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...productForm, attributes: productForm.attributes.map(({ id, ...rest }) => rest) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || data.error || "Erreur")

      const savedId = editingProductId || data.id

      // Sauvegarder les variations si produit variable
      if (productForm.type === 'variable' && productForm.variations.length > 0 && savedId) {
        await fetch(`/api/products/${savedId}/variations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ variations: productForm.variations }),
        })
      }

      toast.success(editingProductId ? "Produit mis à jour !" : "Produit publié !")
      setIsAddingProduct(false)
      setEditingProductId(null)
      mutateProducts()
      setProductForm({
        name: '', price: '', regularPrice: '', salePrice: '', stock: '',
        mainImage: '', mainImageId: 0, galleryImages: '', galleryImageIds: [],
        category: '', description: '', type: 'simple', attributes: [], variations: [],
      })
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  // ── ORDER STATUS UPDATE ───────────────────────────────────────────────────
  const handleUpdateOrderStatus = async (orderId: number, newStatus: string) => {
    setUpdatingOrderId(orderId)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch('/api/vendor/orders', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orderId, status: newStatus }),
      })
      if (!res.ok) throw new Error()
      toast.success('Statut mis à jour')
      mutateOrders()
      mutateStats()
    } catch {
      toast.error('Impossible de mettre à jour le statut')
    } finally {
      setUpdatingOrderId(null)
    }
  }

  // ── SETTINGS STATE ────────────────────────────────────────────────────────
  const [settingsForm, setSettingsForm] = useState({ storeName, email: '', phone: '', address: '', description: '' })
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [isSavingSettings, setIsSavingSettings] = useState(false)
  const [shippingToggles, setShippingToggles] = useState([true, false, false])

  // Pré-remplit le formulaire avec les vraies valeurs une fois chargées
  // (profileData arrive après le premier rendu, SWR étant async) — sans
  // ça le vendeur devait retaper son adresse/description à chaque
  // visite même si déjà enregistrées. settingsLoaded évite d'écraser une
  // saisie en cours si le SWR revalide en arrière-plan pendant l'édition.
  useEffect(() => {
    if (profileData && !settingsLoaded) {
      setSettingsForm({
        storeName: profileData.storeName || storeName,
        email: profileData.email || '',
        phone: profileData.phone || '',
        address: profileData.address || '',
        description: profileData.description || '',
      })
      setSettingsLoaded(true)
    }
  }, [profileData, settingsLoaded, storeName])

  // ── DEMANDE DE RETRAIT ───────────────────────────────────────────────────
  const [payoutAmount, setPayoutAmount] = useState('')
  const [payoutMethod, setPayoutMethod] = useState('wave')
  const [isRequestingPayout, setIsRequestingPayout] = useState(false)

  const handleRequestPayout = async () => {
    const amount = parseFloat(payoutAmount)
    if (!amount || amount <= 0) { toast.error('Montant invalide'); return }
    setIsRequestingPayout(true)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch('/api/vendor/wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amount_usd: amount, method: payoutMethod }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Erreur')
      toast.success('Demande de retrait envoyée !')
      setPayoutAmount('')
      mutateWallet()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setIsRequestingPayout(false)
    }
  }

  // ── PHOTOS PROFIL / COUVERTURE ────────────────────────────────────────────
  const [profilePhotoOverride, setProfilePhotoUrl] = useState('')
  const [coverPhotoOverride,   setCoverPhotoUrl]   = useState('')
  const [uploadingPhoto,  setUploadingPhoto]  = useState<'avatar' | 'banner' | null>(null)
  const profileInputRef = useRef<HTMLInputElement>(null)
  const coverInputRef   = useRef<HTMLInputElement>(null)
  const nextAttrId = useRef(0)

  const profilePhotoUrl = profilePhotoOverride || profileData?.logoUrl || ''
  const coverPhotoUrl   = coverPhotoOverride   || profileData?.bannerUrl || ''

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: 'avatar' | 'banner') => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingPhoto(type)
    const toastId = toast.loading(type === 'avatar' ? 'Mise à jour du profil…' : 'Mise à jour de la bannière…')
    try {
      const token = localStorage.getItem('miad_token')
      // 1. Upload vers MinIO (voir app/api/upload/route.ts — plus de
      // WordPress Media depuis la migration ; upData.id est toujours 0,
      // seul upData.url est réel, contrairement à ce que ce code lisait
      // avant (bug trouvé le 2026-08-26 : mediaId toujours 0 envoyé à
      // l'étape 2, donc jamais réellement persisté en base).
      const form = new FormData()
      form.append('file', file)
      form.append('prefix', 'vendors')
      const upRes = await fetch('/api/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
      const upData = await upRes.json()
      if (!upRes.ok) throw new Error(upData.error || "Erreur d'upload")

      // Aperçu immédiat
      if (type === 'avatar') setProfilePhotoUrl(upData.url)
      else                   setCoverPhotoUrl(upData.url)

      // 2. Persiste l'URL réelle (vendor-svc PUT /vendor/profile attend
      // {type, url}, pas {type, mediaId} — voir app/api/vendor/profile/route.ts)
      const profRes = await fetch('/api/vendor/profile', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, url: upData.url }),
      })
      if (!profRes.ok) {
        const err = await profRes.json()
        throw new Error(err.error || 'Erreur serveur')
      }
      mutateProfile()
      toast.success(type === 'avatar' ? 'Photo de profil mise à jour !' : 'Bannière mise à jour !', { id: toastId })
    } catch (err: any) {
      toast.error(err.message, { id: toastId })
    } finally {
      setUploadingPhoto(null)
      e.target.value = ''
    }
  }

  const handleSaveSettings = async () => {
    setIsSavingSettings(true)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch('/api/vendor/settings', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeName: settingsForm.storeName,
          phone: settingsForm.phone,
          address: settingsForm.address,
          email: settingsForm.email,
          description: settingsForm.description,
        }),
      })
      if (res.ok) {
        toast.success('Paramètres enregistrés !')
      } else {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error || "Échec de l'enregistrement — réessayez")
      }
    } catch {
      toast.error('Impossible de joindre le serveur — réessayez')
    } finally {
      setIsSavingSettings(false)
    }
  }

  // ── RENDER ────────────────────────────────────────────────────────────────
  // Écran de chargement initial — pendant que /api/vendor/me répond
  if (meLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        {/* Header skeleton */}
        <div className="bg-primary h-16 flex items-center px-6 gap-4 sticky top-0 z-40 shadow-md">
          <div className="w-8 h-8 rounded-lg bg-white/20 animate-pulse" />
          <div className="h-4 w-32 rounded bg-white/20 animate-pulse" />
          <div className="ml-auto h-8 w-36 rounded-xl bg-white/20 animate-pulse" />
        </div>
        <div className="container mx-auto px-4 py-8">
          <div className="flex flex-col lg:flex-row gap-8">
            {/* Sidebar skeleton */}
            <aside className="lg:w-56 shrink-0 space-y-4">
              <div className="bg-white rounded-2xl border border-border p-4 shadow-sm flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-slate-100 animate-pulse" />
                <div className="space-y-2 flex-1">
                  <div className="h-3 bg-slate-100 rounded animate-pulse w-3/4" />
                  <div className="h-2 bg-slate-100 rounded animate-pulse w-1/2" />
                </div>
              </div>
              <div className="bg-white rounded-2xl border border-border overflow-hidden shadow-sm">
                {Array.from({ length: 7 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3.5 border-b border-border last:border-0">
                    <div className="w-4 h-4 rounded bg-slate-100 animate-pulse" />
                    <div className="h-3 bg-slate-100 rounded animate-pulse w-24" />
                  </div>
                ))}
              </div>
            </aside>
            {/* Main skeleton */}
            <main className="flex-1 space-y-6">
              {/* Infos boutique + vendeur — visibles immédiatement */}
              <div className="bg-white rounded-2xl border border-border p-6 shadow-sm flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center">
                  <Store size={26} className="text-accent" />
                </div>
                <div>
                  <p className="font-black text-lg">{storeName}</p>
                  <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-0.5">
                    <Loader2 size={13} className="animate-spin text-accent" />
                    Chargement du tableau de bord…
                  </p>
                </div>
              </div>
              {/* Stats skeleton */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="bg-white rounded-2xl border border-border p-5 shadow-sm space-y-3">
                    <div className="w-10 h-10 rounded-xl bg-slate-100 animate-pulse" />
                    <div className="h-6 bg-slate-100 rounded animate-pulse w-2/3" />
                    <div className="h-3 bg-slate-100 rounded animate-pulse w-1/2" />
                  </div>
                ))}
              </div>
              {/* Commandes skeleton */}
              <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                  <div className="h-4 bg-slate-100 rounded animate-pulse w-40" />
                  <div className="h-3 bg-slate-100 rounded animate-pulse w-16" />
                </div>
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between px-6 py-4 border-b border-border last:border-0">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-slate-100 animate-pulse" />
                      <div className="space-y-1.5">
                        <div className="h-3 bg-slate-100 rounded animate-pulse w-36" />
                        <div className="h-2 bg-slate-100 rounded animate-pulse w-24" />
                      </div>
                    </div>
                    <div className="space-y-1.5 text-right">
                      <div className="h-4 bg-slate-100 rounded animate-pulse w-20" />
                      <div className="h-2 bg-slate-100 rounded animate-pulse w-14 ml-auto" />
                    </div>
                  </div>
                ))}
              </div>
            </main>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-primary text-white sticky top-0 z-40 shadow-md">
        <div className="container mx-auto px-4">
          <div className="flex items-center h-16 gap-4">
            <button type="button" onClick={onBack} aria-label="Retour" className="p-2 hover:bg-white/10 rounded-lg transition-colors">
              <ArrowLeft size={20} />
            </button>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center">
                <span className="font-bold text-sm text-white">M</span>
              </div>
              <span className="font-bold text-sm">MIAD Market</span>
            </div>
            <ChevronRight size={14} className="text-white/40" />
            <span className="text-white/80 text-sm font-medium truncate max-w-40">{storeName}</span>
            <div className="ml-auto flex items-center gap-2">
              <button type="button" onClick={() => { mutateStats(); mutateOrders(); mutateProducts() }} aria-label="Actualiser" className="p-2 hover:bg-white/10 rounded-lg" title="Actualiser">
                <RefreshCcw size={18} />
              </button>
              <Button variant="secondary" size="sm" onClick={() => { setActiveTab('products'); setIsAddingProduct(true) }}>
                <Plus size={15} className="mr-1.5" /> Nouveau produit
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        <div className="flex flex-col lg:flex-row gap-8">

          {/* Sidebar */}
          <aside className="lg:w-56 shrink-0">
            <div className="bg-white rounded-2xl border border-border p-4 mb-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center">
                  <Store size={22} className="text-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-black text-sm truncate">{storeName}</p>
                  <div className="flex items-center gap-1 mt-0.5 text-[10px] text-accent font-bold">
                    <Star size={10} className="fill-accent" /> Vendeur MIAD Vérifié
                  </div>
                </div>
              </div>
            </div>

            <nav className="bg-white rounded-2xl border border-border overflow-hidden shadow-sm">
              {tabs.map((tab, idx) => (
                <button
                  type="button"
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 transition-colors text-left ${idx < tabs.length - 1 ? 'border-b border-border' : ''} ${
                    activeTab === tab.id ? 'bg-accent/10 text-accent border-l-[3px] border-l-accent font-bold' : 'text-foreground hover:bg-slate-50'
                  }`}
                >
                  <tab.icon size={16} />
                  <span className="text-sm">{tab.label}</span>
                </button>
              ))}
              <button
                type="button"
                onClick={onLogout}
                className="w-full flex items-center gap-3 px-4 py-4 text-red-500 hover:bg-red-50 transition-colors border-t border-border"
              >
                <LogOut size={16} />
                <span className="text-sm font-bold">Déconnexion</span>
              </button>
            </nav>
          </aside>

          {/* Main content */}
          <main className="flex-1 min-w-0 space-y-6">

            {/* ── OVERVIEW ─────────────────────────────────────────────── */}
            {activeTab === 'overview' && (
              <div className="space-y-6 animate-in fade-in duration-300">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {stats.map(stat => (
                    <div key={stat.label} className="bg-white rounded-2xl border border-border p-5 shadow-sm">
                      <div className={`w-10 h-10 rounded-xl ${stat.color} flex items-center justify-center mb-3`}>
                        <stat.icon size={20} />
                      </div>
                      <p className="text-2xl font-black text-foreground">{stat.value}</p>
                      <p className="text-xs font-bold text-foreground mt-0.5">{stat.label}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{stat.sub}</p>
                    </div>
                  ))}
                </div>

                {/* Commandes récentes dans l'aperçu */}
                <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                    <h2 className="font-bold text-base">Commandes récentes</h2>
                    <button type="button" onClick={() => setActiveTab('orders')} className="text-xs font-bold text-accent flex items-center gap-1">
                      Tout voir <ChevronRight size={14} />
                    </button>
                  </div>
                  {ordersLoading ? (
                    <div className="p-8 flex justify-center"><Loader2 className="animate-spin text-accent" size={24} /></div>
                  ) : orders.length === 0 ? (
                    <div className="p-8 text-center text-sm text-muted-foreground">Aucune commande pour le moment.</div>
                  ) : (
                    <div className="divide-y divide-border">
                      {orders.slice(0, 5).map(order => {
                        const st = statusLabel(order.status)
                        return (
                          <div key={order.id} className="flex items-center justify-between px-6 py-3 hover:bg-slate-50 transition-colors">
                            <div className="flex items-center gap-3">
                              <div className={`w-2 h-2 rounded-full ${st.dot}`} />
                              <div>
                                <p className="text-sm font-bold">#{order.number} — {order.customer_name}</p>
                                <p className="text-[10px] text-muted-foreground" suppressHydrationWarning>{new Date(order.date).toLocaleDateString('fr-FR')}</p>
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="text-sm font-black text-accent">{fp(order.total)}</p>
                              <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full ${st.color}`}>{st.label}</span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* Quick actions */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {[
                    { label: 'Ajouter un produit', icon: Plus, action: () => { setActiveTab('products'); setIsAddingProduct(true) }, color: 'bg-accent text-white' },
                    { label: 'Gérer les commandes', icon: ShoppingCart, action: () => setActiveTab('orders'), color: 'bg-primary text-white' },
                    { label: 'Voir ma vitrine', icon: ExternalLink, action: () => effectiveVendorSlug && window.open(`/vendor/${effectiveVendorSlug}`, '_blank'), color: 'bg-slate-800 text-white' },
                  ].map(item => (
                    <button type="button" key={item.label} onClick={item.action} className={`${item.color} rounded-2xl p-5 flex items-center gap-3 hover:opacity-90 transition-opacity shadow-sm`}>
                      <item.icon size={20} />
                      <span className="font-bold text-sm">{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── PRODUCTS ─────────────────────────────────────────────── */}
            {activeTab === 'products' && (
              <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden animate-in fade-in duration-300">
                {!isAddingProduct ? (
                  <>
                    <div className="p-6 border-b border-border flex items-center justify-between">
                      <h2 className="font-bold text-lg">Mon Catalogue ({publishedProducts.length})</h2>
                      <Button size="sm" onClick={() => setIsAddingProduct(true)} className="bg-accent text-white rounded-xl">
                        <Plus size={15} className="mr-1" /> Ajouter un produit
                      </Button>
                    </div>
                    <div className="overflow-x-auto min-h-[300px]">
                      {productsLoading ? (
                        <div className="p-12 flex justify-center"><Loader2 className="animate-spin text-accent" size={28} /></div>
                      ) : publishedProducts.length === 0 ? (
                        <div className="p-16 text-center">
                          <Package size={40} className="mx-auto mb-4 opacity-20" />
                          <p className="font-bold text-lg mb-2">Aucun produit publié</p>
                          <p className="text-sm text-muted-foreground mb-6">Commencez par ajouter votre premier produit.</p>
                          <Button onClick={() => setIsAddingProduct(true)} className="bg-accent text-white">Ajouter un produit</Button>
                        </div>
                      ) : (
                        <table className="w-full text-left">
                          <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                            <tr>
                              <th className="px-6 py-4">Produit</th>
                              <th className="px-6 py-4">Prix</th>
                              <th className="px-6 py-4">Stock</th>
                              <th className="px-6 py-4">Catégorie</th>
                              <th className="px-6 py-4 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {publishedProducts.map((p: WooProduct) => (
                              <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                                <td className="px-6 py-4">
                                  <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-xl bg-muted overflow-hidden shrink-0">
                                      <img src={p.image} className="w-full h-full object-cover" alt="" />
                                    </div>
                                    <span className="font-bold text-sm line-clamp-2 max-w-xs">{p.name}</span>
                                  </div>
                                </td>
                                <td className="px-6 py-4 text-sm font-black text-accent whitespace-nowrap">
                                  {fp(p.price)}
                                  {p.regularPrice && p.regularPrice > p.price && (
                                    <span className="ml-1 text-[10px] text-muted-foreground line-through font-normal">{fp(p.regularPrice)}</span>
                                  )}
                                </td>
                                <td className="px-6 py-4">
                                  <span className={`text-[10px] font-black px-2 py-1 rounded-full ${p.inStock ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                                    {p.inStock ? `${p.stock} en stock` : 'Épuisé'}
                                  </span>
                                </td>
                                <td className="px-6 py-4 text-xs text-muted-foreground">{p.category || '—'}</td>
                                <td className="px-6 py-4">
                                  <div className="flex justify-end gap-2">
                                    <button type="button" onClick={() => handleEditClick(p)} aria-label="Modifier" className="p-2 hover:bg-accent/10 text-accent rounded-lg transition-colors" title="Modifier">
                                      <Edit size={16} />
                                    </button>
                                    <button type="button" onClick={() => handleDeleteProduct(Number(p.id))} aria-label="Supprimer" className="p-2 hover:bg-red-50 text-red-500 rounded-lg transition-colors" title="Supprimer">
                                      <Trash2 size={16} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="p-8 animate-in fade-in zoom-in-95">
                    <div className="flex items-center gap-4 mb-8">
                      <button type="button" onClick={() => { setIsAddingProduct(false); setEditingProductId(null) }} aria-label="Retour" className="p-2 hover:bg-muted rounded-full">
                        <ArrowLeft size={18} />
                      </button>
                      <h2 className="text-xl font-black uppercase tracking-tight">
                        {editingProductId ? "Modifier le produit" : "Nouveau produit"}
                      </h2>
                    </div>
                    <form onSubmit={handleSubmitProduct} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-4">
                        <div>
                          <label htmlFor="product-name" className="text-[10px] font-black uppercase text-slate-400 mb-1.5 block">Nom du produit *</label>
                          <Input id="product-name" placeholder="Ex: Robe Wax Authentique" value={productForm.name} onChange={e => setProductForm(f => ({ ...f, name: e.target.value }))} required />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label htmlFor="product-regular-price" className="text-[10px] font-black uppercase text-slate-400 mb-1.5 block">Prix normal *</label>
                            <PriceInputWithCurrency id="product-regular-price" placeholder="0.00" usdValue={productForm.regularPrice || productForm.price} onUsdChange={usd => setProductForm(f => ({ ...f, regularPrice: usd }))} required />
                          </div>
                          <div>
                            <label htmlFor="product-sale-price" className="text-[10px] font-black uppercase text-slate-400 mb-1.5 block">Prix promo <span className="text-orange-500">🔥</span></label>
                            <PriceInputWithCurrency id="product-sale-price" placeholder="Laisser vide si pas de promo" usdValue={productForm.salePrice} onUsdChange={usd => setProductForm(f => ({ ...f, salePrice: usd, price: usd || f.regularPrice }))} />
                          </div>
                        </div>
                        {productForm.salePrice && (
                          <div className="bg-orange-50 border border-orange-200 rounded-xl px-3 py-2 text-xs text-orange-700 font-medium flex items-center gap-2">
                            🔥 Prix affiché : <span className="font-black">{productForm.salePrice} $</span>
                            <span className="line-through text-orange-400 ml-1">{productForm.regularPrice} $</span>
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label htmlFor="product-stock" className="text-[10px] font-black uppercase text-slate-400 mb-1.5 block">Stock *</label>
                            <Input id="product-stock" type="number" placeholder="0" value={productForm.stock} onChange={e => setProductForm(f => ({ ...f, stock: e.target.value }))} required />
                          </div>
                          <div>
                            <label htmlFor="product-type" className="text-[10px] font-black uppercase text-slate-400 mb-1.5 block">Type</label>
                            <select id="product-type" className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm" value={productForm.type} onChange={e => setProductForm(f => ({ ...f, type: e.target.value }))}>
                              <option value="simple">Simple</option>
                              <option value="variable">Variable (tailles/couleurs)</option>
                            </select>
                          </div>
                        </div>
                        <div>
                          <p className="text-[10px] font-black uppercase text-slate-400 mb-1.5 block">Image principale</p>
                          <div className="flex items-center gap-4">
                            <div className="w-20 h-20 rounded-2xl bg-slate-100 border-2 border-dashed border-slate-200 flex items-center justify-center overflow-hidden shrink-0">
                              {productForm.mainImage ? <img src={productForm.mainImage} className="w-full h-full object-cover" alt="" /> : <Camera size={20} className="opacity-20" />}
                            </div>
                            <label className="flex-1 cursor-pointer">
                              <div className="h-10 border border-border rounded-xl bg-white flex items-center justify-center text-xs font-bold gap-2 hover:bg-slate-50 transition-colors">
                                <Upload size={14} /> Choisir une photo
                              </div>
                              <input type="file" className="hidden" accept="image/*" onChange={e => handleImageUpload(e, 'main')} />
                            </label>
                          </div>
                        </div>
                        <div>
                          <p className="text-[10px] font-black uppercase text-slate-400 mb-1.5 block">Galerie photos</p>
                          <div className="flex gap-2 flex-wrap">
                            <label className="w-16 h-16 rounded-xl border-2 border-dashed border-slate-200 flex items-center justify-center cursor-pointer hover:bg-slate-50 transition-colors">
                              <Plus size={16} className="opacity-40" />
                              <input type="file" aria-label="Ajouter une photo à la galerie" className="hidden" multiple accept="image/*" onChange={e => handleImageUpload(e, 'gallery')} />
                            </label>
                            {productForm.galleryImages.split(',').filter(Boolean).map((img) => (
                              <div key={img} className="w-16 h-16 rounded-xl overflow-hidden border border-border">
                                <img src={img} className="w-full h-full object-cover" alt="" />
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="space-y-4">
                        <div>
                          <label htmlFor="product-category" className="text-[10px] font-black uppercase text-slate-400 mb-1.5 block">Catégorie</label>
                          <select id="product-category" className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm" value={productForm.category} onChange={e => setProductForm(f => ({ ...f, category: e.target.value }))}>
                            <option value="">Choisir une catégorie...</option>
                            {siteCategories.reduce((acc: React.ReactNode[], parent) => {
                              if (!parent.isRoot || parent.slug === 'uncategorized') return acc
                              const children = siteCategories.filter(c => c.parent === parent.id && !c.isRoot)
                              acc.push(children.length > 0 ? (
                                <optgroup key={parent.id} label={parent.name}>
                                  {children.map(child => (
                                    <option key={child.id} value={child.slug}>{child.name}</option>
                                  ))}
                                </optgroup>
                              ) : (
                                <option key={parent.id} value={parent.slug}>{parent.name}</option>
                              ))
                              return acc
                            }, [])}
                          </select>
                        </div>
                        <div>
                          <label htmlFor="product-description" className="text-[10px] font-black uppercase text-slate-400 mb-1.5 block">Description</label>
                          <textarea
                            id="product-description"
                            className="w-full p-3 rounded-xl border border-input bg-background text-sm min-h-28 resize-none"
                            placeholder="Décrivez votre produit en détail (matière, dimensions, utilisation...)..."
                            value={productForm.description}
                            onChange={e => setProductForm(f => ({ ...f, description: e.target.value }))}
                          />
                        </div>
                        {/* ── Attributs ── */}
                        <div>
                          <div className="flex justify-between items-center mb-1.5">
                            <p className="text-[10px] font-black uppercase text-slate-400">
                              Attributs {productForm.type === 'variable' ? '(Taille, Couleur…)' : ''}
                            </p>
                            <Button type="button" variant="ghost" size="sm" className="h-6 text-[9px] font-black text-accent"
                              onClick={() => setProductForm(f => ({ ...f, attributes: [...f.attributes, { id: nextAttrId.current++, name: '', options: '' }] }))}>
                              + Ajouter
                            </Button>
                          </div>
                          <div className="space-y-2">
                            {productForm.attributes.map((attr, idx) => (
                              <div key={attr.id} className="flex gap-2">
                                <Input placeholder="Nom (Taille)" value={attr.name}
                                  onChange={e => { const a = [...productForm.attributes]; a[idx].name = e.target.value; setProductForm(f => ({ ...f, attributes: a })) }} />
                                <Input placeholder="Options (S, M, L)" value={attr.options}
                                  onChange={e => { const a = [...productForm.attributes]; a[idx].options = e.target.value; setProductForm(f => ({ ...f, attributes: a })) }}
                                  className="flex-2" />
                                <button type="button" onClick={() => setProductForm(f => ({ ...f, attributes: f.attributes.filter((_, i) => i !== idx) }))}
                                  aria-label="Supprimer l'attribut"
                                  className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* ── Générer les variations (produit variable) ── */}
                        {productForm.type === 'variable' && productForm.attributes.length > 0 && (
                          <Button type="button" variant="outline" onClick={generateVariations}
                            className="w-full border-dashed border-accent text-accent font-bold text-xs h-10 rounded-xl">
                            ⚡ Générer les variations ({productForm.variations.length > 0 ? `${productForm.variations.length} existantes` : 'depuis les attributs'})
                          </Button>
                        )}

                        <Button type="submit" disabled={isSubmitting} className="w-full h-12 bg-slate-900 text-white font-black uppercase text-xs tracking-widest rounded-2xl">
                          {isSubmitting ? <Loader2 className="animate-spin" size={18} /> : <><Save size={16} className="mr-2" />{editingProductId ? "Mettre à jour" : "Publier le produit"}</>}
                        </Button>
                      </div>
                    </form>

                    {/* ── SECTION VARIATIONS ── affichée sous le formulaire si variable ── */}
                    {productForm.type === 'variable' && productForm.variations.length > 0 && (
                      <div className="mt-8 border-t border-border pt-8">
                        <div className="flex items-center justify-between mb-4">
                          <h3 className="font-black uppercase text-sm tracking-tight">
                            Variations ({productForm.variations.length})
                          </h3>
                          <Button type="button" size="sm" variant="outline"
                            onClick={() => setProductForm(f => ({
                              ...f,
                              variations: [...f.variations, {
                                attrs: Object.fromEntries(f.attributes.map(a => [a.name, ''])),
                                price: f.salePrice || f.regularPrice, regularPrice: f.regularPrice,
                                salePrice: f.salePrice, stock: f.stock, imageUrl: '', imageId: 0,
                              }],
                            }))}
                            className="text-xs font-bold h-8 rounded-xl">
                            <Plus size={13} className="mr-1" /> Ajouter une variation
                          </Button>
                        </div>

                        <div className="space-y-3">
                          {productForm.variations.map((v, vi) => (
                            <div key={vi} className="bg-slate-50 border border-border rounded-2xl p-4">
                              <div className="flex items-start gap-3">

                                {/* Image variation */}
                                <label className="shrink-0 cursor-pointer group">
                                  <div className="w-16 h-16 rounded-xl border-2 border-dashed border-slate-300 bg-white flex items-center justify-center overflow-hidden group-hover:border-accent transition-colors">
                                    {v.imageUrl
                                      ? <img src={v.imageUrl} className="w-full h-full object-cover" alt="" />
                                      : <Camera size={18} className="opacity-20 group-hover:opacity-50 transition-opacity" />}
                                  </div>
                                  <input type="file" accept="image/*" aria-label="Image de la variation" className="hidden"
                                    onChange={e => handleVariationImageUpload(e, vi)} />
                                </label>

                                <div className="flex-1 space-y-2">
                                  {/* Attributs de la variation */}
                                  <div className="flex gap-2 flex-wrap">
                                    {Object.entries(v.attrs).map(([attrName, attrVal]) => (
                                      <div key={attrName} className="flex items-center gap-1">
                                        <span className="text-[10px] font-black text-slate-500 uppercase">{attrName}:</span>
                                        <Input
                                          value={attrVal}
                                          placeholder={attrName}
                                          className="h-7 text-xs w-24 px-2"
                                          onChange={e => {
                                            const vars = [...productForm.variations]
                                            vars[vi] = { ...vars[vi], attrs: { ...vars[vi].attrs, [attrName]: e.target.value } }
                                            setProductForm(f => ({ ...f, variations: vars }))
                                          }}
                                        />
                                      </div>
                                    ))}
                                  </div>

                                  {/* Prix + Stock */}
                                  <div className="grid grid-cols-3 gap-2">
                                    <div>
                                      <label htmlFor={`var-${vi}-regular-price`} className="text-[9px] font-black uppercase text-slate-400 block mb-0.5">Prix normal</label>
                                      <PriceInputWithCurrency id={`var-${vi}-regular-price`} usdValue={v.regularPrice} placeholder="0.00" className="[&_input]:h-8 [&_input]:text-xs"
                                        onUsdChange={usd => { const vars = [...productForm.variations]; vars[vi] = { ...vars[vi], regularPrice: usd }; setProductForm(f => ({ ...f, variations: vars })) }} />
                                    </div>
                                    <div>
                                      <label htmlFor={`var-${vi}-sale-price`} className="text-[9px] font-black uppercase text-orange-400 block mb-0.5">Prix promo 🔥</label>
                                      <PriceInputWithCurrency id={`var-${vi}-sale-price`} usdValue={v.salePrice} placeholder="Optionnel" className="[&_input]:h-8 [&_input]:text-xs"
                                        onUsdChange={usd => { const vars = [...productForm.variations]; vars[vi] = { ...vars[vi], salePrice: usd, price: usd || v.regularPrice }; setProductForm(f => ({ ...f, variations: vars })) }} />
                                    </div>
                                    <div>
                                      <label htmlFor={`var-${vi}-stock`} className="text-[9px] font-black uppercase text-slate-400 block mb-0.5">Stock</label>
                                      <Input id={`var-${vi}-stock`} type="number" value={v.stock} placeholder="0" className="h-8 text-xs"
                                        onChange={e => { const vars = [...productForm.variations]; vars[vi] = { ...vars[vi], stock: e.target.value }; setProductForm(f => ({ ...f, variations: vars })) }} />
                                    </div>
                                  </div>
                                </div>

                                {/* Supprimer variation */}
                                <button type="button"
                                  onClick={() => setProductForm(f => ({ ...f, variations: f.variations.filter((_, i) => i !== vi) }))}
                                  aria-label="Supprimer la variation"
                                  className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors shrink-0 mt-0.5">
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                    /* fin section variations */
                    }
                  </div>
                )}
              </div>
            )}

            {/* ── ORDERS ───────────────────────────────────────────────── */}
            {activeTab === 'orders' && (
              <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden animate-in fade-in duration-300">
                <div className="px-6 py-5 border-b border-border">
                  <h2 className="font-bold text-lg mb-4">Gestion des commandes</h2>
                  {/* Filtres statut */}
                  <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
                    {ORDER_STATUSES.map(s => (
                      <button
                        type="button"
                        key={s.id}
                        onClick={() => setOrderFilter(s.id)}
                        className={`shrink-0 flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-bold border transition-all ${
                          orderFilter === s.id ? `${s.color} border-current shadow-sm` : 'border-border text-muted-foreground hover:border-slate-300'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>

                {ordersLoading ? (
                  <div className="p-12 flex justify-center"><Loader2 className="animate-spin text-accent" size={28} /></div>
                ) : orders.length === 0 ? (
                  <div className="py-16 flex flex-col items-center text-center px-4">
                    <div className="w-16 h-16 rounded-2xl bg-blue-50 flex items-center justify-center mb-4">
                      <ShoppingCart size={28} className="text-blue-400" />
                    </div>
                    <p className="font-bold text-lg mb-2">Aucune commande</p>
                    <p className="text-sm text-muted-foreground max-w-sm">Les commandes de vos clients apparaîtront ici dès qu'ils achèteront dans votre boutique.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {orders.map(order => {
                      const st = statusLabel(order.status)
                      const isExpanded = expandedOrder === order.id
                      return (
                        <div key={order.id} className="hover:bg-slate-50 transition-colors">
                          <div
                            role="button"
                            tabIndex={0}
                            className="flex items-center justify-between px-6 py-4 cursor-pointer"
                            onClick={() => setExpandedOrder(isExpanded ? null : order.id)}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedOrder(isExpanded ? null : order.id) } }}
                          >
                            <div className="flex items-center gap-4 min-w-0">
                              <div className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
                              <div className="min-w-0">
                                <p className="font-bold text-sm">Commande #{order.number}</p>
                                <p className="text-xs text-muted-foreground" suppressHydrationWarning>{order.customer_name} · {new Date(order.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-4 shrink-0">
                              <div className="text-right">
                                <p className="font-black text-accent">{fp(order.total)}</p>
                                <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full ${st.color}`}>{st.label}</span>
                              </div>
                              <ChevronDown size={16} className={`text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                            </div>
                          </div>

                          {/* Détail expandable — style AliExpress */}
                          {isExpanded && (
                            <div className="px-6 pb-6 border-t border-slate-100 bg-slate-50/60 animate-in fade-in slide-in-from-top-2 duration-200">
                              <div className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-6">
                                {/* Articles */}
                                <div>
                                  <p className="text-[10px] font-black uppercase text-slate-400 mb-3">Articles ({order.items?.length || 0})</p>
                                  <div className="space-y-2">
                                    {(order.items || []).map((item: any, i: number) => (
                                      <div key={item.product_id || i} className="flex items-center gap-3 bg-white rounded-xl p-3 border border-border">
                                        {item.image && (
                                          <div className="w-10 h-10 rounded-lg overflow-hidden bg-muted shrink-0">
                                            <LazyImage src={item.image} decoding="async" className="w-full h-full object-cover" alt="" />
                                          </div>
                                        )}
                                        <div className="flex-1 min-w-0">
                                          <p className="text-xs font-bold line-clamp-1">{item.name}</p>
                                          <p className="text-[10px] text-muted-foreground">Qté: {item.quantity}</p>
                                        </div>
                                        <p className="text-xs font-black text-accent whitespace-nowrap">{fp(item.subtotal)}</p>
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                {/* Infos client + actions */}
                                <div className="space-y-4">
                                  <div>
                                    <p className="text-[10px] font-black uppercase text-slate-400 mb-2">Client</p>
                                    <div className="bg-white rounded-xl border border-border p-4 space-y-1.5 text-sm">
                                      <p className="font-bold">{order.customer_name}</p>
                                      {order.customer_email && <p className="text-muted-foreground text-xs">{order.customer_email}</p>}
                                      {order.customer_phone && <p className="text-muted-foreground text-xs">{order.customer_phone}</p>}
                                      {order.shipping_country && <p className="text-xs">📦 Livraison vers : <strong>{order.shipping_country}</strong></p>}
                                      {order.shipping_method && <p className="text-xs text-muted-foreground">{order.shipping_method}</p>}
                                      {order.payment_method && <p className="text-xs text-muted-foreground">Paiement : {order.payment_method}</p>}
                                    </div>
                                  </div>

                                  <div>
                                    <p className="text-[10px] font-black uppercase text-slate-400 mb-2">Changer le statut</p>
                                    <div className="flex flex-wrap gap-2">
                                      {(['processing', 'completed', 'cancelled'] as const).map(s => {
                                        const info = statusLabel(s)
                                        return (
                                          <button
                                            type="button"
                                            key={s}
                                            disabled={order.status === s || updatingOrderId === order.id}
                                            onClick={() => handleUpdateOrderStatus(order.id, s)}
                                            className={`text-[10px] font-black uppercase px-3 py-1.5 rounded-full border transition-all disabled:opacity-50 ${info.color} border-current hover:shadow-sm`}
                                          >
                                            {updatingOrderId === order.id ? <Loader2 size={10} className="animate-spin" /> : info.label}
                                          </button>
                                        )
                                      })}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── REVIEWS ──────────────────────────────────────────────── */}
            {activeTab === 'reviews' && (
              <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden animate-in fade-in duration-300">
                <div className="p-6 border-b border-border">
                  <h2 className="font-bold text-lg">Avis Clients</h2>
                </div>
                <div className="p-12 text-center">
                  <div className="w-16 h-16 bg-orange-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <Star size={28} className="text-orange-400 fill-orange-400" />
                  </div>
                  <p className="font-bold text-lg mb-2">{dashData?.reviews_count > 0 ? `${dashData.reviews_count} avis reçus` : 'Aucun avis pour le moment'}</p>
                  <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                    Dès que vos clients noteront vos produits, leurs avis apparaîtront ici.
                  </p>
                </div>
              </div>
            )}

            {/* ── VITRINE / QR ─────────────────────────────────────────── */}
            {activeTab === 'vitrine' && (
              <div className="space-y-6 animate-in fade-in duration-300">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white rounded-2xl border border-border p-8 text-center shadow-sm">
                  <h3 className="text-lg font-black uppercase tracking-tight mb-6 italic">QR Code Boutique</h3>
                  {(() => {
                    const storeUrl = `https://www.miadmarket.com/vendor/${effectiveVendorSlug || storeName.toLowerCase().replace(/\s+/g, '-')}`
                    const handleDownload = () => {
                      import('qrcode').then(QRCode => {
                        QRCode.toDataURL(storeUrl, { width: 512, margin: 2, color: { dark: '#0f172a', light: '#ffffff' }, errorCorrectionLevel: 'H' })
                          .then(dataUrl => { const a = document.createElement('a'); a.href = dataUrl; a.download = `qr-${storeName.replace(/\s+/g, '-')}.png`; a.click() })
                      })
                    }
                    const handleShare = async () => {
                      if (navigator.share) { await navigator.share({ title: storeName, url: storeUrl }) }
                      else { await navigator.clipboard.writeText(storeUrl); toast.success('Lien copié !') }
                    }
                    return (
                      <>
                        <div className="w-48 h-48 mx-auto rounded-3xl overflow-hidden border-4 border-slate-100 shadow-inner mb-6 flex items-center justify-center bg-white">
                          <QRCodeImage url={storeUrl} size={176} />
                        </div>
                        <p className="text-[10px] text-accent font-bold truncate mb-6 px-4">{storeUrl}</p>
                        <div className="flex gap-2">
                          <Button onClick={handleShare} className="flex-1 bg-accent text-white font-black uppercase text-[10px] tracking-widest h-11 rounded-xl gap-2">
                            <Share2 size={14} /> Partager
                          </Button>
                          <Button onClick={handleDownload} variant="outline" className="flex-1 border-slate-900 text-slate-900 font-black uppercase text-[10px] h-11 rounded-xl">
                            Télécharger
                          </Button>
                        </div>
                      </>
                    )
                  })()}
                </div>

                <div className="bg-slate-900 text-white rounded-2xl p-8 flex flex-col justify-between shadow-xl">
                  {/* inputs cachés */}
                  <input ref={profileInputRef} type="file" accept="image/*" className="hidden"
                    onChange={e => handlePhotoUpload(e, 'avatar')} />
                  <input ref={coverInputRef}   type="file" accept="image/*" className="hidden"
                    onChange={e => handlePhotoUpload(e, 'banner')} />

                  <div>
                    <h3 className="text-lg font-black uppercase tracking-tight mb-6 italic">Personnalisation</h3>
                    <div className="space-y-5">

                      {/* Photo de profil */}
                      <div>
                        <p className="text-[10px] font-black uppercase text-slate-400 mb-2 block">Photo de profil</p>
                        <div className="flex items-center gap-4">
                          <button
                            type="button"
                            onClick={() => profileInputRef.current?.click()}
                            className="relative w-16 h-16 rounded-full bg-white/10 flex items-center justify-center overflow-hidden border-2 border-accent hover:border-white transition-colors group"
                          >
                            {profilePhotoUrl
                              ? <img src={profilePhotoUrl} className="w-full h-full object-cover" alt="profil" />
                              : <Camera size={20} className="opacity-40 group-hover:opacity-80 transition-opacity" />
                            }
                            {uploadingPhoto === 'avatar' && (
                              <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                                <Loader2 size={16} className="animate-spin text-white" />
                              </div>
                            )}
                          </button>
                          <div>
                            <Button
                              variant="secondary" size="sm"
                              disabled={uploadingPhoto === 'avatar'}
                              onClick={() => profileInputRef.current?.click()}
                              className="bg-white text-slate-900 font-black h-9 text-[10px] uppercase tracking-widest rounded-lg"
                            >
                              {uploadingPhoto === 'avatar' ? <Loader2 size={12} className="animate-spin mr-1" /> : <Camera size={12} className="mr-1" />}
                              Changer
                            </Button>
                            <p className="text-[10px] text-slate-500 mt-1">JPG, PNG — max 5 Mo</p>
                          </div>
                        </div>
                      </div>

                      {/* Bannière */}
                      <div>
                        <p className="text-[10px] font-black uppercase text-slate-400 mb-2 block">Bannière boutique</p>
                        <button
                          type="button"
                          onClick={() => coverInputRef.current?.click()}
                          disabled={uploadingPhoto === 'banner'}
                          className="relative h-24 w-full rounded-2xl bg-white/10 border-2 border-dashed border-white/20 flex items-center justify-center overflow-hidden hover:border-white/50 transition-colors group"
                        >
                          {coverPhotoUrl
                            ? <img src={coverPhotoUrl} className="absolute inset-0 w-full h-full object-cover" alt="bannière" />
                            : <ImageIcon size={22} className="opacity-20 group-hover:opacity-50 transition-opacity" />
                          }
                          {uploadingPhoto === 'banner' && (
                            <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                              <Loader2 size={18} className="animate-spin text-white" />
                            </div>
                          )}
                          {!uploadingPhoto && (
                            <div className="absolute bottom-1.5 right-2 bg-black/60 rounded-lg px-2 py-0.5">
                              <span className="text-[9px] text-white font-bold uppercase tracking-wider">Modifier</span>
                            </div>
                          )}
                        </button>
                        <Button
                          variant="secondary" size="sm"
                          disabled={uploadingPhoto === 'banner'}
                          onClick={() => coverInputRef.current?.click()}
                          className="bg-white text-slate-900 font-black h-9 text-[10px] uppercase tracking-widest rounded-lg mt-3 w-full"
                        >
                          {uploadingPhoto === 'banner' ? <Loader2 size={12} className="animate-spin mr-1" /> : <Upload size={12} className="mr-1" />}
                          Charger la bannière
                        </Button>
                      </div>

                    </div>
                  </div>
                </div>
              </div>

              {/* Top 10 produits de la boutique */}
              <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
                <div className="p-5 border-b border-border flex items-center justify-between">
                  <h3 className="font-black text-base uppercase tracking-tight">⭐ Top produits de ma boutique</h3>
                  <span className="text-xs text-muted-foreground">{publishedProducts.length} produit{publishedProducts.length !== 1 ? 's' : ''} au total</span>
                </div>
                {productsLoading ? (
                  <div className="p-10 flex justify-center"><Loader2 className="animate-spin text-accent" size={24} /></div>
                ) : publishedProducts.length === 0 ? (
                  <div className="p-10 text-center text-muted-foreground text-sm">
                    <Package size={32} className="mx-auto mb-3 opacity-20" />
                    Aucun produit publié pour le moment.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 p-4">
                    {[...publishedProducts]
                      .slice(0, 10)
                      .map((p: WooProduct) => (
                        <button
                          type="button"
                          key={p.id}
                          onClick={() => setActiveTab('products')}
                          className="group text-left rounded-xl border border-border overflow-hidden hover:border-accent hover:shadow-md transition-all"
                        >
                          <div className="aspect-square bg-muted overflow-hidden">
                            {p.image ? (
                              <LazyImage src={p.image} alt={p.name} decoding="async" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-2xl bg-linear-to-br from-accent/10 to-primary/10">🛍️</div>
                            )}
                          </div>
                          <div className="p-2.5">
                            <p className="text-[11px] font-bold line-clamp-2 leading-tight text-foreground">{p.name}</p>
                            <p className="text-[11px] font-black text-accent mt-1">{fp(Number(p.price || 0))}</p>
                            {!p.inStock ? (
                              <span className="text-[9px] font-bold text-red-500 uppercase">Rupture</span>
                            ) : p.stock > 0 ? (
                              <span className="text-[9px] font-bold text-emerald-600">{p.stock} en stock</span>
                            ) : (
                              <span className="text-[9px] font-bold text-emerald-500">En stock</span>
                            )}
                          </div>
                        </button>
                      ))}
                  </div>
                )}
                {publishedProducts.length > 0 && (
                  <div className="p-4 border-t border-border text-center">
                    <button
                      type="button"
                      onClick={() => setActiveTab('products')}
                      className="text-xs text-accent font-bold hover:underline"
                    >
                      Voir tous mes produits →
                    </button>
                  </div>
                )}
              </div>
              </div>
            )}

            {/* ── ANALYTICS ────────────────────────────────────────────── */}
            {activeTab === 'analytics' && (
              <div className="space-y-6 animate-in fade-in duration-300">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {[
                    { label: 'Revenus (total)', value: `${fp(displayRevenue)}`, icon: DollarSign, color: 'bg-green-50 text-green-700' },
                    { label: 'Commandes totales', value: dashData?.orders_total || 0, icon: ShoppingCart, color: 'bg-purple-50 text-purple-700' },
                    { label: 'Commandes livrées', value: completedOrdersCount, icon: CheckCircle, color: 'bg-emerald-50 text-emerald-700' },
                    { label: 'Produits publiés', value: totalProducts, icon: Package, color: 'bg-orange-50 text-orange-700' },
                    { label: 'Avis clients', value: dashData?.reviews_count || 0, icon: Star, color: 'bg-yellow-50 text-yellow-700' },
                  ].map(item => (
                    <div key={item.label} className="bg-white rounded-2xl border border-border p-5 shadow-sm">
                      <div className={`w-9 h-9 rounded-xl ${item.color} flex items-center justify-center mb-3`}>
                        <item.icon size={18} />
                      </div>
                      <p className="text-2xl font-black">{item.value}</p>
                      <p className="text-xs text-muted-foreground mt-1">{item.label}</p>
                    </div>
                  ))}
                </div>

                <div className="bg-white rounded-2xl border border-border p-8 shadow-sm">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
                      <BarChart2 size={20} className="text-accent" />
                    </div>
                    <div>
                      <h3 className="font-bold">Répartition des commandes</h3>
                      <p className="text-xs text-muted-foreground">Basé sur vos données en temps réel</p>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {[
                      { label: 'En attente',    value: dashData?.orders_pending || 0,    color: 'bg-yellow-400', total: dashData?.orders_total || 1 },
                      { label: 'En cours',      value: dashData?.orders_processing || 0, color: 'bg-blue-400',   total: dashData?.orders_total || 1 },
                      { label: 'Livrées',       value: dashData?.orders_completed || 0,  color: 'bg-green-500',  total: dashData?.orders_total || 1 },
                      { label: 'Annulées',      value: dashData?.orders_cancelled || 0,  color: 'bg-red-400',    total: dashData?.orders_total || 1 },
                    ].map(bar => (
                      <div key={bar.label} className="flex items-center gap-4">
                        <span className="w-24 text-xs font-medium text-slate-500 shrink-0">{bar.label}</span>
                        <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${bar.color} transition-all duration-700`} style={{ width: `${bar.total > 0 ? Math.max(2, (bar.value / bar.total) * 100) : 2}%` }} />
                        </div>
                        <span className="w-8 text-xs font-black text-right">{bar.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── SETTINGS ─────────────────────────────────────────────── */}
            {activeTab === 'settings' && (
              <div className="space-y-5 animate-in fade-in duration-300">
                {/* Store info */}
                <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-border">
                    <h2 className="font-bold text-lg">Informations de la boutique</h2>
                  </div>
                  <div className="p-6 space-y-4">
                    <div>
                      <label htmlFor="settings-store-name" className="text-sm font-medium block mb-1.5">Nom de la boutique</label>
                      <Input id="settings-store-name" value={settingsForm.storeName} onChange={e => setSettingsForm(f => ({ ...f, storeName: e.target.value }))} placeholder={storeName} />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="settings-email" className="text-sm font-medium block mb-1.5">Email de contact</label>
                        <Input id="settings-email" type="email" value={settingsForm.email} onChange={e => setSettingsForm(f => ({ ...f, email: e.target.value }))} placeholder="contact@maboutique.com" />
                      </div>
                      <div>
                        <label htmlFor="settings-phone" className="text-sm font-medium block mb-1.5">Téléphone</label>
                        <Input id="settings-phone" type="tel" value={settingsForm.phone} onChange={e => setSettingsForm(f => ({ ...f, phone: e.target.value }))} placeholder="+221 77 000 00 00" />
                      </div>
                    </div>
                    <div>
                      <label htmlFor="settings-address" className="text-sm font-medium block mb-1.5">Adresse</label>
                      <Input id="settings-address" value={settingsForm.address} onChange={e => setSettingsForm(f => ({ ...f, address: e.target.value }))} placeholder="Rue principale, Dakar, Sénégal" />
                    </div>
                    <div>
                      <label htmlFor="settings-description" className="text-sm font-medium block mb-1.5">Description de la boutique</label>
                      <textarea id="settings-description" rows={3} className="w-full px-3 py-2.5 border border-border rounded-xl bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none" value={settingsForm.description} onChange={e => setSettingsForm(f => ({ ...f, description: e.target.value }))} placeholder="Décrivez votre boutique..." />
                    </div>
                    <Button onClick={handleSaveSettings} disabled={isSavingSettings} className="bg-accent text-white h-11 rounded-xl font-bold">
                      {isSavingSettings ? <Loader2 className="animate-spin" size={18} /> : <><Save size={16} className="mr-2" /> Enregistrer</>}
                    </Button>
                  </div>
                </div>

                {/* Paiements */}
                <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-border">
                    <h2 className="font-bold text-lg">Paiements & Retraits</h2>
                  </div>
                  <div className="p-6 space-y-4">
                    {/* Solde disponible + demande de retrait */}
                    <div className="bg-slate-900 text-white rounded-xl p-5 flex items-center justify-between flex-wrap gap-4">
                      <div>
                        <p className="text-[10px] font-black uppercase text-slate-400">Solde disponible</p>
                        <p className="text-2xl font-black">{fp(walletData?.balance_usd || 0)}</p>
                      </div>
                      <div className="flex items-end gap-2 flex-wrap">
                        <div>
                          <label htmlFor="payout-amount" className="text-[10px] font-black uppercase text-slate-400 mb-1 block">Montant ($)</label>
                          <Input id="payout-amount" type="number" step="0.01" placeholder="0.00" value={payoutAmount}
                            onChange={e => setPayoutAmount(e.target.value)} className="w-28 h-9 text-sm" />
                        </div>
                        <div>
                          <label htmlFor="payout-method" className="text-[10px] font-black uppercase text-slate-400 mb-1 block">Mode</label>
                          <select id="payout-method" value={payoutMethod} onChange={e => setPayoutMethod(e.target.value)}
                            className="h-9 px-2 rounded-md border border-input bg-background text-sm text-foreground">
                            <option value="wave">Wave</option>
                            <option value="orange_money">Orange Money</option>
                            <option value="bank_transfer">Virement bancaire</option>
                          </select>
                        </div>
                        <Button onClick={handleRequestPayout} disabled={isRequestingPayout} className="bg-accent text-white h-9 font-bold text-xs">
                          {isRequestingPayout ? <Loader2 className="animate-spin" size={14} /> : 'Demander un retrait'}
                        </Button>
                      </div>
                    </div>

                    {(walletData?.payout_requests || []).length > 0 && (
                      <div className="border border-border rounded-xl overflow-hidden">
                        <div className="px-4 py-2 bg-slate-50 text-[10px] font-black uppercase text-slate-400">Historique des demandes</div>
                        <div className="divide-y divide-border">
                          {walletData.payout_requests.slice(0, 5).map((p: any) => (
                            <div key={p.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                              <span>{fp(p.amount_usd)} — {p.method}</span>
                              <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${
                                p.status === 'paid' ? 'bg-green-50 text-green-700' :
                                p.status === 'rejected' ? 'bg-red-50 text-red-700' : 'bg-yellow-50 text-yellow-700'
                              }`}>{p.status === 'paid' ? 'Payé' : p.status === 'rejected' ? 'Rejeté' : 'En attente'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex items-start gap-3 p-4 bg-blue-50 rounded-xl">
                      <AlertCircle size={18} className="text-blue-500 mt-0.5 shrink-0" />
                      <p className="text-sm text-blue-700">Configurez vos coordonnées de retrait. Modes supportés : Wave, Orange Money, virement bancaire.</p>
                    </div>
                    <div>
                      <label htmlFor="settings-wave-phone" className="text-sm font-medium block mb-1.5">Numéro Wave / Orange Money</label>
                      <Input id="settings-wave-phone" type="tel" placeholder="+221 77 000 00 00" />
                    </div>
                    <div>
                      <label htmlFor="settings-iban" className="text-sm font-medium block mb-1.5">IBAN (virement bancaire)</label>
                      <Input id="settings-iban" placeholder="SN28 XXXX XXXX XXXX XXXX XXXX" />
                    </div>
                    <Button className="bg-accent text-white h-11 rounded-xl font-bold">
                      <Save size={16} className="mr-2" /> Enregistrer le mode de retrait
                    </Button>
                  </div>
                </div>

                {/* Livraison */}
                <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-border">
                    <h2 className="font-bold text-lg">Options de livraison</h2>
                  </div>
                  <div className="p-6 space-y-3">
                    {[
                      { label: 'Livraison nationale', sub: "Dans votre pays d'origine" },
                      { label: 'Livraison internationale MIAD Express', sub: 'Express panafricain (60% du prix produit)' },
                      { label: 'Retrait en boutique', sub: 'Le client vient chercher sa commande' },
                    ].map((item, i) => (
                      <div key={item.label} className={`flex items-center justify-between py-3 ${i < 2 ? 'border-b border-border' : ''}`}>
                        <div>
                          <p className="text-sm font-medium">{item.label}</p>
                          <p className="text-xs text-muted-foreground">{item.sub}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setShippingToggles(t => t.map((v, j) => j === i ? !v : v))}
                          aria-label={`${shippingToggles[i] ? 'Désactiver' : 'Activer'} ${item.label}`}
                          className={`w-11 h-6 rounded-full flex items-center px-0.5 transition-colors ${shippingToggles[i] ? 'bg-accent justify-end' : 'bg-slate-200 justify-start'}`}
                        >
                          <div className="w-5 h-5 bg-white rounded-full shadow-sm" />
                        </button>
                      </div>
                    ))}
                    <Button className="mt-2 bg-accent text-white h-11 rounded-xl font-bold w-full">
                      <Save size={16} className="mr-2" /> Enregistrer la livraison
                    </Button>
                  </div>
                </div>

                {/* Adresse d'expédition — livraison nationale Sénégal */}
                <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-border">
                    <h2 className="font-bold text-lg">Adresse d'expédition (livraison nationale)</h2>
                  </div>
                  <div className="p-6">
                    <VendorShippingAddressForm />
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

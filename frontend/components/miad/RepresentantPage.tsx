"use client"

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { Copy, Check, ArrowLeft, LogOut, Users, DollarSign, ShoppingBag, Store, Loader2, Star, Package, TrendingUp, Truck, Eye, Phone, ShieldCheck, Bell } from 'lucide-react'
import { toast } from 'sonner'
import { useCurrency } from '@/contexts/CurrencyContext'
import { CurrencySelector } from '@/components/miad/CurrencySelector'
import { RepMessages } from './RepMessages'
import { ShipmentManager, ShipmentOrder } from './ShipmentManager'
import { OrderDetailPanel } from './OrderDetailPanel'

interface RepVendor {
  id: number
  name: string
  email: string
  avatar: string
  products: number
  orders: number
  total: number
  phone: string
}

interface RepOrder {
  id: number
  number: string
  date: string
  status: string
  client: string
  email: string
  phone: string
  vendors: string[]
  total: number
  shipping_method: string
  tracking: string
  acknowledged?: boolean
  acknowledged_by?: string
  acknowledged_at?: string
}

interface RepClient {
  name: string
  email: string
  orders: number
  total: number
  date: string
}

interface RepData {
  success: boolean
  id: number
  name: string
  email: string
  avatar: string
  country_code: string
  country_name: string
  whatsapp: string
  referral_code: string
  commission_rate: number
  referral_earned: number
  referral_clients: RepClient[]
  referral_orders: number
  vendors: RepVendor[]
  vendors_count: number
  recent_orders: RepOrder[]
  zone_orders: number
  zone_total: number
  zone_clients: number
  unread_messages: number
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  processing: { label: 'En cours',   color: 'bg-blue-100 text-blue-700' },
  completed:  { label: 'Terminée',   color: 'bg-green-100 text-green-700' },
  'on-hold':  { label: 'En attente', color: 'bg-yellow-100 text-yellow-700' },
  pending:    { label: 'Nouveau',    color: 'bg-orange-100 text-orange-700' },
  cancelled:  { label: 'Annulée',    color: 'bg-red-100 text-red-700' },
}

type Tab = 'overview' | 'vendors' | 'orders' | 'parrainage' | 'messages' | 'logistique'

const handleLogout = () => {
  localStorage.removeItem('miad_token'); localStorage.removeItem('miad_user'); localStorage.removeItem('miad_role')
  window.location.href = '/'
}

export function RepresentantPage() {
  const router = useRouter()
  const [data, setData]           = useState<RepData | null>(null)
  const [isLoading, setIsLoading]   = useState(true)
  const [redirecting, setRedirecting] = useState(false)
  const [copied, setCopied]         = useState(false)
  const { formatPrice: fp }         = useCurrency()
  const [ackLoading, setAckLoading] = useState<number | null>(null)
  const [ackDone, setAckDone]     = useState<Set<number>>(new Set())
  const [tab, setTab]         = useState<Tab>('overview')
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null)

  useEffect(() => {
    const token = localStorage.getItem('miad_token')
    const role  = localStorage.getItem('miad_role')

    if (!token) {
      sessionStorage.setItem('miad_login_return_url', '/espace-representant')
      setRedirecting(true)
      setIsLoading(false)
      router.replace('/Login')
      return
    }
    if (role !== 'representant') {
      setRedirecting(true)
      setIsLoading(false)
      router.replace('/')
      return
    }

    fetch('/api/representant/me', { headers: { 'Authorization': `Bearer ${token}` } })
      .then(async r => {
        if (r.status === 401) {
          localStorage.removeItem('miad_token'); localStorage.removeItem('miad_user'); localStorage.removeItem('miad_role')
          router.replace('/Login'); return null
        }
        if (r.status === 403) { router.replace('/'); return null }
        return r.json()
      })
      .then(d => {
        if (d?.success) {
          // Filet de sécurité : le backend (repDashboard) construit déjà ces
          // tableaux, mais un service tiers injoignable (vendor-svc/order-svc)
          // au moment de l'agrégation peut laisser un champ absent plutôt que
          // vide — mieux vaut un tableau vide affiché qu'un crash sur
          // data.recent_orders.length d'un champ undefined.
          setData({
            ...d,
            vendors: d.vendors ?? [],
            recent_orders: d.recent_orders ?? [],
            referral_clients: d.referral_clients ?? [],
          })
          import('@/lib/push').then(({ initPushNotifications, saveTokenToServer }) => {
            initPushNotifications().then(token => {
              if (token) saveTokenToServer(token, d.id)
            })
          })
        }
      })
      .catch(() => toast.error('Erreur de chargement des données.'))
      .finally(() => setIsLoading(false))
  }, [router])

  const copyReferralLink = async () => {
    if (!data) return
    const BASE = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.miadmarket.com'
    await navigator.clipboard.writeText(`${BASE}/?ref=${data.referral_code}`)
    setCopied(true)
    toast.success('Lien copié !')
    setTimeout(() => setCopied(false), 2500)
  }

  const acknowledgeOrder = async (orderId: number) => {
    setAckLoading(orderId)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch(`/api/orders/${orderId}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        setAckDone(prev => new Set(prev).add(orderId))
        toast.success('Commande prise en charge !')
      } else {
        toast.error('Erreur lors de la prise en charge')
      }
    } catch {
      toast.error('Erreur réseau')
    }
    setAckLoading(null)
  }

  if (redirecting) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Loader2 size={32} className="mx-auto mb-4 text-primary animate-spin" />
          <p className="font-bold text-foreground">Redirection vers la connexion…</p>
          <p className="text-sm text-muted-foreground mt-1">Vous devez être connecté pour accéder à cet espace.</p>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Loader2 size={32} className="mx-auto mb-4 text-primary animate-spin" />
          <p className="text-muted-foreground font-medium">Chargement de votre espace…</p>
        </div>
      </div>
    )
  }
  if (!data) return null

  const BASE = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.miadmarket.com'
  const referralLink = `${BASE}/?ref=${data.referral_code}`

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview',    label: 'Vue d\'ensemble' },
    { id: 'vendors',     label: 'Vendeurs',    count: data.vendors_count },
    { id: 'orders',      label: 'Commandes',   count: data.zone_orders },
    { id: 'logistique',  label: 'Logistique' },
    { id: 'parrainage',  label: 'Parrainage',  count: data.referral_clients.length },
    { id: 'messages',    label: 'Messages',   count: data.unread_messages > 0 ? data.unread_messages : undefined },
  ]

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Header */}
      <header className="bg-card border-b border-border sticky top-0 z-40">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between max-w-6xl">
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => router.push('/')} aria-label="Retour" className="p-2 hover:bg-muted rounded-xl transition-colors">
              <ArrowLeft size={20} />
            </button>
            <div className="flex items-center gap-2">
              <Image src="/logo/logo.png" alt="MIAD" width={32} height={32} className="h-8 w-auto" />
              <div>
                <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest">Espace</p>
                <p className="text-sm font-black uppercase tracking-tight leading-none">Représentant</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 bg-muted/60 px-3 py-1.5 rounded-xl">
              <span className="text-xs font-bold text-muted-foreground">Zone :</span>
              <span className="text-xs font-black">{data.country_name}</span>
            </div>
            <CurrencySelector />
            <button
              type="button"
              onClick={() => setTab('messages')}
              className="relative p-2 hover:bg-muted rounded-xl transition-colors"
              title="Messages"
            >
              <Bell size={18} />
              {data.unread_messages > 0 && (
                <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[9px] font-black min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 leading-none">
                  {data.unread_messages > 9 ? '9+' : data.unread_messages}
                </span>
              )}
            </button>
            <button type="button" onClick={handleLogout} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-destructive transition-colors font-medium">
              <LogOut size={16} />
              <span className="hidden sm:block">Déconnexion</span>
            </button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-6xl">

        {/* Welcome */}
        <div className="mb-6 flex items-center gap-4">
          {data.avatar
            ? <Image src={data.avatar} alt={data.name} width={56} height={56} className="w-14 h-14 rounded-2xl object-cover border-2 border-border shadow-sm" />
            : <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center"><span className="text-xl font-black text-primary">{data.name.charAt(0).toUpperCase()}</span></div>
          }
          <div>
            <p className="text-sm text-muted-foreground font-medium">Bienvenue,</p>
            <h1 className="text-xl font-black tracking-tight">{data.name}</h1>
            <span className="inline-flex items-center gap-1.5 bg-primary/10 text-primary text-[11px] font-bold px-2.5 py-0.5 rounded-full mt-0.5">
              <Star size={10} fill="currentColor" /> Coordinateur {data.country_name}
            </span>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-muted/60 p-1 rounded-2xl mb-6 overflow-x-auto">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${tab === t.id ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {t.label}
              {t.count !== undefined && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-black ${tab === t.id ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── Tab : Vue d'ensemble ─────────────────────────────────────────── */}
        {tab === 'overview' && (
          <div className="space-y-6">
            {/* Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { icon: Store,      color: 'blue',   val: data.vendors_count, label: 'Vendeurs dans ma zone' },
                { icon: ShoppingBag,color: 'orange', val: data.zone_orders,   label: 'Commandes zone' },
                { icon: Users,      color: 'purple', val: data.zone_clients,  label: 'Clients acheteurs' },
                { icon: DollarSign, color: 'emerald',val: fp(data.zone_total), label: 'Chiffre d\'affaires zone' },
              ].map(({ icon: Icon, color, val, label }) => (
                <div key={label} className="bg-card rounded-2xl border border-border p-4 shadow-sm">
                  <div className={`w-10 h-10 rounded-xl bg-${color}-500/10 flex items-center justify-center mb-3`}>
                    <Icon size={18} className={`text-${color}-600`} />
                  </div>
                  <p className="text-2xl font-black">{val}</p>
                  <p className="text-xs text-muted-foreground font-medium mt-0.5">{label}</p>
                </div>
              ))}
            </div>

            {/* Dernières commandes */}
            <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
              <div className="p-5 border-b border-border flex items-center justify-between">
                <h2 className="font-black text-sm uppercase tracking-widest">Commandes récentes</h2>
                <button type="button" onClick={() => setTab('orders')} className="text-xs font-bold text-accent hover:underline">Voir tout</button>
              </div>
              {data.recent_orders.length === 0 ? (
                <div className="text-center py-10">
                  <ShoppingBag size={32} className="mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-sm text-muted-foreground font-medium">Aucune commande pour l'instant</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {data.recent_orders.slice(0, 5).map(order => {
                    const st = STATUS_LABELS[order.status] ?? { label: order.status, color: 'bg-muted text-muted-foreground' }
                    return (
                      <div key={order.id} className="px-5 py-3 flex items-center justify-between gap-4 hover:bg-muted/20 transition-colors">
                        <div className="min-w-0">
                          <p className="text-sm font-bold">#{order.number} — {order.client}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1 flex-wrap">
                            {order.vendors.join(', ')} · {order.date.slice(0, 10)}
                            <span className="inline-flex items-center gap-1 font-bold text-foreground/70">
                              <Truck size={11} /> {order.shipping_method}
                            </span>
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${st.color}`}>{st.label}</span>
                          <span className="text-sm font-black">{fp(order.total)}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Top vendeurs */}
            <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
              <div className="p-5 border-b border-border flex items-center justify-between">
                <h2 className="font-black text-sm uppercase tracking-widest">Top vendeurs de ma zone</h2>
                <button type="button" onClick={() => setTab('vendors')} className="text-xs font-bold text-accent hover:underline">Voir tout</button>
              </div>
              {data.vendors.length === 0 ? (
                <div className="text-center py-10">
                  <Store size={32} className="mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-sm text-muted-foreground font-medium">Aucun vendeur dans votre zone</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {data.vendors.toSorted((a, b) => b.total - a.total).slice(0, 4).map(v => (
                    <div key={v.id} className="px-5 py-3 flex items-center gap-3 hover:bg-muted/20 transition-colors">
                      <Image src={v.avatar} alt={v.name} width={36} height={36} className="w-9 h-9 rounded-xl object-cover border border-border" onError={e => { (e.target as HTMLImageElement).style.display='none' }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold truncate">{v.name}</p>
                        <p className="text-xs text-muted-foreground">{v.products} produits · {v.orders} commandes</p>
                      </div>
                      <span className="text-sm font-black shrink-0">{fp(v.total)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Tab : Vendeurs ───────────────────────────────────────────────── */}
        {tab === 'vendors' && (
          <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
            <div className="p-5 border-b border-border">
              <h2 className="font-black text-sm uppercase tracking-widest">Vendeurs — Zone {data.country_name}</h2>
              <p className="text-xs text-muted-foreground mt-1">{data.vendors_count} vendeur{data.vendors_count > 1 ? 's' : ''} dans votre zone</p>
            </div>
            {data.vendors.length === 0 ? (
              <div className="text-center py-16">
                <Store size={40} className="mx-auto text-muted-foreground/30 mb-3" />
                <p className="font-bold text-muted-foreground">Aucun vendeur dans votre zone</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-muted/40 border-b border-border">
                    <tr>
                      {['Boutique', 'Produits', 'Commandes', 'Chiffre d\'aff.', 'Contact'].map(h => (
                        <th key={h} className="text-left px-5 py-3 text-[10px] font-black uppercase tracking-widest text-muted-foreground">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.vendors.map(v => (
                      <tr key={v.id} className="hover:bg-muted/20 transition-colors">
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
                            <Image src={v.avatar} alt={v.name} width={36} height={36} className="w-9 h-9 rounded-xl object-cover border border-border" onError={e => { (e.target as HTMLImageElement).style.display='none' }} />
                            <div>
                              <p className="font-bold text-sm">{v.name}</p>
                              <p className="text-xs text-muted-foreground">{v.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-1 text-sm font-bold">
                            <Package size={13} className="text-muted-foreground" /> {v.products}
                          </div>
                        </td>
                        <td className="px-5 py-3.5 font-bold text-sm">{v.orders}</td>
                        <td className="px-5 py-3.5 font-black text-sm text-emerald-600">{fp(v.total)}</td>
                        <td className="px-5 py-3.5">
                          {v.phone ? (
                            <a href={`https://wa.me/${v.phone.replace(/\D/g,'')}`} target="_blank" rel="noopener noreferrer"
                              className="flex items-center gap-1 text-xs font-bold text-green-600 hover:underline">
                              <Phone size={12} /> WhatsApp
                            </a>
                          ) : <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Tab : Commandes ─────────────────────────────────────────────── */}
        {tab === 'orders' && (
          <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
            <div className="p-5 border-b border-border">
              <h2 className="font-black text-sm uppercase tracking-widest">Commandes de ma zone</h2>
              <p className="text-xs text-muted-foreground mt-1">{data.zone_orders} commandes · {fp(data.zone_total)} total · {data.zone_clients} clients distincts</p>
            </div>
            {data.recent_orders.length === 0 ? (
              <div className="text-center py-16">
                <ShoppingBag size={40} className="mx-auto text-muted-foreground/30 mb-3" />
                <p className="font-bold text-muted-foreground">Aucune commande pour l'instant</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-muted/40 border-b border-border">
                    <tr>
                      {['Commande', 'Client', 'Vendeur(s)', 'Livraison', 'Statut', 'Total', 'Tracking', ''].map(h => (
                        <th key={h} className="text-left px-5 py-3 text-[10px] font-black uppercase tracking-widest text-muted-foreground">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.recent_orders.map(order => {
                      const st = STATUS_LABELS[order.status] ?? { label: order.status, color: 'bg-muted text-muted-foreground' }
                      return (
                        <tr key={order.id} className="hover:bg-muted/20 transition-colors cursor-pointer" onClick={() => setSelectedOrderId(order.id)}>
                          <td className="px-5 py-3.5">
                            <p className="font-bold text-sm">#{order.number}</p>
                            <p className="text-xs text-muted-foreground">{order.date.slice(0, 10)}</p>
                          </td>
                          <td className="px-5 py-3.5">
                            <p className="font-semibold text-sm">{order.client}</p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              {order.phone && (
                                <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                                  <Phone size={10}/> {order.phone}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3.5 text-xs text-muted-foreground">{order.vendors.join(', ')}</td>
                          <td className="px-5 py-3.5">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${order.shipping_method.toLowerCase().includes('express') ? 'bg-accent/10 text-accent' : 'bg-muted text-muted-foreground'}`}>
                              <Truck size={10} /> {order.shipping_method}
                            </span>
                          </td>
                          <td className="px-5 py-3.5">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${st.color}`}>{st.label}</span>
                          </td>
                          <td className="px-5 py-3.5 font-black text-sm">{fp(order.total)}</td>
                          <td className="px-5 py-3.5 text-xs font-mono text-muted-foreground">
                            {order.tracking
                              ? <span className="flex items-center gap-1 text-primary font-semibold"><Truck size={11}/>{order.tracking}</span>
                              : <span className="text-muted-foreground/50">—</span>
                            }
                          </td>
                          <td className="px-4 py-3.5">
                            <div className="flex flex-col gap-1.5">
                              <button
                                type="button"
                                onClick={e => { e.stopPropagation(); setSelectedOrderId(order.id) }}
                                className="flex items-center gap-1 text-[11px] font-bold text-primary hover:underline whitespace-nowrap"
                              >
                                <Eye size={12} /> Détails
                              </button>
                              {(order.status === 'pending' || order.status === 'on-hold') && (
                                order.acknowledged || ackDone.has(order.id)
                                  ? <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-600 whitespace-nowrap">
                                      <ShieldCheck size={11} /> Pris en charge
                                    </span>
                                  : <button
                                      type="button"
                                      onClick={e => { e.stopPropagation(); acknowledgeOrder(order.id) }}
                                      disabled={ackLoading === order.id}
                                      className="flex items-center gap-1 text-[10px] font-bold text-orange-600 hover:text-orange-800 whitespace-nowrap disabled:opacity-40"
                                    >
                                      {ackLoading === order.id
                                        ? <Loader2 size={10} className="animate-spin" />
                                        : <ShieldCheck size={11} />}
                                      Prendre en charge
                                    </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Order detail modal */}
        {selectedOrderId && (
          <OrderDetailPanel orderId={selectedOrderId} onClose={() => setSelectedOrderId(null)} />
        )}

        {/* ── Tab : Parrainage ────────────────────────────────────────────── */}
        {tab === 'parrainage' && (
          <div className="space-y-6">
            {/* Referral card */}
            <div className="bg-gradient-to-br from-primary to-primary/75 text-primary-foreground rounded-3xl p-6 relative overflow-hidden shadow-lg shadow-primary/20">
              <div className="absolute -top-10 -right-10 w-40 h-40 rounded-full bg-white/10 pointer-events-none" />
              <div className="relative z-10">
                <p className="text-[10px] font-bold uppercase tracking-widest text-primary-foreground/60 mb-2">Votre lien de parrainage unique</p>
                <div className="flex items-center gap-3 bg-white/10 rounded-2xl p-3 mt-2">
                  <p className="flex-1 font-mono text-sm truncate text-primary-foreground/90">{referralLink}</p>
                  <button type="button" onClick={copyReferralLink} aria-label="Copier le lien de parrainage"
                    className="shrink-0 bg-white text-primary w-10 h-10 rounded-xl flex items-center justify-center hover:bg-white/90 transition-all active:scale-95 shadow-sm">
                    {copied ? <Check size={17} /> : <Copy size={17} />}
                  </button>
                </div>
                <div className="flex items-center gap-4 mt-3">
                  <p className="text-xs text-primary-foreground/60">Code : <span className="font-mono font-bold text-primary-foreground">{data.referral_code}</span></p>
                  <span className="text-primary-foreground/30">·</span>
                  <p className="text-xs text-primary-foreground/60">Commission : <span className="font-bold text-primary-foreground">{data.commission_rate}%</span> par vente</p>
                </div>
              </div>
            </div>

            {/* Parrainage stats */}
            <div className="grid grid-cols-3 gap-4">
              {[
                { icon: Users,      color: 'blue',   val: data.referral_clients.length, label: 'Clients recrutés' },
                { icon: ShoppingBag,color: 'orange', val: data.referral_orders,          label: 'Commandes générées' },
                { icon: TrendingUp, color: 'emerald',val: fp(data.referral_earned), label: 'Commissions gagnées' },
              ].map(({ icon: Icon, color, val, label }) => (
                <div key={label} className="bg-card rounded-2xl border border-border p-4 shadow-sm">
                  <div className={`w-10 h-10 rounded-xl bg-${color}-500/10 flex items-center justify-center mb-3`}>
                    <Icon size={18} className={`text-${color}-600`} />
                  </div>
                  <p className="text-2xl font-black">{val}</p>
                  <p className="text-xs text-muted-foreground font-medium mt-0.5">{label}</p>
                </div>
              ))}
            </div>

            {/* Clients recrutés */}
            <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
              <div className="p-5 border-b border-border">
                <h2 className="font-black text-sm uppercase tracking-widest">Clients recrutés via parrainage</h2>
              </div>
              {data.referral_clients.length === 0 ? (
                <div className="text-center py-12">
                  <Users size={36} className="mx-auto text-muted-foreground/30 mb-3" />
                  <p className="font-bold text-muted-foreground">Aucun client recruté pour l'instant</p>
                  <p className="text-xs text-muted-foreground mt-1">Partagez votre lien pour recruter</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-muted/40 border-b border-border">
                      <tr>
                        {['Client', 'Commandes', 'Total généré', 'Ma commission', 'Inscrit le'].map(h => (
                          <th key={h} className="text-left px-5 py-3 text-[10px] font-black uppercase tracking-widest text-muted-foreground">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.referral_clients.map((client) => (
                        <tr key={client.email} className="hover:bg-muted/20 transition-colors">
                          <td className="px-5 py-3.5">
                            <p className="font-semibold text-sm">{client.name}</p>
                            <p className="text-xs text-muted-foreground">{client.email}</p>
                          </td>
                          <td className="px-5 py-3.5 font-bold text-sm">{client.orders}</td>
                          <td className="px-5 py-3.5 font-bold text-sm">{fp(client.total)}</td>
                          <td className="px-5 py-3.5 font-bold text-sm text-emerald-600">+{fp(client.total * data.commission_rate / 100)}</td>
                          <td className="px-5 py-3.5 text-xs text-muted-foreground">
                            {new Date(client.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="p-4 bg-primary/5 border border-primary/15 rounded-2xl">
              <p className="text-xs font-black text-primary uppercase tracking-wider mb-2">Comment fonctionne le parrainage ?</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Partagez votre lien. Quand quelqu'un s'inscrit via ce lien et passe une commande, vous recevez
                automatiquement <strong className="text-foreground">{data.commission_rate}%</strong> du montant.
                Les commissions sont versées en fin de mois.
              </p>
            </div>
          </div>
        )}

        {/* ── Tab : Logistique ────────────────────────────────────────── */}
        {tab === 'logistique' && (
          <div className="space-y-6">
            <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
              <div className="p-5 border-b border-border flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Truck size={18} className="text-primary" />
                </div>
                <div>
                  <h2 className="font-black text-sm uppercase tracking-widest">Gestion logistique</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Assignez des numéros de suivi, générez des étiquettes et suivez vos expéditions.
                  </p>
                </div>
              </div>
              <div className="p-5">
                <ShipmentManager
                  orders={data.recent_orders.map((o): ShipmentOrder => ({
                    id: o.id,
                    number: o.number,
                    date: o.date,
                    status: o.status,
                    client: o.client,
                    email: o.email,
                    phone: o.phone,
                    vendors: o.vendors,
                    total: o.total,
                    tracking: o.tracking,
                  }))}
                />
              </div>
            </div>
          </div>
        )}

        {/* ── Tab : Messages ──────────────────────────────────────────── */}
        {tab === 'messages' && (
          <RepMessages
            repId={data.id}
            repName={data.name}
            repAvatar={data.avatar || ''}
          />
        )}
      </main>
    </div>
  )
}

"use client"

import { useMemo, useState } from 'react'
import Image from 'next/image'
import useSWR from 'swr'
import { useCurrency } from '@/contexts/CurrencyContext'
import {
  X, Package, MapPin, CreditCard, Store, Loader2, Wallet, CheckCircle2,
} from 'lucide-react'
import { MobileMoneyDirectForm } from './MobileMoneyDirectForm'

// ClientOrderDetail — détail d'une commande GROUPÉE, côté CLIENT.
//
// Comble deux trous signalés le 2026-09-01 :
//  1. Depuis "Mon Historique", une commande n'était pas cliquable : le
//     client ne voyait ni le découpage par boutique, ni les images des
//     produits. Ce panneau regroupe les line_items par vendor_name et
//     affiche la vignette de chaque produit.
//  2. Si le paiement Mobile Money n'a jamais abouti (statut
//     pending_payment / payment_expired), un bouton "Reprendre le
//     paiement" monte MobileMoneyDirectForm (le même composant qu'au
//     checkout, qui gère opérateur + numéro + polling) — le endpoint
//     /api/orders/{id}/mobile-money-deposit relance le dépôt côté
//     agrégateur pour la commande déjà créée.

interface LineItem {
  product_id?: number
  name: string
  quantity: number
  price: string
  total: string
  image?: string
  vendor_id?: number
  vendor_name?: string
}

interface ClientOrder {
  id: number
  number: string
  status: string
  payment_status?: string
  payment_method?: string
  payment_method_title?: string
  date_created: string
  total: string
  shipping_total?: string
  currency_symbol?: string
  line_items: LineItem[]
  shipping: {
    first_name: string; last_name: string
    address_1: string; address_2?: string
    city: string; state?: string; postcode?: string
    country: string; phone?: string
  }
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pending_payment: { label: 'En attente de paiement', color: 'bg-orange-100 text-orange-800' },
  payment_expired: { label: 'Paiement expiré',        color: 'bg-red-100 text-red-700' },
  paid:            { label: 'Payé',                    color: 'bg-green-100 text-green-800' },
  processing:      { label: 'En préparation',          color: 'bg-blue-100 text-blue-800' },
  shipped:         { label: 'Expédié',                 color: 'bg-blue-100 text-blue-800' },
  delivered:       { label: 'Livré',                   color: 'bg-green-100 text-green-800' },
  completed:       { label: 'Terminée',                color: 'bg-green-100 text-green-800' },
  cancelled:       { label: 'Annulée',                 color: 'bg-gray-100 text-gray-600' },
  refunded:        { label: 'Remboursée',              color: 'bg-purple-100 text-purple-800' },
  partially_paid:  { label: 'Partiellement payée',     color: 'bg-orange-100 text-orange-800' },
  mixed:           { label: 'Statut mixte',            color: 'bg-gray-100 text-gray-600' },
}

const orderFetcher = async ([url, token]: [string, string]): Promise<ClientOrder> => {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const d = await r.json()
  if (!d.order) throw new Error(d.error || 'Erreur')
  return d.order
}

interface Props {
  orderId: number
  onClose: () => void
}

export function ClientOrderDetail({ orderId, onClose }: Props) {
  const { formatPrice: fp } = useCurrency()
  const token = typeof window !== 'undefined' ? localStorage.getItem('miad_token') : null
  const { data: order, isLoading, error: swrError, mutate } = useSWR<ClientOrder>(
    token ? [`/api/orders/${orderId}`, token] : null,
    orderFetcher
  )
  const error = swrError ? (swrError.message || 'Erreur réseau') : ''
  const [payingMobileMoney, setPayingMobileMoney] = useState(false)
  const [paid, setPaid] = useState(false)

  const groups = useMemo(() => {
    const map = new Map<string, { name: string; items: LineItem[]; subtotal: number }>()
    for (const it of order?.line_items || []) {
      const key = String(it.vendor_id ?? it.vendor_name ?? 'boutique')
      const g = map.get(key) || { name: it.vendor_name || 'Boutique', items: [], subtotal: 0 }
      g.items.push(it)
      g.subtotal += parseFloat(it.total || '0') || 0
      map.set(key, g)
    }
    return Array.from(map.values())
  }, [order])

  const st = order ? (STATUS_LABEL[order.status] ?? { label: order.status, color: 'bg-gray-100 text-gray-600' }) : null

  // Reprise de paiement : seulement Mobile Money (pawapay) non abouti.
  const canResumePayment =
    !!order &&
    (order.payment_status === 'pending_payment' || order.payment_status === 'payment_expired' ||
     order.status === 'pending_payment' || order.status === 'payment_expired') &&
    order.payment_method === 'pawapay'

  const buyerName = order ? `${order.shipping.first_name} ${order.shipping.last_name}`.trim() : ''

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-4 bg-black/50 backdrop-blur-sm"
      role="button"
      tabIndex={0}
      aria-label="Fermer"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onClose() }}
    >
      <div className="bg-background w-full md:max-w-2xl max-h-[92vh] md:max-h-[85vh] rounded-t-3xl md:rounded-3xl flex flex-col overflow-hidden shadow-2xl">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border shrink-0">
          <div className="flex-1 min-w-0">
            {isLoading ? (
              <div className="h-5 w-32 bg-muted animate-pulse rounded" />
            ) : order ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="font-black text-base">Commande #{order.number}</h2>
                  {st && <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${st.color}`}>{st.label}</span>}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {new Date(order.date_created).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })}
                </p>
              </>
            ) : null}
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" className="w-8 h-8 rounded-xl hover:bg-muted flex items-center justify-center transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && (
            <div className="flex items-center justify-center py-20">
              <Loader2 size={28} className="animate-spin text-primary" />
            </div>
          )}
          {error && (
            <div className="text-center py-16 text-muted-foreground">
              <p className="font-bold">{error}</p>
            </div>
          )}

          {order && (
            <div className="p-5 space-y-5">

              {/* Reprise de paiement Mobile Money */}
              {canResumePayment && !paid && (
                payingMobileMoney ? (
                  <div className="border border-border rounded-2xl p-4">
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-3">
                      Finaliser le paiement Mobile Money
                    </p>
                    <MobileMoneyDirectForm
                      aggregator="pawapay"
                      orderId={order.id}
                      countryISO2={order.shipping.country || 'sn'}
                      phoneHint={order.shipping.phone || ''}
                      customerName={buyerName}
                      onSuccess={() => {
                        setPaid(true)
                        setPayingMobileMoney(false)
                        mutate()
                      }}
                      onFailure={() => { /* le formulaire affiche déjà l'erreur */ }}
                      onNeedsFormRestart={() => setPayingMobileMoney(false)}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setPayingMobileMoney(true)}
                    className="w-full flex items-center justify-center gap-2 h-12 bg-accent text-white rounded-2xl font-bold text-sm hover:bg-accent/90 transition-all"
                  >
                    <Wallet size={16} /> Reprendre le paiement Mobile Money
                  </button>
                )
              )}
              {paid && (
                <div className="flex items-center justify-center gap-2 h-11 bg-green-50 border border-green-200 text-green-700 rounded-2xl font-bold text-sm">
                  <CheckCircle2 size={15} /> Paiement confirmé
                </div>
              )}

              {/* Produits regroupés par boutique */}
              {groups.map((g, gi) => (
                <div key={gi} className="bg-card border border-border rounded-2xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                    <Store size={14} className="text-primary" />
                    <p className="text-[11px] font-black uppercase tracking-widest text-muted-foreground flex-1 truncate">
                      {g.name}
                    </p>
                    <span className="text-xs font-bold text-muted-foreground">{fp(g.subtotal)}</span>
                  </div>
                  <div className="divide-y divide-border">
                    {g.items.map((item, ii) => (
                      <div key={ii} className="flex items-center gap-3 px-4 py-3">
                        {item.image ? (
                          <div className="relative w-14 h-14 rounded-xl overflow-hidden shrink-0 border border-border">
                            <Image src={item.image} alt={item.name} fill sizes="56px" className="object-cover" />
                          </div>
                        ) : (
                          <div className="w-14 h-14 rounded-xl bg-muted flex items-center justify-center shrink-0">
                            <Package size={18} className="text-muted-foreground/50" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm line-clamp-2">{item.name}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {fp(parseFloat(item.price || '0'))} × {item.quantity}
                          </p>
                        </div>
                        <p className="font-black text-sm shrink-0">{fp(parseFloat(item.total || '0'))}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {/* Récapitulatif */}
              <div className="bg-muted/20 border border-border rounded-2xl px-4 py-3 space-y-1.5">
                {order.shipping_total && parseFloat(order.shipping_total) > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Livraison</span>
                    <span>{fp(parseFloat(order.shipping_total))}</span>
                  </div>
                )}
                <div className="flex justify-between font-black text-sm pt-1 border-t border-border mt-1">
                  <span>Total</span>
                  <span className="text-primary">{fp(parseFloat(order.total || '0'))}</span>
                </div>
              </div>

              {/* Adresse de livraison */}
              <div className="bg-muted/40 rounded-2xl p-4 space-y-1.5">
                <div className="flex items-center gap-2 mb-1">
                  <MapPin size={14} className="text-primary" />
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Livraison</p>
                </div>
                <p className="font-bold text-sm">{buyerName}</p>
                <p className="text-xs text-muted-foreground">
                  {order.shipping.address_1}{order.shipping.address_2 ? `, ${order.shipping.address_2}` : ''}
                </p>
                <p className="text-xs text-muted-foreground">
                  {[order.shipping.city, order.shipping.state, order.shipping.postcode].filter(Boolean).join(', ')}
                </p>
                <p className="text-xs font-semibold">{order.shipping.country}</p>
                {order.shipping.phone && <p className="text-xs text-muted-foreground">{order.shipping.phone}</p>}
              </div>

              {/* Paiement */}
              <div className="flex items-center gap-3 px-4 py-3 bg-muted/40 rounded-2xl">
                <CreditCard size={14} className="text-muted-foreground shrink-0" />
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Paiement</p>
                  <p className="text-sm font-semibold mt-0.5">
                    {order.payment_method_title || order.payment_method || '—'}
                  </p>
                </div>
              </div>

            </div>
          )}
        </div>
      </div>
    </div>
  )
}

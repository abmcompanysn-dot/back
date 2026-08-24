"use client"

import { useState } from 'react'
import Image from 'next/image'
import { useCurrency } from '@/contexts/CurrencyContext'
import {
  Truck, Package, Search, Check, X, Loader2, MapPin,
  ExternalLink, RefreshCw, ChevronRight, Phone,
} from 'lucide-react'
import { toast } from 'sonner'
import { TrackingTimeline, TrackingData } from './TrackingTimeline'

export interface ShipmentOrder {
  id: number
  number: string
  date: string
  status: string
  client: string
  email: string
  phone?: string
  vendors?: string[]
  total: number
  tracking?: string
  carrier?: string
  // Optional WooCommerce full-order fields
  line_items?: any[]
  shipping?: any
  billing?: any
  meta_data?: any[]
}

interface ShipmentManagerProps {
  orders: ShipmentOrder[]
  onOrderUpdated?: (orderId: number, trackingNumber: string, carrier: string) => void
}

const CARRIERS = ['DHL', 'FedEx', 'MIAD Express', 'Colissimo', 'UPS', 'Sendit', 'Chronopost', 'Autre']

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  processing: { label: 'En cours',   color: 'bg-blue-100 text-blue-700' },
  completed:  { label: 'Livré',      color: 'bg-green-100 text-green-700' },
  'on-hold':  { label: 'En attente', color: 'bg-yellow-100 text-yellow-700' },
  pending:    { label: 'Nouveau',    color: 'bg-orange-100 text-orange-700' },
  cancelled:  { label: 'Annulée',    color: 'bg-red-100 text-red-700' },
  shipped:    { label: 'Expédié',    color: 'bg-indigo-100 text-indigo-700' },
}

export function ShipmentManager({ orders, onOrderUpdated }: ShipmentManagerProps) {
  const { formatPrice: fp } = useCurrency()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ShipmentOrder | null>(null)
  const [trackingInput, setTrackingInput] = useState('')
  const [carrierInput, setCarrierInput] = useState('DHL')
  const [isSaving, setIsSaving] = useState(false)
  const [isTracking, setIsTracking] = useState(false)
  const [trackingData, setTrackingData] = useState<TrackingData | null>(null)
  const [dhlLabelUrl, setDhlLabelUrl] = useState('')
  const [dhlWaybillUrl, setDhlWaybillUrl] = useState('')

  const filtered = orders.filter(o => {
    const q = search.toLowerCase()
    if (!q) return true
    return (
      o.number?.toLowerCase().includes(q) ||
      String(o.id).includes(q) ||
      o.client?.toLowerCase().includes(q) ||
      o.email?.toLowerCase().includes(q) ||
      o.tracking?.toLowerCase().includes(q)
    )
  })

  const openOrder = (order: ShipmentOrder) => {
    const meta        = order.meta_data || []
    const dhlTracking = meta.find((m: any) => m.key === '_miad_dhl_tracking_number')?.value || ''
    const labelUrl    = meta.find((m: any) => m.key === '_miad_dhl_label_url')?.value || ''
    const waybillUrl  = meta.find((m: any) => m.key === '_miad_dhl_waybill_doc_url')?.value || ''
    setSelected(order)
    setTrackingInput(order.tracking || dhlTracking || '')
    setCarrierInput('DHL')
    setDhlLabelUrl(labelUrl)
    setDhlWaybillUrl(waybillUrl)
    setTrackingData(null)
  }

  const saveTracking = async () => {
    if (!selected || !trackingInput.trim()) return
    setIsSaving(true)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch('/api/tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          orderId: selected.id,
          trackingNumber: trackingInput.trim(),
          carrier: carrierInput,
        }),
      })
      if (!res.ok) throw new Error()
      toast.success('N° de suivi enregistré !')
      const updatedOrder = { ...selected, tracking: trackingInput.trim(), carrier: carrierInput }
      setSelected(updatedOrder)
      onOrderUpdated?.(selected.id, trackingInput.trim(), carrierInput)
    } catch {
      toast.error('Erreur lors de la sauvegarde')
    }
    setIsSaving(false)
  }

  const fetchTracking = async () => {
    const num = trackingInput.trim() || selected?.tracking
    if (!num) return
    setIsTracking(true)
    try {
      const res = await fetch(`/api/tracking/${encodeURIComponent(num)}`, { method: 'POST' })
      const data = await res.json()
      setTrackingData({ ...data, carrier: data.carrier || carrierInput })
    } catch {
      setTrackingData({
        trackingNumber: num,
        carrier: carrierInput,
        status: 'in_transit',
        events: [],
      })
    }
    setIsTracking(false)
  }

  if (orders.length === 0) {
    return (
      <div className="text-center py-14">
        <Package size={38} className="mx-auto text-muted-foreground/25 mb-3" />
        <p className="font-bold text-muted-foreground">Aucune commande à gérer</p>
      </div>
    )
  }

  /* ── Order detail view ─────────────────────────────────────────── */
  if (selected) {
    const st = STATUS_LABELS[selected.status] ?? { label: selected.status, color: 'bg-muted text-muted-foreground' }
    const existingTracking = selected.tracking || ''

    return (
      <div className="space-y-5">
        {/* Back + order header */}
        <div className="flex items-center gap-3">
          <button type="button" aria-label="Fermer" onClick={() => setSelected(null)} className="p-2 hover:bg-muted rounded-xl transition-colors shrink-0">
            <X size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <p className="font-black">Commande #{selected.number || selected.id}</p>
            <p className="text-xs text-muted-foreground truncate">{selected.client} · {selected.email}</p>
          </div>
          <span className={`shrink-0 text-[10px] font-bold px-2 py-1 rounded-full ${st.color}`}>{st.label}</span>
        </div>

        {/* Transport management */}
        <div className="bg-card rounded-2xl border border-border p-5 space-y-4">
          <h3 className="font-black text-sm uppercase tracking-widest flex items-center gap-2">
            <Truck size={16} className="text-primary" /> Gestion du transport
          </h3>

          <div className="grid grid-cols-5 gap-3">
            <div className="col-span-2">
              <label htmlFor="shipment-carrier" className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest block mb-1.5">
                Transporteur
              </label>
              <select
                id="shipment-carrier"
                value={carrierInput}
                onChange={e => setCarrierInput(e.target.value)}
                className="w-full h-10 px-3 border border-border rounded-xl bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="col-span-3">
              <label htmlFor="shipment-tracking" className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest block mb-1.5">
                Numéro de suivi
              </label>
              <input
                id="shipment-tracking"
                type="text"
                value={trackingInput}
                onChange={e => setTrackingInput(e.target.value)}
                placeholder="Ex: 1Z999AA10123456784"
                className="w-full h-10 px-3 border border-border rounded-xl bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={saveTracking}
              disabled={isSaving || !trackingInput.trim()}
              className="flex-1 h-10 bg-primary text-primary-foreground rounded-xl font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-40 hover:bg-primary/90 transition-colors"
            >
              {isSaving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              Enregistrer
            </button>
            <button
              type="button"
              onClick={fetchTracking}
              disabled={isTracking || (!trackingInput.trim() && !existingTracking)}
              className="flex-1 h-10 bg-muted text-foreground rounded-xl font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-40 hover:bg-muted/80 transition-colors"
            >
              {isTracking ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Vérifier statut
            </button>
          </div>

          {/* DHL document links */}
          {(dhlLabelUrl || dhlWaybillUrl) && (
            <div className="flex gap-2 flex-wrap">
              {dhlLabelUrl && (
                <a
                  href={dhlLabelUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 h-9 px-3 bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-xl font-bold text-xs hover:bg-yellow-100 transition-colors"
                >
                  <ExternalLink size={13} /> Étiquette DHL
                </a>
              )}
              {dhlWaybillUrl && (
                <a
                  href={dhlWaybillUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 h-9 px-3 bg-muted border border-border text-foreground rounded-xl font-bold text-xs hover:bg-muted/80 transition-colors"
                >
                  <ExternalLink size={13} /> Bordereau DHL
                </a>
              )}
            </div>
          )}
        </div>

        {/* Tracking timeline */}
        {trackingData && (
          <div className="bg-card rounded-2xl border border-border p-5">
            <h3 className="font-black text-sm uppercase tracking-widest mb-5 flex items-center gap-2">
              <Truck size={16} className="text-primary" /> Suivi en temps réel
            </h3>
            <TrackingTimeline data={trackingData} />
          </div>
        )}

        {/* Delivery address */}
        {(selected.shipping || selected.billing) && (
          <div className="bg-muted/30 rounded-2xl p-5 border border-border">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-1.5">
              <MapPin size={12} /> Adresse de livraison
            </p>
            {(() => {
              const addr = selected.shipping || selected.billing || {}
              return (
                <>
                  <p className="text-sm font-bold">{addr.first_name} {addr.last_name}</p>
                  <p className="text-sm text-muted-foreground">{addr.address_1}</p>
                  {addr.address_2 && <p className="text-sm text-muted-foreground">{addr.address_2}</p>}
                  <p className="text-sm text-muted-foreground">{addr.city}, {addr.state} {addr.postcode}</p>
                  <p className="text-sm text-muted-foreground">{addr.country}</p>
                </>
              )
            })()}
            {selected.phone && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground mt-2">
                <Phone size={12} /> {selected.phone}
              </p>
            )}
          </div>
        )}

        {/* Order items (if available) */}
        {selected.line_items && selected.line_items.length > 0 && (
          <div className="bg-card rounded-2xl border border-border overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="font-black text-sm uppercase tracking-widest">Articles</h3>
            </div>
            <div className="divide-y divide-border">
              {selected.line_items.map((item: any) => (
                <div key={item.id} className="flex items-center gap-3 px-5 py-3">
                  <Image
                    src={item.image?.src || '/logo/logo.png'}
                    width={40}
                    height={40}
                    className="w-10 h-10 rounded-lg object-cover border border-border"
                    alt=""
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{item.name}</p>
                    <p className="text-xs text-muted-foreground">Qté : {item.quantity}</p>
                  </div>
                  <p className="font-black text-sm shrink-0">{fp(parseFloat(item.total || '0'))}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  /* ── Orders list view ──────────────────────────────────────────── */
  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Rechercher commande, client, n° de suivi…"
          className="w-full h-10 pl-9 pr-4 border border-border rounded-xl bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>

      <div className="space-y-2">
        {filtered.map(order => {
          const st = STATUS_LABELS[order.status] ?? { label: order.status, color: 'bg-muted text-muted-foreground' }
          const hasTracking = !!(order.tracking || (order.meta_data || []).find((m: any) => m.key === '_miad_dhl_tracking_number')?.value)

          return (
            <button
              key={order.id}
              type="button"
              onClick={() => openOrder(order)}
              className="w-full bg-card border border-border rounded-2xl p-4 hover:shadow-md transition-all text-left group"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <p className="font-black text-sm">#{order.number || order.id}</p>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${st.color}`}>{st.label}</span>
                    {hasTracking && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                        Suivi actif
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {order.client}
                    {order.tracking && (
                      <span className="ml-2 font-mono text-primary font-bold">
                        {order.carrier || 'DHL'} · {order.tracking}
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="text-right">
                    <p className="font-black text-sm">{fp(Number(order.total || 0))}</p>
                    <p className="text-[10px] text-muted-foreground">{String(order.date || '').slice(0, 10)}</p>
                  </div>
                  <ChevronRight size={16} className="text-muted-foreground group-hover:text-foreground" />
                </div>
              </div>
            </button>
          )
        })}

        {filtered.length === 0 && (
          <div className="text-center py-10 text-muted-foreground">
            <Search size={28} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm">Aucune commande trouvée</p>
          </div>
        )}
      </div>
    </div>
  )
}

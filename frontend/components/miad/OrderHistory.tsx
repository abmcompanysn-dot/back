"use client"

import { useState } from 'react'
import Image from 'next/image'
import { useCurrency } from '@/contexts/CurrencyContext'
import useSWR from 'swr'
import { Package, ChevronRight, Clock, CheckCircle, XCircle, ArrowLeft, ShoppingBag, Truck, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { TrackingTimeline, TrackingData } from './TrackingTimeline'
import { ClientOrderDetail } from './ClientOrderDetail'

type OrderHistoryProps = {
  onBack: () => void
  onContinueShopping: () => void
}

const fetcherWithAuth = (url: string) => {
  const token = localStorage.getItem('miad_token')
  return fetch(url, {
    headers: token ? { 'Authorization': `Bearer ${token}` } : {}
  }).then(res => {
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    const contentType = res.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) throw new TypeError("Réponse non-JSON reçue");
    return res.json();
  })
}

const getStatusStyle = (status: string) => {
  switch (status) {
    case 'completed': return { color: 'text-green-600 bg-green-50', icon: CheckCircle, label: 'Livré' }
    case 'processing': return { color: 'text-blue-600 bg-blue-50', icon: Clock, label: 'En cours' }
    case 'pending': return { color: 'text-orange-600 bg-orange-50', icon: Clock, label: 'Attente paiement' }
    default: return { color: 'text-muted-foreground bg-muted', icon: XCircle, label: status }
  }
}

export function OrderHistory({ onBack, onContinueShopping }: OrderHistoryProps) {
  const { formatPrice: fp } = useCurrency()
  const [trackingOrder, setTrackingOrder] = useState<any | null>(null)
  const [trackingData, setTrackingData] = useState<TrackingData | null>(null)
  const [isLoadingTracking, setIsLoadingTracking] = useState(false)
  // Détail d'une commande (regroupement par boutique + images + reprise
  // de paiement Mobile Money) — modale interne, comme le suivi ci-dessus.
  const [detailOrderId, setDetailOrderId] = useState<number | null>(null)

  const fetchTrackingForOrder = async (order: any) => {
    const meta = order.meta_data || []
    const trackingNumber = meta.find((m: any) => m.key === '_miad_tracking_number')?.value
    const carrier = meta.find((m: any) => m.key === '_miad_carrier')?.value
    if (!trackingNumber) return
    setTrackingOrder(order)
    setTrackingData(null)
    setIsLoadingTracking(true)
    try {
      const res = await fetch(`/api/tracking/${encodeURIComponent(trackingNumber)}`, { method: 'POST' })
      const data = await res.json()
      setTrackingData({ ...data, carrier: data.carrier || carrier || 'MIAD Express' })
    } catch {
      setTrackingData({ trackingNumber, carrier: carrier || 'MIAD Express', status: 'in_transit', events: [] })
    }
    setIsLoadingTracking(false)
  }

  const { data, isLoading } = useSWR('/api/orders', fetcherWithAuth)
  const orders = data?.orders || []

  return (
    <div className="flex flex-col min-h-screen bg-background animate-in fade-in duration-300">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-md border-b border-border px-4 py-4 flex items-center gap-4">
        <button type="button" onClick={onBack} aria-label="Retour" className="p-2 hover:bg-accent rounded-full transition-colors">
          <ArrowLeft size={22} />
        </button>
        <h1 className="text-lg font-bold">Mon Historique</h1>
      </div>

      {/* Détail de commande (par boutique + images + reprise paiement) */}
      {detailOrderId != null && (
        <ClientOrderDetail orderId={detailOrderId} onClose={() => setDetailOrderId(null)} />
      )}

      {/* Tracking modal */}
      {trackingOrder && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-background rounded-3xl w-full max-w-md max-h-[85vh] overflow-y-auto shadow-2xl">
            <div className="sticky top-0 bg-background/90 backdrop-blur-sm flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <p className="font-black">Suivi de commande</p>
                <p className="text-xs text-muted-foreground">Commande #{trackingOrder.id}</p>
              </div>
              <button
                type="button"
                onClick={() => { setTrackingOrder(null); setTrackingData(null) }}
                aria-label="Fermer le suivi"
                className="p-2 hover:bg-muted rounded-xl transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-5">
              {isLoadingTracking ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 size={28} className="animate-spin text-primary mb-3" />
                  <p className="text-sm text-muted-foreground">Récupération du suivi…</p>
                </div>
              ) : trackingData ? (
                <TrackingTimeline data={trackingData} />
              ) : null}
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 container mx-auto px-4 py-6">
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full rounded-2xl" />)}
          </div>
        ) : orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mb-4">
              <ShoppingBag size={40} className="text-muted-foreground opacity-20" />
            </div>
            <h2 className="text-xl font-bold mb-2">Aucune commande</h2>
            <p className="text-muted-foreground mb-8">Vous n'avez pas encore passé de commande sur MIAD Market.</p>
            <Button onClick={onContinueShopping} className="bg-accent text-white px-8 h-12 rounded-xl font-bold">
              Commencer mes achats
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {orders.map((order: any) => {
              const status = getStatusStyle(order.status)
              const meta = order.meta_data || []
              const trackingNumber = meta.find((m: any) => m.key === '_miad_tracking_number')?.value
              const carrier = meta.find((m: any) => m.key === '_miad_carrier')?.value

              // La liste renvoie des SOUS-commandes vendeur (order-svc
              // filtre customer_id sur vendor_id>0) : le détail attend le
              // PARENT (commande groupée), d'où parent_order_id en priorité.
              const parentId = order.parent_order_id || order.id

              return (
                <div
                  key={order.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDetailOrderId(parentId)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailOrderId(parentId) } }}
                  className="bg-card border border-border rounded-2xl p-4 hover:shadow-md transition-shadow group cursor-pointer text-left w-full"
                >
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <p className="text-[10px] font-black uppercase text-muted-foreground tracking-widest mb-1">Commande #{order.id}</p>
                      <p className="text-xs text-muted-foreground">{new Date(order.date_created).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'UTC' })}</p>
                    </div>
                    <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold ${status.color}`}>
                      <status.icon size={12} />
                      {status.label}
                    </div>
                  </div>

                  {trackingNumber && (
                    <div className="flex items-center gap-2 mb-3 bg-blue-50 border border-blue-100 rounded-xl px-3 py-2">
                      <Truck size={13} className="text-blue-600 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">{carrier || 'MIAD Express'}</p>
                        <p className="font-mono text-[11px] font-bold text-foreground truncate">{trackingNumber}</p>
                      </div>
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); fetchTrackingForOrder(order) }}
                        className="text-[10px] font-black text-blue-600 hover:text-blue-800 whitespace-nowrap"
                      >
                        Suivre →
                      </button>
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <div className="flex -space-x-3 overflow-hidden">
                      {order.line_items.slice(0, 3).map((item: any) => (
                        <div key={item.id} className="relative w-10 h-10 rounded-lg border-2 border-background bg-muted overflow-hidden">
                          <Image src={item.image?.src || '/logo/logo.png'} fill className="object-cover" alt="" />
                        </div>
                      ))}
                      {order.line_items.length > 3 && (
                        <div className="w-10 h-10 rounded-lg border-2 border-background bg-accent text-white flex items-center justify-center text-[10px] font-bold">
                          +{order.line_items.length - 3}
                        </div>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-black text-accent">{fp(order.total)}</p>
                      <div className="flex items-center gap-1 text-[10px] font-bold text-muted-foreground group-hover:text-foreground">
                        Détails <ChevronRight size={12} />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
            <Button onClick={onContinueShopping} variant="outline" className="w-full mt-6 py-6 border-dashed rounded-2xl font-bold">
               Continuer mes achats
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
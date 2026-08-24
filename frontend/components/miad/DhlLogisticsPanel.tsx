'use client'

import { useState } from 'react'
import { Truck, ExternalLink, CheckCircle2, PackageX, Loader2, RefreshCw, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

// Ces routes exigent desormais un Bearer admin cote serveur (audit du
// 2026-08-17 : elles n'avaient auparavant aucune verification d'auth alors
// qu'elles executent des actions couteuses/sensibles avec un secret serveur).
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('miad_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

interface DhlOrderListItem {
  id: number
  order_number: string
  date: string
  client_name: string
  country: string
  city: string
  status: string
  has_shipment: boolean
}

interface DhlOrderItem {
  name: string
  quantity: number
  weight: number
  price: number
}

interface DhlOrderDetail {
  order_number: string
  client_name: string
  client_email: string
  client_phone: string
  address?: { address_1: string; city: string; postcode: string; country: string }
  delivery_stage: string | null
  stage_label: string | null
  items: DhlOrderItem[]
  total_weight: number
  hs_code: string
  tracking_number: string
  estimated_rate: { cost: number; date: string } | null
  label_url: string
  waybill_doc_url: string
  invoice_url: string
  dhl_status: string
  dhl_events: { timestamp: string; description: string; location: string }[]
}

// Doit rester synchronisé avec miad_delivery_stages() dans
// woocommerce-snippets/miad-representative.php (pas d'endpoint dédié pour
// lister les étapes — ce sont les 5 mêmes depuis la mise en place du système).
const DELIVERY_STAGES = [
  { key: 'vendor_confirmed', label: '✅ Vendeur a confirmé' },
  { key: 'rep_received', label: '📥 Représentant a réceptionné' },
  { key: 'local_pickup', label: '🚚 Transport local récupéré' },
  { key: 'intl_handoff', label: '✈️ Remis transport international' },
  { key: 'delivered', label: '🎉 Livré au client' },
]

/**
 * Panneau "Logistique DHL" du dashboard admin headless (demandé le
 * 2026-07-20) : sélectionner une commande, voir ses infos + un prix estimé,
 * créer l'expédition DHL et suivre le colis, changer son étape de livraison
 * MIAD, sans passer par WP Admin. Consomme les endpoints REST /dhl/orders,
 * /dhl/order/{id}, /dhl/create-shipment (integration-dhl.php) et
 * /order/set-stage (miad-representative.php).
 */
export function DhlLogisticsPanel() {
  const [orders, setOrders] = useState<DhlOrderListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null)
  const [orderDetail, setOrderDetail] = useState<DhlOrderDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [shipmentMessage, setShipmentMessage] = useState<string | null>(null)
  const [selectedStage, setSelectedStage] = useState('')
  const [updatingStage, setUpdatingStage] = useState(false)
  const [weight, setWeight] = useState('')
  const [length, setLength] = useState('20')
  const [width, setWidth] = useState('20')
  const [height, setHeight] = useState('20')
  const [hsCode, setHsCode] = useState('')
  const [rate, setRate] = useState<{ cost: number; date: string } | null>(null)
  const [recalculating, setRecalculating] = useState(false)

  const loadOrders = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/dhl/orders', { headers: authHeaders() })
      const data = await res.json()
      if (data.ok) {
        setOrders(data.orders)
        setLoaded(true)
      } else {
        setError(data.error || 'Erreur de chargement des commandes')
      }
    } catch {
      setError('Impossible de joindre le serveur')
    } finally {
      setLoading(false)
    }
  }

  const openOrder = async (id: number) => {
    setSelectedOrderId(id)
    setOrderDetail(null)
    setShipmentMessage(null)
    setRate(null)
    setDetailLoading(true)
    try {
      const res = await fetch(`/api/admin/dhl/order/${id}`, { headers: authHeaders() })
      const data = await res.json()
      if (data.ok) {
        setOrderDetail(data)
        setSelectedStage(data.delivery_stage || '')
        setWeight(data.total_weight ? String(data.total_weight) : '0.5')
        setLength('20')
        setWidth('20')
        setHeight('20')
        setHsCode(data.hs_code || '')
        setRate(data.estimated_rate || null)
      } else {
        setError(data.error || 'Erreur de chargement de la commande')
      }
    } catch {
      setError('Impossible de joindre le serveur')
    } finally {
      setDetailLoading(false)
    }
  }

  const recalculateRate = async () => {
    if (!selectedOrderId || !weight) return
    setRecalculating(true)
    try {
      const params = new URLSearchParams({ order_id: String(selectedOrderId), weight, length, width, height, hsCode })
      const res = await fetch(`/api/admin/dhl/rate?${params.toString()}`, { headers: authHeaders() })
      const data = await res.json()
      if (data.ok) {
        setRate(data.rate)
      } else {
        toast.error(data.error || 'Tarif indisponible pour ces dimensions')
      }
    } catch {
      toast.error('Impossible de joindre le serveur')
    } finally {
      setRecalculating(false)
    }
  }

  const createShipment = async () => {
    if (!selectedOrderId) return
    setCreating(true)
    setShipmentMessage(null)
    try {
      const res = await fetch('/api/admin/dhl/create-shipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ order_id: selectedOrderId, plt: true, weight, length, width, height, hsCode }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(data.message || 'Expédition DHL créée')
        await openOrder(selectedOrderId)
        loadOrders()
      } else {
        const msg = data.message || data.error || "Échec de la création de l'expédition"
        setShipmentMessage(msg)
        toast.error(msg)
      }
    } catch {
      setShipmentMessage('Impossible de joindre le serveur')
    } finally {
      setCreating(false)
    }
  }

  const updateStage = async () => {
    if (!selectedOrderId || !selectedStage) return
    setUpdatingStage(true)
    try {
      const res = await fetch('/api/admin/orders/set-stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ order_id: selectedOrderId, stage: selectedStage }),
      })
      const data = await res.json()
      if (data.ok) {
        toast.success('Étape mise à jour : ' + data.label)
        await openOrder(selectedOrderId)
        loadOrders()
      } else {
        toast.error(data.error || "Échec de la mise à jour de l'étape")
      }
    } catch {
      toast.error('Impossible de joindre le serveur')
    } finally {
      setUpdatingStage(false)
    }
  }

  return (
    <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="p-6 border-b border-slate-100 flex justify-between items-center flex-wrap gap-3">
        <h2 className="font-black uppercase text-sm flex items-center gap-2">
          <Truck size={18} className="text-[#d40511]" /> Logistique DHL
        </h2>
        <Button variant="outline" size="sm" onClick={loadOrders} className="text-xs" disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin mr-1" /> : <RefreshCw size={14} className="mr-1" />}
          {loaded ? 'Rafraîchir les commandes' : 'Charger les commandes'}
        </Button>
      </div>

      {error && (
        <div className="mx-6 mt-4 flex items-center gap-2 text-xs font-bold text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {loaded && (
        <div className="grid md:grid-cols-2">
          <div className="border-r border-slate-100 max-h-[520px] overflow-y-auto">
            {orders.length === 0 ? (
              <p className="p-6 text-xs text-slate-400">Aucune commande trouvée.</p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-400 uppercase text-[9px] font-black sticky top-0">
                  <tr>
                    <th className="px-4 py-3">Commande</th>
                    <th className="px-4 py-3">Client / Pays</th>
                    <th className="px-4 py-3">Expédition</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {orders.map((o) => (
                    <tr
                      key={o.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openOrder(o.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') openOrder(o.id)
                      }}
                      className={`cursor-pointer hover:bg-slate-50/70 ${selectedOrderId === o.id ? 'bg-orange-50' : ''}`}
                    >
                      <td className="px-4 py-3">
                        <div className="font-bold">#{o.order_number}</div>
                        <div className="text-slate-400">{o.date}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-semibold">{o.client_name}</div>
                        <div className="text-slate-400">{o.city ? `${o.city}, ` : ''}{o.country}</div>
                      </td>
                      <td className="px-4 py-3">
                        {o.has_shipment ? (
                          <span className="inline-flex items-center gap-1 text-[9px] font-black bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                            <CheckCircle2 size={10} /> Expédié
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[9px] font-black bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">
                            <PackageX size={10} /> Non expédié
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="p-6">
            {!selectedOrderId && (
              <p className="text-xs text-slate-400">Sélectionnez une commande à gauche pour voir ses infos, son prix estimé, et créer ou suivre son expédition DHL.</p>
            )}
            {detailLoading && (
              <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Chargement...</div>
            )}
            {orderDetail && !detailLoading && (
              <div className="space-y-4">
                <div>
                  <h3 className="font-black text-sm">Commande #{orderDetail.order_number}</h3>
                  <p className="text-xs text-slate-500">{orderDetail.client_name} · {orderDetail.client_email} · {orderDetail.client_phone}</p>
                  <p className="text-xs text-slate-500">{orderDetail.address?.address_1}, {orderDetail.address?.city} {orderDetail.address?.postcode}, {orderDetail.address?.country}</p>
                  {orderDetail.stage_label && (
                    <p className="text-xs font-bold text-orange-600 mt-1">Étape MIAD actuelle : {orderDetail.stage_label}</p>
                  )}
                  <div className="flex items-center gap-2 mt-2">
                    <select
                      aria-label="Étape de livraison"
                      value={selectedStage}
                      onChange={(e) => setSelectedStage(e.target.value)}
                      className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 flex-1"
                    >
                      <option value="">-- Étape --</option>
                      {DELIVERY_STAGES.map((s) => (
                        <option key={s.key} value={s.key}>{s.label}</option>
                      ))}
                    </select>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={updateStage}
                      disabled={updatingStage || !selectedStage || selectedStage === orderDetail.delivery_stage}
                      className="text-xs"
                    >
                      {updatingStage ? <Loader2 size={14} className="animate-spin" /> : 'Mettre à jour'}
                    </Button>
                  </div>
                </div>

                <div className="text-xs">
                  <p className="font-black uppercase text-[9px] text-slate-400 mb-1">Articles</p>
                  <ul className="space-y-0.5">
                    {(orderDetail.items || []).map((it) => (
                      <li key={it.name} className="flex justify-between">
                        <span>{it.name} x{it.quantity}</span>
                        <span className="text-slate-400">{it.weight?.toFixed?.(2)} kg</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {!orderDetail.tracking_number ? (
                  <div className="bg-slate-50 rounded-2xl p-4 space-y-3">
                    <div>
                      <span className="font-black uppercase text-[9px] text-slate-400 block mb-1.5">Poids & dimensions du colis</span>
                      <div className="grid grid-cols-4 gap-1.5">
                        <label className="text-[9px] text-slate-500 col-span-4 sm:col-span-1">
                          Poids (kg)
                          <input type="number" step="0.1" min="0.1" value={weight} onChange={(e) => setWeight(e.target.value)} className="mt-0.5 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5" />
                        </label>
                        <label className="text-[9px] text-slate-500">
                          L (cm)
                          <input type="number" min="1" value={length} onChange={(e) => setLength(e.target.value)} className="mt-0.5 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5" />
                        </label>
                        <label className="text-[9px] text-slate-500">
                          l (cm)
                          <input type="number" min="1" value={width} onChange={(e) => setWidth(e.target.value)} className="mt-0.5 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5" />
                        </label>
                        <label className="text-[9px] text-slate-500">
                          H (cm)
                          <input type="number" min="1" value={height} onChange={(e) => setHeight(e.target.value)} className="mt-0.5 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5" />
                        </label>
                      </div>
                      <label className="text-[9px] text-slate-500 block mt-1.5">
                        Code HS (douane)
                        <input type="text" value={hsCode} onChange={(e) => setHsCode(e.target.value)} placeholder="ex: 85444290" className="mt-0.5 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 font-mono" />
                      </label>
                      <Button variant="outline" size="sm" onClick={recalculateRate} disabled={recalculating || !weight} className="w-full mt-2 text-xs">
                        {recalculating ? <Loader2 size={14} className="animate-spin mr-1" /> : null}
                        Recalculer le tarif
                      </Button>
                    </div>

                    {rate ? (
                      <p className="text-xs">
                        <span className="font-black uppercase text-[9px] text-slate-400 block mb-1">Prix DHL estimé</span>
                        <span className="font-black text-base">{rate.cost.toFixed(2)}</span>
                        {rate.date && <span className="text-slate-400 ml-1">(livraison estimée {rate.date})</span>}
                      </p>
                    ) : (
                      <p className="text-xs text-slate-400">Prix estimé indisponible (vérifiez les identifiants DHL, l'adresse client, ou recalculez).</p>
                    )}
                    <Button
                      onClick={createShipment}
                      disabled={creating}
                      className="w-full bg-[#d40511] hover:bg-[#b3040e] text-white font-black rounded-xl"
                    >
                      {creating ? <Loader2 size={16} className="animate-spin mr-2" /> : <Truck size={16} className="mr-2" />}
                      Créer l'expédition DHL
                    </Button>
                    {shipmentMessage && (
                      <p className="text-xs font-bold text-red-600">{shipmentMessage}</p>
                    )}
                  </div>
                ) : (
                  <div className="bg-slate-50 rounded-2xl p-4 space-y-3">
                    <p className="text-xs">
                      <span className="font-black uppercase text-[9px] text-slate-400 block mb-1">Suivi DHL</span>
                      <span className="font-mono font-bold text-[#d40511]">{orderDetail.tracking_number}</span>
                      {orderDetail.dhl_status && <span className="block text-slate-600 mt-1">{orderDetail.dhl_status}</span>}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {orderDetail.label_url && (
                        <a href={orderDetail.label_url} target="_blank" rel="noreferrer" className="text-[10px] font-bold px-2 py-1 rounded-lg bg-white border border-slate-200 flex items-center gap-1">
                          <ExternalLink size={10} /> Étiquette
                        </a>
                      )}
                      {orderDetail.waybill_doc_url && (
                        <a href={orderDetail.waybill_doc_url} target="_blank" rel="noreferrer" className="text-[10px] font-bold px-2 py-1 rounded-lg bg-white border border-slate-200 flex items-center gap-1">
                          <ExternalLink size={10} /> Waybill
                        </a>
                      )}
                      {orderDetail.invoice_url && (
                        <a href={orderDetail.invoice_url} target="_blank" rel="noreferrer" className="text-[10px] font-bold px-2 py-1 rounded-lg bg-white border border-slate-200 flex items-center gap-1">
                          <ExternalLink size={10} /> Facture
                        </a>
                      )}
                    </div>
                    {!!orderDetail.dhl_events?.length && (
                      <ul className="space-y-2 text-[11px] border-t border-slate-200 pt-3">
                        {orderDetail.dhl_events.map((ev) => (
                          <li key={ev.timestamp + ev.description} className="border-l-2 border-orange-300 pl-2">
                            <p className="font-semibold">{ev.description}</p>
                            <p className="text-slate-400">{ev.timestamp} {ev.location ? `— ${ev.location}` : ''}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

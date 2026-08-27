import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ApiError, api } from '../../lib/api'
import { StatusBadge } from '../../components/StatusBadge'
import { EmptyState } from '../../components/EmptyState'

interface OrderLine {
  product_id: number
  name: string
  quantity: number
  unit_price_usd: number
}

interface OrderFull {
  id: number
  reference: string
  customer_id: number
  vendor_id: number
  parent_order_id: number
  status: string
  lines: OrderLine[]
  subtotal_usd: number
  shipping_usd: number
  total_usd: number
  coupon_code: string
  created_at: string
}

// GroupedLineItem — un article de la commande groupée (GET /admin/api/
// orders/parent/{id}), enrichi côté order-svc (image, vendor_name) depuis
// le 2026-08-27 — auparavant ni l'un ni l'autre n'existait sur cet endpoint.
interface GroupedLineItem {
  product_id: number
  vendor_id: number
  vendor_name: string
  name: string
  quantity: number
  price: string
  total: string
  image: string
}

interface ShippingAddress {
  first_name?: string
  last_name?: string
  address_1?: string
  city?: string
  postcode?: string
  country?: string
  phone?: string
}

interface GroupedOrder {
  id: number
  number: string
  reference: string
  status: string
  total: string
  currency: string
  shipping_total: string
  line_items: GroupedLineItem[]
  date_created: string
  shipping_address?: ShippingAddress
}

interface OrderEvent {
  id: number
  event: string
  description: string
  actor: string
  occurred_at: string
}

const STATUS_OPTIONS = [
  'pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded',
]

// Chaîne de livraison MIAD (vendeur → représentant → transport local →
// international → livré) — distincte du statut commande ci-dessus.
// Choisir une étape déclenche automatiquement la notification WhatsApp
// client correspondante (voir loyalty-svc, event shipment.delivery_stage_changed).
const DELIVERY_STAGE_OPTIONS = [
  { value: '', label: '— non définie —' },
  { value: 'vendor_confirmed', label: 'Vendeur a confirmé' },
  { value: 'rep_received', label: 'Représentant a réceptionné' },
  { value: 'local_pickup', label: 'Transport local récupéré' },
  { value: 'intl_handoff', label: 'Remis au transport international' },
  { value: 'delivered', label: 'Livré au client' },
]

export function OrderDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [order, setOrder] = useState<OrderFull | null>(null)
  const [grouped, setGrouped] = useState<GroupedOrder | null>(null)
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newStatus, setNewStatus] = useState('')
  const [deliveryStage, setDeliveryStage] = useState('')
  const [stageBusy, setStageBusy] = useState(false)
  const [stageNotice, setStageNotice] = useState<string | null>(null)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const o = await api.get<OrderFull>(`/admin/api/orders/${id}`)
      setOrder(o)
      setNewStatus(o.status)
      const ev = await api.get<{ items: OrderEvent[] }>(`/admin/api/order-events/${id}`)
      setEvents(ev.items || [])
      // Vue groupée (commande unique côté acheteur, avec le détail par
      // boutique) — chargée séparément via parent_order_id, les actions
      // (statut/annulation/étape) continuent d'opérer sur la sous-commande
      // ${id} elle-même, jamais sur le groupe.
      if (o.parent_order_id) {
        try {
          const g = await api.get<GroupedOrder>(`/admin/api/orders/parent/${o.parent_order_id}`)
          setGrouped(g)
        } catch {
          setGrouped(null) // best effort — l'affichage retombe sur la vue mono-commande
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec du chargement')
    } finally {
      setLoading(false)
    }
  }

  async function changeStatus() {
    if (!order || newStatus === order.status) return
    setBusy(true)
    try {
      await api.put(`/admin/api/orders/${order.id}/status`, { status: newStatus })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec du changement de statut')
    } finally {
      setBusy(false)
    }
  }

  // changeDeliveryStage — POST /admin/api/orders/set-stage (dhlSetOrderStage
  // côté Go), relayé vers fulfillment-svc/shipments/order/{id}/delivery-stage.
  // Déclenche automatiquement la notification WhatsApp client correspondante
  // (voir loyalty-svc, consumer de shipment.delivery_stage_changed).
  async function changeDeliveryStage() {
    if (!order || !deliveryStage) return
    setStageBusy(true)
    setStageNotice(null)
    try {
      await api.post('/admin/api/orders/set-stage', { order_id: order.id, stage: deliveryStage })
      setStageNotice('Étape enregistrée — le client a été notifié par WhatsApp si le canal est configuré.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "échec du changement d'étape")
    } finally {
      setStageBusy(false)
    }
  }

  async function cancel() {
    if (!order || !window.confirm('Annuler cette commande et réintégrer le stock ?')) return
    setBusy(true)
    try {
      await api.post(`/admin/api/orders/${order.id}/cancel`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "échec de l'annulation")
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p>Chargement…</p>
  if (error && !order) return <p className="error-text">{error}</p>
  if (!order) return null

  const commissionRate = 10 // affichage indicatif — même taux par défaut que payment-svc (PLATFORM_COMMISSION_RATE)
  const commission = order.total_usd * commissionRate / 100
  const net = order.total_usd - commission

  // Regroupement par boutique de la vue commande groupée (une section par
  // vendeur, comme demandé) — vide si la vue groupée n'a pas pu charger,
  // auquel cas on retombe silencieusement sur order.lines mono-commande.
  const byVendor = new Map<number, { vendor_name: string; items: GroupedLineItem[] }>()
  for (const li of grouped?.line_items || []) {
    const g = byVendor.get(li.vendor_id) || { vendor_name: li.vendor_name || `Boutique #${li.vendor_id}`, items: [] }
    g.items.push(li)
    byVendor.set(li.vendor_id, g)
  }
  const shipping = grouped?.shipping_address

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Commande {order.reference}</h2>
          <p className="subtitle">
            <StatusBadge status={order.status} /> — boutique #{order.vendor_id} — client #{order.customer_id}
          </p>
        </div>
        <div className="page-header-actions">
          <button className="btn-ghost" onClick={() => navigate('/admin/orders')}>
            Retour à la liste
          </button>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20 }}>
        <div>
          {byVendor.size > 0 ? (
            <div className="form-card" style={{ marginBottom: 16 }}>
              <h3 style={{ marginTop: 0 }}>Articles par boutique</h3>
              {Array.from(byVendor.entries()).map(([vendorId, g]) => (
                <div key={vendorId} style={{ marginBottom: 20 }}>
                  <p className="cell-primary" style={{ marginBottom: 8 }}>{g.vendor_name}</p>
                  <table>
                    <thead>
                      <tr>
                        <th></th>
                        <th>Produit</th>
                        <th>Qté</th>
                        <th>Prix unitaire</th>
                        <th>Sous-total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.items.map((l, i) => (
                        <tr key={i}>
                          <td style={{ width: 44 }}>
                            {l.image && <img src={l.image} alt={l.name} className="thumb" style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 6 }} />}
                          </td>
                          <td className="cell-primary">{l.name}</td>
                          <td>{l.quantity}</td>
                          <td>${l.price}</td>
                          <td>${l.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              <div style={{ marginTop: 12, fontSize: 13, color: '#555' }}>
                <div>Livraison : ${grouped?.shipping_total ?? order.shipping_usd.toFixed(2)}</div>
                <div className="cell-primary">Total TTC : ${grouped?.total ?? order.total_usd.toFixed(2)}</div>
              </div>
            </div>
          ) : (
            <div className="form-card" style={{ marginBottom: 16 }}>
              <h3 style={{ marginTop: 0 }}>Articles &amp; répartition</h3>
              <table>
                <thead>
                  <tr>
                    <th>Produit</th>
                    <th>Qté</th>
                    <th>Prix unitaire</th>
                    <th>Sous-total</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="cell-primary">{l.name}</td>
                      <td>{l.quantity}</td>
                      <td>${l.unit_price_usd.toFixed(2)}</td>
                      <td>${(l.unit_price_usd * l.quantity).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 12, fontSize: 13, color: '#555' }}>
                <div>Sous-total : ${order.subtotal_usd.toFixed(2)}</div>
                <div>Livraison : ${order.shipping_usd.toFixed(2)}</div>
                <div className="cell-primary">Total TTC : ${order.total_usd.toFixed(2)}</div>
              </div>
            </div>
          )}

          <div style={{ marginBottom: 16, fontSize: 13, color: '#555' }}>
            Commission plateforme ({commissionRate}%) : ${commission.toFixed(2)} — Net vendeur : ${net.toFixed(2)}
          </div>

          {shipping && (
            <div className="form-card" style={{ marginBottom: 16 }}>
              <h3 style={{ marginTop: 0 }}>Adresse de livraison</h3>
              <p style={{ fontSize: 14, color: '#333', lineHeight: 1.6, margin: 0 }}>
                {shipping.first_name} {shipping.last_name}<br />
                {shipping.address_1}<br />
                {shipping.city}{shipping.postcode ? ` ${shipping.postcode}` : ''}, {shipping.country}<br />
                {shipping.phone}
              </p>
            </div>
          )}

          <div className="form-card">
            <h3 style={{ marginTop: 0 }}>Journal d'événements</h3>
            {events.length === 0 ? (
              <EmptyState title="Aucun événement enregistré" />
            ) : (
              <div>
                {events.map((e) => (
                  <div key={e.id} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid #f0f1f3' }}>
                    <span className="cell-secondary" style={{ width: 140, flexShrink: 0 }}>
                      {new Date(e.occurred_at).toLocaleString('fr-FR')}
                    </span>
                    <div>
                      <span className="cell-primary">{e.event}</span>
                      {e.description && <span className="cell-secondary"> — {e.description}</span>}
                      <span className="cell-secondary"> ({e.actor})</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="form-card">
            <h3 style={{ marginTop: 0 }}>Actions</h3>
            <div className="form-field" style={{ marginBottom: 12 }}>
              <label>Changer le statut</label>
              <select value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn-primary" disabled={busy || newStatus === order.status} onClick={changeStatus} style={{ width: '100%', marginBottom: 8 }}>
              Enregistrer le statut
            </button>
            <button
              className="btn-danger"
              disabled={busy || order.status === 'cancelled' || order.status === 'delivered'}
              onClick={cancel}
              style={{ width: '100%' }}
            >
              Annuler la commande
            </button>
            <p className="hint" style={{ marginTop: 8 }}>
              L'annulation réintègre automatiquement le stock des produits de cette commande.
            </p>

            <hr style={{ margin: '16px 0', border: 'none', borderTop: '1px solid #eee' }} />

            <div className="form-field" style={{ marginBottom: 12 }}>
              <label>Étape de livraison (chaîne MIAD)</label>
              <select value={deliveryStage} onChange={(e) => setDeliveryStage(e.target.value)}>
                {DELIVERY_STAGE_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <span className="hint">Notifie automatiquement le client par WhatsApp (si activé dans Configuration → WhatsApp)</span>
            </div>
            <button className="btn-primary" disabled={stageBusy || !deliveryStage} onClick={changeDeliveryStage} style={{ width: '100%' }}>
              {stageBusy ? 'Enregistrement…' : "Enregistrer l'étape"}
            </button>
            {stageNotice && <p className="hint" style={{ marginTop: 8, color: '#1a7f37', fontWeight: 600 }}>{stageNotice}</p>}
          </div>

          {order.coupon_code && (
            <div className="form-card" style={{ marginTop: 16 }}>
              <p className="cell-secondary">Coupon appliqué</p>
              <p className="cell-primary">{order.coupon_code}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

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
  status: string
  lines: OrderLine[]
  subtotal_usd: number
  shipping_usd: number
  total_usd: number
  coupon_code: string
  created_at: string
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

export function OrderDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [order, setOrder] = useState<OrderFull | null>(null)
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newStatus, setNewStatus] = useState('')

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
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #eee' }}>
                Commission plateforme ({commissionRate}%) : ${commission.toFixed(2)} — Net vendeur : ${net.toFixed(2)}
              </div>
            </div>
          </div>

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

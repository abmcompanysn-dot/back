import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'
import { IconAlert } from '../../components/Icons'
import { OrdersNav } from './OrdersNav'

interface ReturnRequest {
  id: number
  order_id: number
  product_id: number | null
  reason: string
  photos: string[]
  status: string
  admin_note: string
  created_at: string
}

const STATUS_TABS = [
  { value: 'pending', label: 'En attente' },
  { value: 'accepted', label: 'Acceptés' },
  { value: 'rejected', label: 'Rejetés' },
  { value: '', label: 'Tous' },
]

export function Returns() {
  const navigate = useNavigate()
  const [items, setItems] = useState<ReturnRequest[]>([])
  const [status, setStatus] = useState('pending')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page_size: '50' })
      if (status) params.set('status', status)
      const body = await api.get<{ items: ReturnRequest[] }>(`/admin/api/returns?${params.toString()}`)
      setItems(body.items || [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  async function moderate(r: ReturnRequest, newStatus: 'accepted' | 'rejected') {
    const note = window.prompt(newStatus === 'accepted' ? 'Note (optionnel) :' : 'Motif du rejet :')
    if (note === null && newStatus === 'rejected') return
    setBusyId(r.id)
    try {
      await api.patch(`/admin/api/returns/${r.id}`, { status: newStatus, admin_note: note || '' })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la modération')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <OrdersNav />
      <div className="page-header">
        <div>
          <h2>Retours &amp; Litiges</h2>
          <p className="subtitle">Demandes de retour et réclamations clients</p>
        </div>
      </div>

      <div className="subnav" style={{ marginBottom: 16 }}>
        {STATUS_TABS.map((t) => (
          <a
            key={t.value}
            className={status === t.value ? 'active' : ''}
            href="#"
            onClick={(e) => {
              e.preventDefault()
              setStatus(t.value)
            }}
          >
            {t.label}
          </a>
        ))}
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}

      {!loading && items.length === 0 && (
        <EmptyState icon={<IconAlert width={40} height={40} strokeWidth={1.4} />} title="Aucune demande dans cette file" />
      )}

      {!loading &&
        items.map((r) => (
          <div className="form-card" key={r.id} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <span className="cell-primary" style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/orders/${r.order_id}`)}>
                  Commande #{r.order_id}
                </span>
                {r.product_id && <span className="cell-secondary"> — produit #{r.product_id}</span>}
                <div className="cell-secondary">{new Date(r.created_at).toLocaleDateString('fr-FR')}</div>
              </div>
              <StatusBadge status={r.status} />
            </div>
            <p style={{ margin: '10px 0' }}>{r.reason}</p>
            {r.photos.length > 0 && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                {r.photos.map((p, i) => (
                  <a key={i} href={p} target="_blank" rel="noreferrer">
                    <img src={p} alt="" className="thumb" />
                  </a>
                ))}
              </div>
            )}
            {r.admin_note && (
              <div style={{ background: '#f4f5f7', borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 10 }}>
                <strong>Note admin :</strong> {r.admin_note}
              </div>
            )}
            {r.status === 'pending' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-primary" disabled={busyId === r.id} onClick={() => moderate(r, 'accepted')}>
                  Accepter le retour
                </button>
                <button className="btn-danger" disabled={busyId === r.id} onClick={() => moderate(r, 'rejected')}>
                  Rejeter
                </button>
              </div>
            )}
          </div>
        ))}
    </div>
  )
}

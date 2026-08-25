import { useEffect, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'
import { IconFinance } from '../../components/Icons'
import { VendorNav } from './VendorNav'

interface Payout {
  id: number
  vendor_id: number
  amount_usd: number
  method: string
  status: string
  admin_note: string
  created_at: string
}

const STATUS_TABS = [
  { value: 'pending', label: 'En attente' },
  { value: 'paid', label: 'Payées' },
  { value: 'rejected', label: 'Rejetées' },
  { value: '', label: 'Toutes' },
]

export function Payouts() {
  const [items, setItems] = useState<Payout[]>([])
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
      const body = await api.get<{ items: Payout[] }>(`/admin/api/payout-requests?${params.toString()}`)
      setItems(body.items || [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  async function approve(p: Payout) {
    setBusyId(p.id)
    try {
      await api.post(`/admin/api/payout-requests/${p.id}/approve`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "échec de l'approbation")
    } finally {
      setBusyId(null)
    }
  }

  async function reject(p: Payout) {
    const reason = window.prompt('Motif du rejet (transmis au vendeur) :')
    if (reason === null) return
    setBusyId(p.id)
    try {
      await api.post(`/admin/api/payout-requests/${p.id}/reject`, { admin_note: reason })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec du rejet')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <VendorNav />
      <div className="page-header">
        <div>
          <h2>Retraits &amp; Payouts</h2>
          <p className="subtitle">Demandes de virement vendeurs</p>
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
        <EmptyState icon={<IconFinance width={40} height={40} strokeWidth={1.4} />} title="Aucune demande dans cette file" />
      )}

      {!loading && items.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Vendeur</th>
                <th>Montant</th>
                <th>Méthode</th>
                <th>Statut</th>
                <th>Date</th>
                <th style={{ width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>#{p.vendor_id}</td>
                  <td className="cell-primary">${p.amount_usd.toFixed(2)}</td>
                  <td>{p.method || '—'}</td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="cell-secondary">{new Date(p.created_at).toLocaleDateString('fr-FR')}</td>
                  <td>
                    {p.status === 'pending' && (
                      <div className="row-actions">
                        <button disabled={busyId === p.id} onClick={() => approve(p)}>
                          Valider
                        </button>
                        <button disabled={busyId === p.id} onClick={() => reject(p)}>
                          Rejeter
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

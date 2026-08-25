import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'
import { IconOrders } from '../../components/Icons'
import { OrdersNav } from './OrdersNav'

interface Order {
  id: number
  reference: string
  customer_id: number
  vendor_id: number
  status: string
  total_usd: number
  payment_method: string
  created_at: string
}

const PAGE_SIZE = 25

const STATUS_OPTIONS = [
  { value: '', label: 'Tous les statuts' },
  { value: 'pending_payment', label: 'En attente de paiement' },
  { value: 'paid', label: 'Payée' },
  { value: 'processing', label: 'En préparation' },
  { value: 'shipped', label: 'Expédiée' },
  { value: 'delivered', label: 'Livrée' },
  { value: 'cancelled', label: 'Annulée' },
  { value: 'refunded', label: 'Remboursée' },
  { value: 'payment_expired', label: 'Paiement expiré' },
]

interface Props {
  fixedStatuses?: string[]
  title?: string
  subtitle?: string
}

export function AllOrders({ fixedStatuses, title, subtitle }: Props) {
  const navigate = useNavigate()
  const [items, setItems] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, query, status])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      if (fixedStatuses && fixedStatuses.length > 0) {
        // Pas de OR côté serveur pour plusieurs statuts — une requête par
        // statut puis fusion côté client (liste "en attente" courte, coût
        // négligeable comparé à ajouter un paramètre status[] au serveur).
        const results = await Promise.all(
          fixedStatuses.map((s) =>
            api.get<{ items: Order[] }>(`/admin/api/orders?status=${s}&page_size=${PAGE_SIZE}`),
          ),
        )
        const merged = results.flatMap((r) => r.items || []).sort((a, b) => b.id - a.id)
        setItems(merged)
        setTotal(merged.length)
      } else {
        const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) })
        if (query.trim()) params.set('q', query.trim())
        if (status) params.set('status', status)
        const body = await api.get<{ items: Order[]; total: number }>(`/admin/api/orders?${params.toString()}`)
        setItems(body.items || [])
        setTotal(body.total || 0)
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const showEmpty = !loading && !error && items.length === 0 && !query && !status

  return (
    <div>
      <OrdersNav />
      <div className="page-header">
        <div>
          <h2>{title || 'Commandes'}</h2>
          <p className="subtitle">{subtitle || `Suivi des commandes multi-boutiques — ${total} au total`}</p>
        </div>
      </div>

      {showEmpty ? (
        <EmptyState
          icon={<IconOrders width={40} height={40} strokeWidth={1.4} />}
          title="Aucune commande enregistrée pour le moment"
          description="Les nouvelles commandes de vos clients apparaîtront ici automatiquement."
        />
      ) : (
        <>
          {!fixedStatuses && (
            <div className="filters-bar">
              <input
                className="search-input"
                placeholder="Rechercher par référence…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setPage(1)
                }}
              />
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value)
                  setPage(1)
                }}
              >
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {error && <p className="error-text">{error}</p>}
          {loading && <p>Chargement…</p>}

          {!loading && items.length === 0 && (
            <EmptyState icon={<IconOrders width={40} height={40} strokeWidth={1.4} />} title="Aucun résultat" />
          )}

          {!loading && items.length > 0 && (
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th>Référence</th>
                    <th>Client</th>
                    <th>Boutique</th>
                    <th>Paiement</th>
                    <th>Total</th>
                    <th>Statut</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((o) => (
                    <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/orders/${o.id}`)}>
                      <td className="cell-primary">{o.reference}</td>
                      <td>#{o.customer_id}</td>
                      <td>#{o.vendor_id}</td>
                      <td className="cell-secondary">{o.payment_method || '—'}</td>
                      <td className="cell-primary">${o.total_usd.toFixed(2)}</td>
                      <td>
                        <StatusBadge status={o.status} />
                      </td>
                      <td className="cell-secondary">{new Date(o.created_at).toLocaleDateString('fr-FR')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!fixedStatuses && (
                <div className="table-pagination">
                  <span>{total} résultat{total > 1 ? 's' : ''}</span>
                  <div className="page-controls">
                    <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                      ‹
                    </button>
                    <span>
                      {page} / {totalPages}
                    </span>
                    <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                      ›
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { IconFinance } from '../../components/Icons'
import { FinanceNav } from './FinanceNav'

// Payments — TOUS les paiements (pas juste les confirmés, contrairement
// à Transactions.tsx) : initiated (en attente), failed (échoué), confirmed
// (reçu). Ajouté 2026-09-02 à la demande du fondateur : jusqu'ici, aucune
// page de l'admin ne montrait "est-ce que l'argent est vraiment arrivé ?"
// pour une commande précise — juste l'API brute GET /admin/api/payments,
// jamais affichée nulle part.
interface Payment {
  id: number
  order_id: number
  provider: string
  provider_ref: string
  amount_usd: number
  currency: string
  status: string
  method: string
  failure_code: string
  created_at: string
  confirmed_at: string | null
}

const PAGE_SIZE = 30

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  confirmed: { label: 'Reçu', className: 'badge-green' },
  initiated: { label: 'En attente', className: 'badge-orange' },
  failed: { label: 'Échoué', className: 'badge-red' },
  creating: { label: 'Création en cours', className: 'badge-orange' },
}

function statusBadge(status: string) {
  const info = STATUS_LABELS[status] || { label: status, className: 'badge-gray' }
  return <span className={`badge ${info.className}`}>{info.label}</span>
}

const PROVIDER_LABELS: Record<string, string> = {
  stripe: 'Stripe (carte)',
  paydunya: 'PayDunya',
  pawapay: 'PawaPay',
}

function exportCSV(items: Payment[]) {
  const header = ['id', 'order_id', 'provider', 'status', 'failure_code', 'amount_usd', 'created_at', 'confirmed_at']
  const rows = items.map((p) => [p.id, p.order_id, p.provider, p.status, p.failure_code, p.amount_usd, p.created_at, p.confirmed_at])
  const csv = [header, ...rows].map((r) => r.join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `paiements-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export function PaymentsAll() {
  const [items, setItems] = useState<Payment[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [orderSearch, setOrderSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, statusFilter])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) })
      if (statusFilter) params.set('status', statusFilter)
      const body = await api.get<{ items: Payment[]; total: number }>(`/admin/api/payments?${params.toString()}`)
      setItems(body.items || [])
      setTotal(body.total || 0)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  // Filtre par numéro de commande côté client (page courante seulement —
  // pour une recherche exhaustive sur tout l'historique, utiliser
  // GET /admin/api/payments côté API directement).
  const visibleItems = orderSearch.trim()
    ? items.filter((p) => String(p.order_id).includes(orderSearch.trim()))
    : items

  return (
    <div>
      <FinanceNav />
      <div className="page-header">
        <div>
          <h2>Paiements</h2>
          <p className="subtitle">
            Tous les paiements, quel que soit leur statut — {total} au total. Pour vérifier si l'argent d'une commande
            est vraiment arrivé, cherchez son numéro ci-dessous.
          </p>
        </div>
        <div className="page-header-actions">
          <button className="btn-ghost" disabled={items.length === 0} onClick={() => exportCSV(items)}>
            Exporter cette page (CSV)
          </button>
        </div>
      </div>

      <div className="filters-bar">
        <input
          className="search-input"
          type="text"
          placeholder="Chercher par n° de commande (page actuelle)…"
          value={orderSearch}
          onChange={(e) => setOrderSearch(e.target.value)}
        />
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value)
            setPage(1)
          }}
        >
          <option value="">Tous les statuts</option>
          <option value="confirmed">Reçu</option>
          <option value="initiated">En attente</option>
          <option value="failed">Échoué</option>
        </select>
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}

      {!loading && visibleItems.length === 0 && (
        <EmptyState icon={<IconFinance width={40} height={40} strokeWidth={1.4} />} title="Aucun paiement trouvé" />
      )}

      {!loading && visibleItems.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Commande</th>
                <th>Statut</th>
                <th>Passerelle</th>
                <th>Montant</th>
                <th>Cause d'échec</th>
                <th>Créé le</th>
                <th>Confirmé le</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((p) => (
                <tr key={p.id}>
                  <td className="cell-primary">#{p.order_id}</td>
                  <td>{statusBadge(p.status)}</td>
                  <td>{PROVIDER_LABELS[p.provider] || p.provider}</td>
                  <td className="cell-primary">${p.amount_usd.toFixed(2)}</td>
                  <td className="cell-secondary">{p.failure_code || '—'}</td>
                  <td className="cell-secondary">{new Date(p.created_at).toLocaleString('fr-FR')}</td>
                  <td className="cell-secondary">{p.confirmed_at ? new Date(p.confirmed_at).toLocaleString('fr-FR') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
        </div>
      )}
    </div>
  )
}

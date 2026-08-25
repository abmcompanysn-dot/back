import { useEffect, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { IconFinance } from '../../components/Icons'
import { FinanceNav } from './FinanceNav'

interface Transaction {
  id: number
  order_id: number
  provider: string
  provider_ref: string
  amount_usd: number
  commission_usd: number
  net_usd: number
  method: string
  confirmed_at: string | null
}

const PAGE_SIZE = 30

function exportCSV(items: Transaction[]) {
  const header = ['id', 'order_id', 'provider', 'provider_ref', 'amount_usd', 'commission_usd', 'net_usd', 'confirmed_at']
  const rows = items.map((t) => [t.id, t.order_id, t.provider, t.provider_ref, t.amount_usd, t.commission_usd, t.net_usd, t.confirmed_at])
  const csv = [header, ...rows].map((r) => r.join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export function Transactions() {
  const [items, setItems] = useState<Transaction[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const body = await api.get<{ items: Transaction[]; total: number }>(
        `/admin/api/finance/transactions?page=${page}&page_size=${PAGE_SIZE}`,
      )
      setItems(body.items || [])
      setTotal(body.total || 0)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div>
      <FinanceNav />
      <div className="page-header">
        <div>
          <h2>Transactions</h2>
          <p className="subtitle">Journal des paiements confirmés — {total} au total</p>
        </div>
        <div className="page-header-actions">
          <button className="btn-ghost" disabled={items.length === 0} onClick={() => exportCSV(items)}>
            Exporter cette page (CSV)
          </button>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}

      {!loading && items.length === 0 && (
        <EmptyState icon={<IconFinance width={40} height={40} strokeWidth={1.4} />} title="Aucune transaction pour le moment" />
      )}

      {!loading && items.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Commande</th>
                <th>Passerelle</th>
                <th>Référence</th>
                <th>Montant</th>
                <th>Commission</th>
                <th>Net vendeur</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td className="cell-primary">#{t.order_id}</td>
                  <td>{t.provider}</td>
                  <td className="cell-secondary">{t.provider_ref || '—'}</td>
                  <td className="cell-primary">${t.amount_usd.toFixed(2)}</td>
                  <td>${t.commission_usd.toFixed(2)}</td>
                  <td>${t.net_usd.toFixed(2)}</td>
                  <td className="cell-secondary">{t.confirmed_at ? new Date(t.confirmed_at).toLocaleDateString('fr-FR') : '—'}</td>
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

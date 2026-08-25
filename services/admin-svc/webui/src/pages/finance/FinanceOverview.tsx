import { useEffect, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { FinanceNav } from './FinanceNav'

interface Overview {
  gmv_usd: number
  orders_count: number
  average_basket_usd: number
  commission_revenue_usd: number
  by_payment_method: { provider: string; count: number; amount_usd: number }[]
  pending_payouts_total_usd: number
  pending_payouts_count: number
}

const PERIODS = [
  { value: 'today', label: "Aujourd'hui" },
  { value: '7d', label: '7 derniers jours' },
  { value: '30d', label: '30 derniers jours' },
  { value: 'year', label: 'Année en cours' },
]

const PROVIDER_LABELS: Record<string, string> = {
  stripe: 'Carte bancaire (Stripe)',
  paydunya: 'Mobile Money (PayDunya)',
}

export function FinanceOverview() {
  const [period, setPeriod] = useState('30d')
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const body = await api.get<Overview>(`/admin/api/finance/overview?period=${period}`)
      setData(body)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <FinanceNav />
      <div className="page-header">
        <div>
          <h2>Finances</h2>
          <p className="subtitle">Vue d'ensemble des revenus de la marketplace</p>
        </div>
        <div className="page-header-actions">
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}

      {!loading && data && (
        <>
          <div className="cards" style={{ marginBottom: 24 }}>
            <div className="card">
              <div className="num">${data.gmv_usd.toFixed(2)}</div>
              <div className="label">Volume d'affaires (GMV)</div>
            </div>
            <div className="card">
              <div className="num">${data.commission_revenue_usd.toFixed(2)}</div>
              <div className="label">Revenu net plateforme</div>
            </div>
            <div className="card">
              <div className="num">{data.orders_count}</div>
              <div className="label">Commandes payées — panier moyen ${data.average_basket_usd.toFixed(2)}</div>
            </div>
            <div className="card">
              <div className="num">${data.pending_payouts_total_usd.toFixed(2)}</div>
              <div className="label">{data.pending_payouts_count} retrait(s) en attente</div>
            </div>
          </div>

          <div className="form-card">
            <h3 style={{ marginTop: 0 }}>Répartition par mode de paiement</h3>
            {data.by_payment_method.length === 0 ? (
              <p className="cell-secondary">Aucune transaction sur cette période.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Passerelle</th>
                    <th>Transactions</th>
                    <th>Montant</th>
                    <th>Part</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_payment_method.map((m) => (
                    <tr key={m.provider}>
                      <td className="cell-primary">{PROVIDER_LABELS[m.provider] || m.provider}</td>
                      <td>{m.count}</td>
                      <td>${m.amount_usd.toFixed(2)}</td>
                      <td>{data.gmv_usd > 0 ? ((m.amount_usd / data.gmv_usd) * 100).toFixed(0) : 0}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}

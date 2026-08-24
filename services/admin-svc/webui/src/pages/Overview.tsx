import { useApiData } from '../lib/useApiData'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge } from '../components/StatusBadge'

interface OverviewData {
  orders_total?: number
  products_total?: number
  vendors_total?: number
  payments_total?: number
  services?: Record<string, string>
}

export function Overview() {
  const { data, error, loading } = useApiData<OverviewData>('/admin/api/overview')

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Vue d'ensemble</h2>
          <p className="subtitle">Chiffres clés de la marketplace en un coup d'œil</p>
        </div>
      </div>

      {loading && <p>Chargement…</p>}
      {error && <EmptyState icon="⚠️" title="Impossible de charger le tableau de bord" description={error} />}

      {!loading && !error && data && (
        <>
          <div className="cards">
            <div className="card">
              <div className="num">{data.orders_total ?? '—'}</div>
              <div className="label">Commandes</div>
            </div>
            <div className="card">
              <div className="num">{data.products_total ?? '—'}</div>
              <div className="label">Produits</div>
            </div>
            <div className="card">
              <div className="num">{data.vendors_total ?? '—'}</div>
              <div className="label">Boutiques</div>
            </div>
            <div className="card">
              <div className="num">{data.payments_total ?? '—'}</div>
              <div className="label">Paiements</div>
            </div>
          </div>

          <h3>État des services</h3>
          <div className="table-card">
            <table>
              <tbody>
                {Object.entries(data.services || {}).map(([name, status]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>
                      <StatusBadge status={status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

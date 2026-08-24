import { useApiData } from '../lib/useApiData'

interface OverviewData {
  orders_total?: number
  products_total?: number
  vendors_total?: number
  payments_total?: number
  services?: Record<string, string>
}

export function Overview() {
  const { data, error, loading } = useApiData<OverviewData>('/admin/api/overview')
  if (loading) return <p>Chargement…</p>
  if (error) return <p className="error-text">Erreur : {error}</p>
  if (!data) return null

  return (
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
      <table>
        <tbody>
          {Object.entries(data.services || {}).map(([name, status]) => (
            <tr key={name}>
              <td>{name}</td>
              <td className={status === 'ok' ? 'status-ok' : 'status-down'}>{status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

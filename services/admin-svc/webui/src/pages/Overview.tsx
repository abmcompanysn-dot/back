import { useApiData } from '../lib/useApiData'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge } from '../components/StatusBadge'
import { IconAlert } from '../components/Icons'

interface OverviewData {
  orders_total?: number
  products_total?: number
  vendors_total?: number
  payments_total?: number
  services?: Record<string, string>
}

const KPI = [
  { key: 'orders_total', label: 'Commandes' },
  { key: 'products_total', label: 'Produits' },
  { key: 'vendors_total', label: 'Boutiques' },
  { key: 'payments_total', label: 'Paiements' },
] as const

export function Overview() {
  const { data, error, loading } = useApiData<OverviewData>('/admin/api/overview')

  const services = Object.entries(data?.services || {})
  const down = services.filter(([, s]) => s.toLowerCase() !== 'ok').length

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Vue d'ensemble</h2>
          <p className="subtitle">Chiffres clés de la marketplace en un coup d'œil</p>
        </div>
      </div>

      {loading && <p>Chargement…</p>}
      {error && (
        <EmptyState
          icon={<IconAlert width={40} height={40} strokeWidth={1.4} />}
          title="Impossible de charger le tableau de bord"
          description={error}
        />
      )}

      {!loading && !error && data && (
        <>
          <div className="cards">
            {KPI.map(({ key, label }) => (
              <div className="card" key={key}>
                <div className="num">{(data[key] ?? '—').toLocaleString('fr-FR')}</div>
                <div className="label">{label}</div>
              </div>
            ))}
          </div>

          <div className="page-header" style={{ marginTop: 8 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 15 }}>État des services</h3>
              <p className="subtitle" style={{ marginTop: 2 }}>
                {down === 0
                  ? `${services.length} services opérationnels`
                  : `${down} service(s) en difficulté sur ${services.length}`}
              </p>
            </div>
          </div>

          <div className="service-grid">
            {services.map(([name, status]) => (
              <div className="service-card" key={name}>
                <span className="svc-name">{name}</span>
                <StatusBadge status={status} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

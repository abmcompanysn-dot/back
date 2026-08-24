import { useApiData } from '../lib/useApiData'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge } from '../components/StatusBadge'
import { IconAlert } from '../components/Icons'

interface SystemData {
  status?: string
  services?: Record<string, unknown>
}

export function System() {
  const { data, error, loading } = useApiData<SystemData>('/admin/api/system')

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Système</h2>
          <p className="subtitle">Diagnostic des 11 microservices du backend</p>
        </div>
      </div>

      {loading && <p>Chargement…</p>}
      {error && (
        <EmptyState
          icon={<IconAlert width={40} height={40} strokeWidth={1.4} />}
          title="Diagnostic indisponible"
          description={error}
        />
      )}

      {!loading && !error && data && (
        <>
          <p>
            Statut global : <StatusBadge status={data.status} />
          </p>
          <pre>{JSON.stringify(data.services, null, 2)}</pre>
        </>
      )}
    </div>
  )
}

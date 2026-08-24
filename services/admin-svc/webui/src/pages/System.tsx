import { useApiData } from '../lib/useApiData'

interface SystemData {
  status?: string
  services?: Record<string, unknown>
}

export function System() {
  const { data, error, loading } = useApiData<SystemData>('/admin/api/system')
  if (loading) return <p>Chargement…</p>
  if (error) return <p className="error-text">Erreur : {error}</p>
  if (!data) return null

  return (
    <>
      <p>
        Statut global :{' '}
        <b className={data.status === 'ok' ? 'status-ok' : 'status-down'}>{data.status}</b>
      </p>
      <pre>{JSON.stringify(data.services, null, 2)}</pre>
    </>
  )
}

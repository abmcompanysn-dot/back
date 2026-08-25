import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { IconStore } from '../../components/Icons'
import { VendorNav } from './VendorNav'

interface Vendor {
  id: number
  name: string
  logo_url: string
  email: string
  country: string
  city: string
  kyc_documents: { type: string; url: string }[]
}

export function VendorKYC() {
  const navigate = useNavigate()
  const [items, setItems] = useState<Vendor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const body = await api.get<{ items: Vendor[] }>('/admin/api/vendors?kyc_status=pending&page_size=50')
      setItems(body.items || [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  async function approve(v: Vendor) {
    setBusyId(v.id)
    try {
      await api.post(`/admin/api/vendors/${v.id}/kyc/approve`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "échec de l'approbation")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <VendorNav />
      <div className="page-header">
        <div>
          <h2>Demandes d'inscription</h2>
          <p className="subtitle">{items.length} boutique(s) en attente de validation KYC</p>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}

      {!loading && items.length === 0 && (
        <EmptyState icon={<IconStore width={40} height={40} strokeWidth={1.4} />} title="Aucune demande en attente" />
      )}

      {!loading &&
        items.map((v) => (
          <div className="form-card" key={v.id} style={{ marginBottom: 12, display: 'flex', gap: 14, alignItems: 'center' }}>
            {v.logo_url ? (
              <img className="thumb" src={v.logo_url} alt="" style={{ width: 56, height: 56 }} />
            ) : (
              <div className="thumb-placeholder" style={{ width: 56, height: 56 }}>
                <IconStore width={20} height={20} />
              </div>
            )}
            <div style={{ flex: 1 }}>
              <div className="cell-primary">{v.name}</div>
              <div className="cell-secondary">
                {v.email} · {v.city ? `${v.city}, ` : ''}
                {v.country} · {(v.kyc_documents ?? []).length} document(s)
              </div>
            </div>
            <button className="btn-ghost" onClick={() => navigate(`/admin/vendors/${v.id}`)}>
              Voir la fiche
            </button>
            <button className="btn-primary" disabled={busyId === v.id} onClick={() => approve(v)}>
              Approuver
            </button>
          </div>
        ))}
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { IconStore } from '../../components/Icons'
import { VendorNav } from './VendorNav'

// Format tableau (avant : cartes verticales, 1 boutique = 1 écran de
// hauteur pour très peu d'info, défilement infini sur 50 demandes) +
// recherche/filtre pays + bouton Rejeter (existait côté backend,
// jamais câblé ici) — revue UX 2026-09-02.

interface Vendor {
  id: number
  name: string
  logo_url: string
  email: string
  country: string
  city: string
  created_at?: string
  kyc_documents: { type: string; url: string }[]
}

export function VendorKYC() {
  const navigate = useNavigate()
  const [items, setItems] = useState<Vendor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [country, setCountry] = useState('')

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
    if ((v.kyc_documents ?? []).length === 0) {
      if (!window.confirm(`${v.name} n'a fourni AUCUN document KYC. Approuver quand même ?`)) return
    }
    setBusyId(v.id)
    try {
      await api.post(`/admin/api/vendors/${v.id}/kyc/approve`)
      setItems((prev) => prev.filter((x) => x.id !== v.id))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "échec de l'approbation")
    } finally {
      setBusyId(null)
    }
  }

  async function reject(v: Vendor) {
    const reason = window.prompt(`Motif du rejet pour ${v.name} (envoyé au vendeur) :`)
    if (reason === null) return
    setBusyId(v.id)
    try {
      await api.post(`/admin/api/vendors/${v.id}/kyc/reject`, { reason })
      setItems((prev) => prev.filter((x) => x.id !== v.id))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec du rejet')
    } finally {
      setBusyId(null)
    }
  }

  const countries = useMemo(
    () => Array.from(new Set(items.map((v) => v.country).filter(Boolean))).sort(),
    [items]
  )
  const filtered = items.filter((v) => {
    const term = q.trim().toLowerCase()
    const matchQ = !term || v.name?.toLowerCase().includes(term) || v.city?.toLowerCase().includes(term)
    const matchCountry = !country || v.country === country
    return matchQ && matchCountry
  })

  return (
    <div>
      <VendorNav />
      <div className="page-header">
        <div>
          <h2>Demandes d'inscription</h2>
          <p className="subtitle">{items.length} boutique(s) en attente de validation KYC</p>
        </div>
        <div className="page-header-actions">
          <input
            className="search-input"
            placeholder="Rechercher par nom ou ville…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">Tous les pays</option>
            {countries.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}

      {!loading && items.length === 0 && (
        <EmptyState icon={<IconStore width={40} height={40} strokeWidth={1.4} />} title="Aucune demande en attente" />
      )}

      {!loading && items.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Boutique</th>
                <th>Emplacement</th>
                <th>Documents</th>
                <th>Demandée le</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => {
                const docCount = (v.kyc_documents ?? []).length
                return (
                  <tr key={v.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {v.logo_url ? (
                          <img className="thumb" src={v.logo_url} alt="" style={{ width: 36, height: 36 }} />
                        ) : (
                          <div className="thumb-placeholder" style={{ width: 36, height: 36 }}>
                            <IconStore width={16} height={16} />
                          </div>
                        )}
                        <div>
                          <div className="cell-primary">{v.name}</div>
                          <div className="cell-secondary">{v.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="cell-secondary">
                      {v.city ? `${v.city}, ` : ''}
                      {v.country || '—'}
                    </td>
                    <td>
                      <span className={`badge ${docCount === 0 ? 'badge-red' : 'badge-green'}`}>
                        {docCount} document{docCount > 1 ? 's' : ''}
                      </span>
                    </td>
                    <td className="cell-secondary">
                      {v.created_at ? new Date(v.created_at).toLocaleDateString('fr-FR') : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn-ghost" onClick={() => navigate(`/admin/vendors/${v.id}`)}>
                          Voir la fiche
                        </button>
                        <button className="btn-danger" disabled={busyId === v.id} onClick={() => reject(v)}>
                          Rejeter
                        </button>
                        <button className="btn-primary" disabled={busyId === v.id} onClick={() => approve(v)}>
                          Approuver
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

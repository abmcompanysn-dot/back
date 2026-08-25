import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'
import { IconMoreVertical, IconPlus, IconStore } from '../../components/Icons'
import { VendorNav } from './VendorNav'

interface Vendor {
  id: number
  name: string
  slug: string
  logo_url: string
  country: string
  city: string
  email: string
  phone: string
  verified: boolean
  rating_avg: number
  product_count: number
  kyc_status: string
  suspended: boolean
}

const PAGE_SIZE = 25

export function AllVendors() {
  const navigate = useNavigate()
  const [items, setItems] = useState<Vendor[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [kycStatus, setKycStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openMenuId, setOpenMenuId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, query, kycStatus])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) })
      if (query.trim()) params.set('q', query.trim())
      if (kycStatus) params.set('kyc_status', kycStatus)
      const body = await api.get<{ items: Vendor[]; total: number }>(`/admin/api/vendors?${params.toString()}`)
      setItems(body.items || [])
      setTotal(body.total || 0)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  async function toggleActive(v: Vendor) {
    setItems((prev) => prev.map((x) => (x.id === v.id ? { ...x, verified: !x.verified } : x)))
    try {
      await api.patch(`/admin/api/vendors/${v.id}`, { verified: !v.verified })
    } catch {
      setItems((prev) => prev.map((x) => (x.id === v.id ? { ...x, verified: v.verified } : x)))
      setError('échec du changement de statut')
    }
  }

  async function impersonate(v: Vendor) {
    setBusy(true)
    try {
      const body = await api.post<{ session: { jwt: string } }>(`/admin/api/vendors/${v.id}/impersonate`)
      window.open(`https://miadmarket.ca/?impersonate_jwt=${encodeURIComponent(body.session.jwt)}`, '_blank')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "échec de l'impersonation")
    } finally {
      setBusy(false)
      setOpenMenuId(null)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const showEmpty = !loading && !error && items.length === 0 && !query && !kycStatus

  return (
    <div>
      <VendorNav />
      <div className="page-header">
        <div>
          <h2>Vendeurs</h2>
          <p className="subtitle">Boutiques de la marketplace — {total} au total</p>
        </div>
        <div className="page-header-actions">
          <button className="btn-primary" onClick={() => navigate('/admin/vendors/new')}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <IconPlus width={16} height={16} /> Ajouter un vendeur
            </span>
          </button>
        </div>
      </div>

      {showEmpty ? (
        <EmptyState
          icon={<IconStore width={40} height={40} strokeWidth={1.4} />}
          title="Aucune boutique enregistrée"
          description="Créez la première boutique manuellement ou attendez une demande d'inscription."
          action={{ label: 'Ajouter un vendeur', onClick: () => navigate('/admin/vendors/new') }}
        />
      ) : (
        <>
          <div className="filters-bar">
            <input
              className="search-input"
              placeholder="Rechercher par nom ou email…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(1)
              }}
            />
            <select
              value={kycStatus}
              onChange={(e) => {
                setKycStatus(e.target.value)
                setPage(1)
              }}
            >
              <option value="">Tous les statuts KYC</option>
              <option value="pending">En attente</option>
              <option value="approved">Approuvé</option>
              <option value="rejected">Rejeté</option>
            </select>
          </div>

          {error && <p className="error-text">{error}</p>}
          {loading && <p>Chargement…</p>}

          {!loading && items.length === 0 && (
            <EmptyState icon={<IconStore width={40} height={40} strokeWidth={1.4} />} title="Aucun résultat" />
          )}

          {!loading && items.length > 0 && (
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 48 }}></th>
                    <th>Boutique</th>
                    <th>Contact</th>
                    <th>Produits</th>
                    <th>Note</th>
                    <th>KYC</th>
                    <th>Statut</th>
                    <th style={{ width: 40 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((v) => (
                    <tr key={v.id}>
                      <td>
                        {v.logo_url ? (
                          <img className="thumb" src={v.logo_url} alt="" />
                        ) : (
                          <div className="thumb-placeholder">
                            <IconStore width={16} height={16} />
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="cell-primary">{v.name}</div>
                        <div className="cell-secondary">
                          {v.city ? `${v.city}, ` : ''}
                          {v.country}
                          {v.suspended && <span className="badge badge-red" style={{ marginLeft: 6 }}>Suspendu</span>}
                        </div>
                      </td>
                      <td>
                        <div className="cell-secondary">{v.email || '—'}</div>
                        <div className="cell-secondary">{v.phone || '—'}</div>
                      </td>
                      <td>{v.product_count}</td>
                      <td>{v.rating_avg ? v.rating_avg.toFixed(1) : '—'}</td>
                      <td>
                        <StatusBadge status={v.kyc_status} />
                      </td>
                      <td>
                        <label className="toggle" title={v.verified ? 'Active — cliquer pour désactiver' : 'Inactive — cliquer pour activer'}>
                          <input type="checkbox" checked={v.verified} onChange={() => toggleActive(v)} />
                          <span className="slider" />
                        </label>
                      </td>
                      <td>
                        <div className="row-menu">
                          <button className="row-menu-btn" onClick={() => setOpenMenuId(openMenuId === v.id ? null : v.id)}>
                            <IconMoreVertical width={16} height={16} />
                          </button>
                          {openMenuId === v.id && (
                            <div className="row-menu-dropdown" onMouseLeave={() => setOpenMenuId(null)}>
                              <button onClick={() => navigate(`/admin/vendors/${v.id}`)}>Voir la fiche</button>
                              <button onClick={() => navigate(`/admin/catalog/products/new?vendor_id=${v.id}`)}>
                                Ajouter un produit
                              </button>
                              <button disabled={busy} onClick={() => impersonate(v)}>
                                Se connecter en tant que
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
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
        </>
      )}
    </div>
  )
}

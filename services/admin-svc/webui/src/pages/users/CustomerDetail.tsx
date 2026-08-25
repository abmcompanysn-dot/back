import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { IconAlert } from '../../components/Icons'

interface Address {
  type?: string
  address_1?: string
  city?: string
  country?: string
}

interface CustomerFull {
  id: number
  email: string
  phone: string
  full_name: string
  addresses: Address[]
  preferred_lang: string
  must_reset_password: boolean
  vendor_id?: number
  created_at: string
}

function formatDate(iso: string | undefined): string {
  if (!iso || iso.startsWith('0001-01-01')) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function CustomerDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [customer, setCustomer] = useState<CustomerFull | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const body = await api.get<CustomerFull>(`/admin/api/customer/${id}`)
      setCustomer(body)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      {loading && <p>Chargement…</p>}
      {error && (
        <EmptyState icon={<IconAlert width={40} height={40} strokeWidth={1.4} />} title="Impossible de charger la fiche" description={error} />
      )}

      {!loading && !error && customer && (
        <>
          <div className="page-header">
            <div>
              <h2>{customer.full_name || `Client #${customer.id}`}</h2>
              <p className="subtitle">
                Compte client #{customer.id} — inscrit le {formatDate(customer.created_at)}
              </p>
            </div>
            <div className="page-header-actions">
              {customer.vendor_id ? (
                <span className="badge badge-green">Boutique liée #{customer.vendor_id}</span>
              ) : customer.must_reset_password ? (
                <span className="badge badge-orange">Compte importé — reset mot de passe requis</span>
              ) : (
                <span className="badge badge-gray">Acheteur</span>
              )}
              <button className="btn-ghost" onClick={() => navigate('/admin/users')}>
                Retour à la liste
              </button>
            </div>
          </div>

          <div className="form-card">
            <h3>Coordonnées</h3>
            <div className="form-grid">
              <div>
                <label>Email</label>
                <p>{customer.email || '—'}</p>
              </div>
              <div>
                <label>Téléphone</label>
                <p>{customer.phone || '—'}</p>
              </div>
              <div>
                <label>Langue préférée</label>
                <p>{(customer.preferred_lang || 'fr').toUpperCase()}</p>
              </div>
              <div>
                <label>Identifiant interne</label>
                <p>#{customer.id}</p>
              </div>
            </div>
          </div>

          <div className="form-card">
            <h3>Adresses</h3>
            {(!customer.addresses || customer.addresses.length === 0) && <p className="cell-secondary">Aucune adresse enregistrée</p>}
            {customer.addresses && customer.addresses.length > 0 && (
              <div className="table-card">
                <table>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Adresse</th>
                      <th>Ville</th>
                      <th>Pays</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customer.addresses.map((a, i) => (
                      <tr key={i}>
                        <td>{a.type || '—'}</td>
                        <td>{a.address_1 || '—'}</td>
                        <td>{a.city || '—'}</td>
                        <td>{a.country || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {customer.must_reset_password && (
            <div className="form-card">
              <h3>Compte importé</h3>
              <p className="cell-secondary">
                Ce compte provient de l'import de l'historique WooCommerce. Aucun mot de passe n'a pu être migré
                (l'API WooCommerce ne l'expose jamais) — le client doit passer par « mot de passe oublié » pour se
                connecter la première fois.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

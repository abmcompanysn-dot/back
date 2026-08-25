import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'
import { IconCustomers, IconSecurity, IconStore } from '../../components/Icons'

// Module Utilisateurs — vue unifiée de TOUS les types de comptes (clients
// acheteurs, boutiques/vendeurs, admins du back-office, représentants
// pays). Contrairement à WordPress (un seul wp_users + rôles cumulables),
// ce backend a 3 sources séparées par domaine (auth-svc: customers+admins,
// loyalty-svc: representatives) — un même compte peut apparaître dans
// plusieurs (ex: un représentant qui est aussi client). L'onglet "Tous"
// utilise GET /admin/api/users (fusionné par email côté admin-svc,
// voir listUnifiedUsers) pour montrer les rôles cumulés sur UNE ligne ;
// les autres onglets restent des vues filtrées par source, plus riches en
// détails propres à ce type de compte (KYC vendeur, 2FA admin...).
type Tab = 'all' | 'customers' | 'vendors' | 'admins' | 'representatives'

interface UnifiedUser {
  email: string
  phone: string
  name: string
  roles: string[]
  vendor_id?: number
  country?: string
  created_at: string
}

const ROLE_LABELS: Record<string, string> = {
  customer: 'Client',
  vendor: 'Vendeur',
  admin: 'Admin',
  representative: 'Représentant',
  super_representative: 'Super représentant',
}
const ROLE_COLORS: Record<string, string> = {
  customer: 'gray',
  vendor: 'green',
  admin: 'orange',
  representative: 'green',
  super_representative: 'orange',
}

interface Customer {
  id: number
  email: string
  phone: string
  full_name?: string
  preferred_lang: string
  must_reset_password: boolean
  vendor_id?: number
  created_at: string
}

interface Vendor {
  id: number
  name: string
  email: string
  phone: string
  country: string
  city: string
  verified: boolean
  kyc_status: string
  product_count: number
}

interface Admin {
  id: number
  email: string
  role: string
  totp_enabled: boolean
  created_at: string
}

interface Representative {
  id: number
  name: string
  email: string
  country: string
  is_super_rep: boolean
  commission_pct: number
  created_at: string
}

const PAGE_SIZE = 25

// formatDate — jamais afficher un timestamp ISO brut (illisible) ni une
// zero-value Go non détectée (0001-01-01, signe d'un champ NULL scanné
// silencieusement côté backend — voir le fix sur listCustomers/getCustomer).
function formatDate(iso: string | undefined): string {
  if (!iso || iso.startsWith('0001-01-01')) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function AllUsers() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  const [unified, setUnified] = useState<UnifiedUser[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [admins, setAdmins] = useState<Admin[]>([])
  const [representatives, setRepresentatives] = useState<Representative[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setPage(1)
    setQuery('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, page, query])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      if (tab === 'all') {
        const body = await api.get<{ items: UnifiedUser[]; total: number }>('/admin/api/users')
        setUnified(body.items || [])
        setTotal(body.total || 0)
      } else if (tab === 'customers') {
        const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) })
        const body = await api.get<{ items: Customer[]; total: number }>(`/admin/api/customers?${params.toString()}`)
        setCustomers(body.items || [])
        setTotal(body.total || 0)
      } else if (tab === 'vendors') {
        const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) })
        if (query.trim()) params.set('q', query.trim())
        const body = await api.get<{ items: Vendor[]; total: number }>(`/admin/api/vendors?${params.toString()}`)
        setVendors(body.items || [])
        setTotal(body.total || 0)
      } else if (tab === 'admins') {
        const body = await api.get<{ items: Admin[]; total: number }>('/admin/api/admins')
        setAdmins(body.items || [])
        setTotal(body.total || 0)
      } else {
        const body = await api.get<{ items: Representative[]; total: number }>('/admin/api/representatives')
        setRepresentatives(body.items || [])
        setTotal(body.total || 0)
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  const filteredUnified =
    tab === 'all' && query.trim()
      ? unified.filter((u) => {
          const q = query.trim().toLowerCase()
          return u.email?.toLowerCase().includes(q) || u.phone?.toLowerCase().includes(q) || u.name?.toLowerCase().includes(q)
        })
      : unified

  const filteredCustomers =
    tab === 'customers' && query.trim()
      ? customers.filter((c) => {
          const q = query.trim().toLowerCase()
          return (
            c.email?.toLowerCase().includes(q) ||
            c.phone?.toLowerCase().includes(q) ||
            c.full_name?.toLowerCase().includes(q)
          )
        })
      : customers

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Utilisateurs</h2>
          <p className="subtitle">Clients, boutiques, admins et représentants — {total} au total sur cet onglet</p>
        </div>
      </div>

      <div className="form-tabs">
        <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')} type="button">
          <IconCustomers width={16} height={16} /> Tous
        </button>
        <button className={tab === 'customers' ? 'active' : ''} onClick={() => setTab('customers')} type="button">
          <IconCustomers width={16} height={16} /> Clients
        </button>
        <button className={tab === 'vendors' ? 'active' : ''} onClick={() => setTab('vendors')} type="button">
          <IconStore width={16} height={16} /> Boutiques
        </button>
        <button className={tab === 'admins' ? 'active' : ''} onClick={() => setTab('admins')} type="button">
          <IconSecurity width={16} height={16} /> Admins
        </button>
        <button className={tab === 'representatives' ? 'active' : ''} onClick={() => setTab('representatives')} type="button">
          <IconSecurity width={16} height={16} /> Représentants
        </button>
      </div>

      {tab !== 'admins' && tab !== 'representatives' && (
        <div className="filters-bar">
          <input
            className="search-input"
            placeholder={tab === 'vendors' ? 'Rechercher par nom ou email…' : 'Rechercher par email, téléphone, nom…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}

      {!loading && !error && tab === 'all' && <UnifiedTable items={filteredUnified} />}
      {!loading && !error && tab === 'customers' && (
        <CustomersTable items={filteredCustomers} onOpen={(id) => navigate(`/admin/users/customers/${id}`)} />
      )}
      {!loading && !error && tab === 'vendors' && (
        <VendorsTable items={vendors} onOpen={(id) => navigate(`/admin/vendors/${id}`)} />
      )}
      {!loading && !error && tab === 'admins' && <AdminsTable items={admins} />}
      {!loading && !error && tab === 'representatives' && <RepresentativesTable items={representatives} />}

      {!loading && !error && tab !== 'admins' && tab !== 'all' && tab !== 'representatives' && total > PAGE_SIZE && (
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
      )}
    </div>
  )
}

function CustomersTable({ items, onOpen }: { items: Customer[]; onOpen: (id: number) => void }) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<IconCustomers width={40} height={40} strokeWidth={1.4} />}
        title="Aucun client trouvé"
      />
    )
  }
  return (
    <div className="table-card">
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Contact</th>
            <th>Langue</th>
            <th>Compte</th>
            <th>Inscrit le</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(c.id)}>
              <td>
                <div className="cell-primary">{c.full_name || `Client #${c.id}`}</div>
                <div className="cell-secondary">#{c.id}</div>
              </td>
              <td>
                <div className="cell-secondary">{c.email || '—'}</div>
                <div className="cell-secondary">{c.phone || '—'}</div>
              </td>
              <td>{(c.preferred_lang || 'fr').toUpperCase()}</td>
              <td>
                {c.vendor_id ? (
                  <span className="badge badge-green">Boutique liée</span>
                ) : c.must_reset_password ? (
                  <span className="badge badge-orange">Importé — reset requis</span>
                ) : (
                  <span className="badge badge-gray">Acheteur</span>
                )}
              </td>
              <td className="cell-secondary">{formatDate(c.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function VendorsTable({ items, onOpen }: { items: Vendor[]; onOpen: (id: number) => void }) {
  if (items.length === 0) {
    return <EmptyState icon={<IconStore width={40} height={40} strokeWidth={1.4} />} title="Aucune boutique trouvée" />
  }
  return (
    <div className="table-card">
      <table>
        <thead>
          <tr>
            <th>Boutique</th>
            <th>Contact</th>
            <th>Produits</th>
            <th>KYC</th>
            <th>Statut</th>
          </tr>
        </thead>
        <tbody>
          {items.map((v) => (
            <tr key={v.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(v.id)}>
              <td>
                <div className="cell-primary">{v.name}</div>
                <div className="cell-secondary">
                  {v.city ? `${v.city}, ` : ''}
                  {v.country}
                </div>
              </td>
              <td>
                <div className="cell-secondary">{v.email || '—'}</div>
                <div className="cell-secondary">{v.phone || '—'}</div>
              </td>
              <td>{v.product_count}</td>
              <td>
                <StatusBadge status={v.kyc_status} />
              </td>
              <td>
                {v.verified ? (
                  <span className="badge badge-green">Actif</span>
                ) : (
                  <span className="badge badge-gray">Inactif</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AdminsTable({ items }: { items: Admin[] }) {
  if (items.length === 0) {
    return <EmptyState icon={<IconSecurity width={40} height={40} strokeWidth={1.4} />} title="Aucun compte admin" />
  }
  return (
    <div className="table-card">
      <table>
        <thead>
          <tr>
            <th>Compte</th>
            <th>Rôle</th>
            <th>2FA</th>
            <th>Créé le</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td>
                <div className="cell-primary">{a.email}</div>
                <div className="cell-secondary">#{a.id}</div>
              </td>
              <td>
                <span className="badge badge-gray">{a.role}</span>
              </td>
              <td>
                {a.totp_enabled ? (
                  <span className="badge badge-green">Activée</span>
                ) : (
                  <span className="badge badge-orange">Désactivée</span>
                )}
              </td>
              <td className="cell-secondary">{formatDate(a.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RoleBadges({ roles }: { roles: string[] }) {
  return (
    <>
      {roles.map((r) => (
        <span key={r} className={`badge badge-${ROLE_COLORS[r] || 'gray'}`} style={{ marginRight: 4 }}>
          {ROLE_LABELS[r] || r}
        </span>
      ))}
    </>
  )
}

function UnifiedTable({ items }: { items: UnifiedUser[] }) {
  if (items.length === 0) {
    return <EmptyState icon={<IconCustomers width={40} height={40} strokeWidth={1.4} />} title="Aucun utilisateur trouvé" />
  }
  return (
    <div className="table-card">
      <table>
        <thead>
          <tr>
            <th>Compte</th>
            <th>Contact</th>
            <th>Rôles</th>
            <th>Pays</th>
            <th>Créé le</th>
          </tr>
        </thead>
        <tbody>
          {items.map((u) => (
            <tr key={u.email}>
              <td>
                <div className="cell-primary">{u.name || u.email}</div>
              </td>
              <td>
                <div className="cell-secondary">{u.email || '—'}</div>
                <div className="cell-secondary">{u.phone || '—'}</div>
              </td>
              <td>
                <RoleBadges roles={u.roles} />
              </td>
              <td className="cell-secondary">{u.country || '—'}</td>
              <td className="cell-secondary">{formatDate(u.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RepresentativesTable({ items }: { items: Representative[] }) {
  if (items.length === 0) {
    return <EmptyState icon={<IconSecurity width={40} height={40} strokeWidth={1.4} />} title="Aucun représentant" />
  }
  return (
    <div className="table-card">
      <table>
        <thead>
          <tr>
            <th>Représentant</th>
            <th>Pays</th>
            <th>Niveau</th>
            <th>Commission</th>
            <th>Depuis</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td>
                <div className="cell-primary">{r.name}</div>
                <div className="cell-secondary">{r.email}</div>
              </td>
              <td>{r.is_super_rep ? 'Tous pays' : r.country}</td>
              <td>
                {r.is_super_rep ? (
                  <span className="badge badge-orange">Super représentant</span>
                ) : (
                  <span className="badge badge-green">Représentant</span>
                )}
              </td>
              <td>{r.commission_pct ? `${r.commission_pct}%` : '—'}</td>
              <td className="cell-secondary">{formatDate(r.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

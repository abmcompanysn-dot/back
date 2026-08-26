import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'
import { IconCatalog, IconMoreVertical, IconPlus, IconSearch } from '../../components/Icons'
import { CatalogNav } from './CatalogNav'

interface Product {
  id: number
  name: string
  sku: string
  slug: string
  vendor_id: number
  price_usd: number
  sale_price: string
  on_sale: boolean
  stock: number
  low_stock_threshold: number
  status: string
  type: string
  image: string
  lang: string
}

interface ListResponse {
  items: Product[]
  total: number
  page: number
  page_size: number
}

const PAGE_SIZE = 25

const STATUS_OPTIONS = [
  { value: '', label: 'Tous les statuts' },
  { value: 'active', label: 'Publié' },
  { value: 'inactive', label: 'Masqué' },
]

function stockBadge(stock: number, threshold: number) {
  if (stock <= 0) return <span className="badge badge-red">Épuisé</span>
  if (stock <= threshold) return <span className="badge badge-orange">Faible ({stock})</span>
  return <span className="badge badge-green">En stock ({stock})</span>
}

export function AllProducts() {
  const navigate = useNavigate()
  const [items, setItems] = useState<Product[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [openMenuId, setOpenMenuId] = useState<number | null>(null)
  const [bulkAction, setBulkAction] = useState('')
  const [busy, setBusy] = useState(false)
  // Nom de boutique par vendor_id — le tableau produits affichait juste
  // "#12" jusqu'ici (vendor_id brut, illisible pour un admin sans le
  // connaître par cœur). Chargé une seule fois (~75 vendeurs, pas de
  // pagination nécessaire pour ce lookup).
  const [vendorNames, setVendorNames] = useState<Record<number, string>>({})

  useEffect(() => {
    api
      .get<{ items: { id: number; name: string }[] }>('/admin/api/vendors?page_size=500')
      .then((b) => {
        const map: Record<number, string> = {}
        for (const v of b.items || []) map[v.id] = v.name
        setVendorNames(map)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, query, status])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        admin: 'true',
        page: String(page),
        page_size: String(PAGE_SIZE),
      })
      if (query.trim()) params.set('q', query.trim())
      if (status) params.set('status', status)
      const body = await api.get<ListResponse>(`/admin/api/products?${params.toString()}`)
      setItems(body.items || [])
      setTotal(body.total || 0)
      setSelected(new Set())
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const allSelected = items.length > 0 && selected.size === items.length

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(items.map((p) => p.id)))
  }
  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function toggleStatus(p: Product) {
    const newStatus = p.status === 'active' ? 'inactive' : 'active'
    setItems((prev) => prev.map((x) => (x.id === p.id ? { ...x, status: newStatus } : x)))
    try {
      await api.patch(`/admin/api/products/${p.id}`, { status: newStatus })
    } catch {
      setItems((prev) => prev.map((x) => (x.id === p.id ? { ...x, status: p.status } : x)))
      setError('échec du changement de statut — réessayez.')
    }
  }

  async function deleteOne(p: Product) {
    if (!window.confirm(`Supprimer définitivement "${p.name}" ?`)) return
    setBusy(true)
    try {
      await api.delete<{ deleted: boolean }>(`/admin/api/products/${p.id}`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la suppression')
    } finally {
      setBusy(false)
      setOpenMenuId(null)
    }
  }

  async function runBulkAction() {
    if (!bulkAction || selected.size === 0) return
    if (bulkAction === 'delete' && !window.confirm(`Supprimer ${selected.size} produit(s) définitivement ?`)) return
    setBusy(true)
    try {
      const payload: Record<string, unknown> = { ids: Array.from(selected), action: bulkAction }
      if (bulkAction === 'set_status') payload.status = 'active'
      if (bulkAction === 'set_status_inactive') {
        payload.action = 'set_status'
        payload.status = 'inactive'
      }
      await api.post('/admin/api/products/bulk', payload)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de l\'action groupée')
    } finally {
      setBusy(false)
      setBulkAction('')
    }
  }

  const showEmpty = !loading && !error && items.length === 0 && !query && !status

  return (
    <div>
      <CatalogNav />
      <div className="page-header">
        <div>
          <h2>Catalogue</h2>
          <p className="subtitle">Produits publiés par les vendeurs — {total} au total</p>
        </div>
        <div className="page-header-actions">
          <button className="btn-primary" onClick={() => navigate('/admin/catalog/products/new')}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <IconPlus width={16} height={16} /> Ajouter un produit
            </span>
          </button>
        </div>
      </div>

      {showEmpty ? (
        <EmptyState
          icon={<IconCatalog width={40} height={40} strokeWidth={1.4} />}
          title="Aucun produit enregistré dans le catalogue"
          description="Créez votre premier produit pour commencer à vendre."
          action={{ label: 'Créer le premier produit', onClick: () => navigate('/admin/catalog/products/new') }}
        />
      ) : (
        <>
          <div className="filters-bar">
            <input
              className="search-input"
              placeholder="Rechercher par nom ou SKU…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(1)
              }}
            />
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setPage(1)
              }}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {selected.size > 0 && (
            <div className="bulk-bar">
              <span>{selected.size} sélectionné(s)</span>
              <div className="spacer" />
              <select value={bulkAction} onChange={(e) => setBulkAction(e.target.value)}>
                <option value="">Action groupée…</option>
                <option value="set_status">Publier</option>
                <option value="set_status_inactive">Masquer</option>
                <option value="delete">Supprimer</option>
              </select>
              <button className="btn-primary" disabled={!bulkAction || busy} onClick={runBulkAction}>
                Appliquer
              </button>
            </div>
          )}

          {error && <p className="error-text">{error}</p>}
          {loading && <p>Chargement…</p>}

          {!loading && items.length === 0 && (
            <EmptyState
              icon={<IconSearch width={40} height={40} strokeWidth={1.4} />}
              title="Aucun résultat"
              description="Essayez un autre terme de recherche ou changez les filtres."
            />
          )}

          {!loading && items.length > 0 && (
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 32 }}>
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                    </th>
                    <th style={{ width: 48 }}></th>
                    <th>Nom &amp; SKU</th>
                    <th>Boutique</th>
                    <th>Prix</th>
                    <th>Stock</th>
                    <th>Statut</th>
                    <th style={{ width: 40 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} />
                      </td>
                      <td>
                        {p.image ? (
                          <img className="thumb" src={p.image} alt="" />
                        ) : (
                          <div className="thumb-placeholder">
                            <IconCatalog width={16} height={16} />
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="cell-primary">{p.name}</div>
                        <div className="cell-secondary">{p.sku || '—'}</div>
                      </td>
                      <td>
                        <a href={`/admin/vendors/${p.vendor_id}`} style={{ color: 'var(--miad-green)' }}>
                          {vendorNames[p.vendor_id] || `#${p.vendor_id}`}
                        </a>
                      </td>
                      <td>
                        {p.on_sale && p.sale_price ? (
                          <>
                            <span style={{ textDecoration: 'line-through', color: '#999', marginRight: 6 }}>
                              ${p.price_usd.toFixed(2)}
                            </span>
                            <span className="cell-primary">${p.sale_price}</span>
                          </>
                        ) : (
                          <span>${p.price_usd.toFixed(2)}</span>
                        )}
                      </td>
                      <td>{stockBadge(p.stock, p.low_stock_threshold)}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <label className="toggle" title={p.status === 'active' ? 'Publié — cliquer pour masquer' : 'Masqué — cliquer pour publier'}>
                            <input type="checkbox" checked={p.status === 'active'} onChange={() => toggleStatus(p)} />
                            <span className="slider" />
                          </label>
                          <StatusBadge status={p.status === 'active' ? 'published' : 'masqué'} />
                        </div>
                      </td>
                      <td>
                        <div className="row-menu">
                          <button
                            className="row-menu-btn"
                            onClick={() => setOpenMenuId(openMenuId === p.id ? null : p.id)}
                          >
                            <IconMoreVertical width={16} height={16} />
                          </button>
                          {openMenuId === p.id && (
                            <div className="row-menu-dropdown" onMouseLeave={() => setOpenMenuId(null)}>
                              <button onClick={() => window.open(`https://miadmarket.ca/?v=product&slug=${p.slug}`, '_blank')}>
                                Voir sur le site
                              </button>
                              <button onClick={() => navigate(`/admin/catalog/products/${p.id}/edit`)}>Éditer</button>
                              <button className="danger" disabled={busy} onClick={() => deleteOne(p)}>
                                Supprimer
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

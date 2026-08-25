import { useEffect, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'
import { IconPlus, IconTag, IconTrash } from '../../components/Icons'
import { CatalogNav } from './CatalogNav'

interface Brand {
  id: number
  name: string
  slug: string
  logo_url: string
  description: string
  website_url: string
  status: string
  product_count: number
}

const EMPTY_DRAFT = { name: '', logo_url: '', description: '', website_url: '', status: 'active' }

export function Brands() {
  const [items, setItems] = useState<Brand[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const body = await api.get<{ items: Brand[] }>('/admin/api/brands')
      setItems(body.items || [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  async function createBrand() {
    if (!draft.name.trim()) return
    setSaving(true)
    try {
      await api.post('/admin/api/brands', draft)
      setDraft(EMPTY_DRAFT)
      setShowForm(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la création')
    } finally {
      setSaving(false)
    }
  }

  async function toggleStatus(b: Brand) {
    const newStatus = b.status === 'active' ? 'inactive' : 'active'
    setItems((prev) => prev.map((x) => (x.id === b.id ? { ...x, status: newStatus } : x)))
    try {
      await api.patch(`/admin/api/brands/${b.id}`, { status: newStatus })
    } catch {
      setItems((prev) => prev.map((x) => (x.id === b.id ? { ...x, status: b.status } : x)))
      setError('échec du changement de statut')
    }
  }

  async function remove(b: Brand) {
    if (!window.confirm(`Supprimer la marque "${b.name}" ?`)) return
    try {
      await api.delete(`/admin/api/brands/${b.id}`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la suppression')
    }
  }

  return (
    <div>
      <CatalogNav />
      <div className="page-header">
        <div>
          <h2>Marques</h2>
          <p className="subtitle">Marques officielles vendues sur la marketplace</p>
        </div>
        <div className="page-header-actions">
          <button className="btn-primary" onClick={() => setShowForm((v) => !v)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <IconPlus width={16} height={16} /> Ajouter une marque
            </span>
          </button>
        </div>
      </div>

      {showForm && (
        <div className="form-card" style={{ marginBottom: 20 }}>
          <div className="form-grid">
            <div className="form-field">
              <label>Nom de la marque</label>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="form-field">
              <label>Logo (URL)</label>
              <input value={draft.logo_url} onChange={(e) => setDraft({ ...draft, logo_url: e.target.value })} placeholder="https://img.miadmarket.ca/..." />
            </div>
            <div className="form-field">
              <label>Site web officiel</label>
              <input value={draft.website_url} onChange={(e) => setDraft({ ...draft, website_url: e.target.value })} />
            </div>
            <div className="form-field">
              <label>Statut</label>
              <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <div className="form-field full">
              <label>Description</label>
              <textarea rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </div>
          </div>
          <div className="form-actions">
            <button className="btn-primary" disabled={saving || !draft.name.trim()} onClick={createBrand}>
              {saving ? 'Enregistrement…' : 'Créer la marque'}
            </button>
            <button className="btn-ghost" onClick={() => setShowForm(false)}>
              Annuler
            </button>
          </div>
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}

      {!loading && items.length === 0 && (
        <EmptyState
          icon={<IconTag width={40} height={40} strokeWidth={1.4} />}
          title="Aucune marque enregistrée"
          description="Ajoutez les marques officielles vendues sur la marketplace."
          action={{ label: 'Ajouter une marque', onClick: () => setShowForm(true) }}
        />
      )}

      {!loading && items.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th style={{ width: 48 }}></th>
                <th>Nom</th>
                <th>Produits</th>
                <th>Statut</th>
                <th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => (
                <tr key={b.id}>
                  <td>
                    {b.logo_url ? (
                      <img className="thumb" src={b.logo_url} alt="" />
                    ) : (
                      <div className="thumb-placeholder">
                        <IconTag width={16} height={16} />
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="cell-primary">{b.name}</div>
                    {b.website_url && <div className="cell-secondary">{b.website_url}</div>}
                  </td>
                  <td>{b.product_count}</td>
                  <td>
                    <label className="toggle">
                      <input type="checkbox" checked={b.status === 'active'} onChange={() => toggleStatus(b)} />
                      <span className="slider" />
                    </label>
                    <StatusBadge status={b.status === 'active' ? 'active' : 'inactive'} />
                  </td>
                  <td>
                    <div className="row-actions">
                      <button onClick={() => remove(b)} title="Supprimer">
                        <IconTrash width={14} height={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

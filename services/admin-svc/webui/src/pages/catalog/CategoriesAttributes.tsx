import { useEffect, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { IconPlus, IconTag, IconTrash, IconTree } from '../../components/Icons'
import { CatalogNav } from './CatalogNav'

interface Category {
  id: number
  parent_id: number
  name: string
  slug: string
  sort_order: number
  commission_rate: number | null
  count: number
}

interface AttributeValue {
  id: number
  value: string
  meta: string
}
interface Attribute {
  id: number
  name: string
  slug: string
  values: AttributeValue[]
}

const EMPTY_CAT = { name_fr: '', name_en: '', parent_id: '', commission_rate: '' }

function CategoriesTree() {
  const [items, setItems] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [draft, setDraft] = useState(EMPTY_CAT)
  const [saving, setSaving] = useState(false)
  const [editingCommission, setEditingCommission] = useState<number | null>(null)
  const [commissionDraft, setCommissionDraft] = useState('')

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const body = await api.get<{ categories: Category[] }>('/admin/api/categories')
      setItems(body.categories || [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  function children(parentId: number) {
    return items.filter((c) => c.parent_id === parentId).sort((a, b) => a.sort_order - b.sort_order)
  }
  const roots = children(0)

  async function create() {
    if (!draft.name_fr.trim()) return
    setSaving(true)
    try {
      await api.post('/admin/api/categories', {
        name_fr: draft.name_fr,
        name_en: draft.name_en,
        parent_id: draft.parent_id ? Number(draft.parent_id) : 0,
        commission_rate: draft.commission_rate ? Number(draft.commission_rate) : null,
      })
      setDraft(EMPTY_CAT)
      setShowForm(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la création')
    } finally {
      setSaving(false)
    }
  }

  async function remove(c: Category) {
    if (!window.confirm(`Supprimer la catégorie "${c.name}" ?`)) return
    try {
      await api.delete(`/admin/api/categories/${c.id}`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la suppression — vérifiez qu\'aucun produit ne l\'utilise')
    }
  }

  async function move(c: Category, direction: -1 | 1) {
    const siblings = children(c.parent_id)
    const idx = siblings.findIndex((s) => s.id === c.id)
    const swapIdx = idx + direction
    if (swapIdx < 0 || swapIdx >= siblings.length) return
    const reordered = [...siblings]
    ;[reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]]
    const otherIDs = items.filter((x) => x.parent_id !== c.parent_id).map((x) => x.id)
    try {
      await api.post('/admin/api/categories/reorder', { ids: [...reordered.map((r) => r.id), ...otherIDs] })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec du réordonnancement')
    }
  }

  async function saveCommission(c: Category) {
    try {
      if (commissionDraft.trim() === '') {
        await api.patch(`/admin/api/categories/${c.id}`, { clear_commission: true })
      } else {
        await api.patch(`/admin/api/categories/${c.id}`, { commission_rate: Number(commissionDraft) })
      }
      setEditingCommission(null)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la mise à jour')
    }
  }

  function renderRow(c: Category, depth: number) {
    const kids = children(c.id)
    return (
      <div key={c.id}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            paddingLeft: 12 + depth * 24,
            borderBottom: '1px solid #eee',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <button className="btn-ghost" style={{ padding: '1px 6px', fontSize: 10 }} onClick={() => move(c, -1)}>
              ▲
            </button>
            <button className="btn-ghost" style={{ padding: '1px 6px', fontSize: 10 }} onClick={() => move(c, 1)}>
              ▼
            </button>
          </div>
          <span className="cell-primary" style={{ flex: 1 }}>
            {c.name}
          </span>
          <span className="cell-secondary">{c.count} produit(s)</span>
          {editingCommission === c.id ? (
            <>
              <input
                style={{ width: 70, padding: '4px 6px', fontSize: 12 }}
                placeholder="défaut"
                value={commissionDraft}
                onChange={(e) => setCommissionDraft(e.target.value)}
              />
              <button className="btn-primary" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => saveCommission(c)}>
                OK
              </button>
            </>
          ) : (
            <button
              className="btn-ghost"
              style={{ padding: '4px 8px', fontSize: 12 }}
              onClick={() => {
                setEditingCommission(c.id)
                setCommissionDraft(c.commission_rate != null ? String(c.commission_rate) : '')
              }}
            >
              {c.commission_rate != null ? `${c.commission_rate}%` : 'Commission par défaut'}
            </button>
          )}
          <button onClick={() => remove(c)} title="Supprimer" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#c02020' }}>
            <IconTrash width={14} height={14} />
          </button>
        </div>
        {kids.map((k) => renderRow(k, depth + 1))}
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h3 style={{ margin: 0 }}>Catégories</h3>
          <p className="subtitle">Arborescence, ordre d'affichage et commission par catégorie</p>
        </div>
        <div className="page-header-actions">
          <button className="btn-primary" onClick={() => setShowForm((v) => !v)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <IconPlus width={16} height={16} /> Ajouter une catégorie
            </span>
          </button>
        </div>
      </div>

      {showForm && (
        <div className="form-card" style={{ marginBottom: 16 }}>
          <div className="form-grid">
            <div className="form-field">
              <label>Nom (FR)</label>
              <input value={draft.name_fr} onChange={(e) => setDraft({ ...draft, name_fr: e.target.value })} />
            </div>
            <div className="form-field">
              <label>Nom (EN)</label>
              <input value={draft.name_en} onChange={(e) => setDraft({ ...draft, name_en: e.target.value })} placeholder="optionnel" />
            </div>
            <div className="form-field">
              <label>Catégorie parente</label>
              <select value={draft.parent_id} onChange={(e) => setDraft({ ...draft, parent_id: e.target.value })}>
                <option value="">— catégorie racine —</option>
                {items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label>Commission (%) — override</label>
              <input
                type="number"
                value={draft.commission_rate}
                onChange={(e) => setDraft({ ...draft, commission_rate: e.target.value })}
                placeholder="taux global par défaut"
              />
            </div>
          </div>
          <div className="form-actions">
            <button className="btn-primary" disabled={saving || !draft.name_fr.trim()} onClick={create}>
              {saving ? 'Enregistrement…' : 'Créer'}
            </button>
            <button className="btn-ghost" onClick={() => setShowForm(false)}>
              Annuler
            </button>
          </div>
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}
      {!loading && roots.length === 0 && (
        <EmptyState
          icon={<IconTree width={40} height={40} strokeWidth={1.4} />}
          title="Aucune catégorie"
          description="Créez votre première catégorie pour organiser le catalogue."
        />
      )}
      {!loading && roots.length > 0 && <div className="table-card">{roots.map((c) => renderRow(c, 0))}</div>}
    </div>
  )
}

function Attributes() {
  const [items, setItems] = useState<Attribute[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newAttrName, setNewAttrName] = useState('')
  const [newValueDraft, setNewValueDraft] = useState<Record<number, string>>({})

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const body = await api.get<{ items: Attribute[] }>('/admin/api/attributes')
      setItems(body.items || [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  async function createAttribute() {
    if (!newAttrName.trim()) return
    try {
      await api.post('/admin/api/attributes', { name: newAttrName })
      setNewAttrName('')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la création')
    }
  }

  async function removeAttribute(a: Attribute) {
    if (!window.confirm(`Supprimer l'attribut "${a.name}" et toutes ses valeurs ?`)) return
    try {
      await api.delete(`/admin/api/attributes/${a.id}`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la suppression')
    }
  }

  async function addValue(a: Attribute) {
    const value = (newValueDraft[a.id] || '').trim()
    if (!value) return
    try {
      await api.post(`/admin/api/attributes/${a.id}/values`, { value })
      setNewValueDraft({ ...newValueDraft, [a.id]: '' })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de l\'ajout')
    }
  }

  async function removeValue(v: AttributeValue) {
    try {
      await api.delete(`/admin/api/attribute-values/${v.id}`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la suppression')
    }
  }

  return (
    <div style={{ marginTop: 32 }}>
      <div className="page-header">
        <div>
          <h3 style={{ margin: 0 }}>Attributs &amp; Variations</h3>
          <p className="subtitle">Spécifications produit (couleur, pointure, matériau…)</p>
        </div>
      </div>

      <div className="form-card" style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div className="form-field" style={{ flex: 1 }}>
          <label>Nouvel attribut</label>
          <input value={newAttrName} onChange={(e) => setNewAttrName(e.target.value)} placeholder="ex: Couleur, Pointure, Matériau" />
        </div>
        <button className="btn-primary" onClick={createAttribute} disabled={!newAttrName.trim()}>
          Créer
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}
      {!loading && items.length === 0 && (
        <EmptyState icon={<IconTag width={40} height={40} strokeWidth={1.4} />} title="Aucun attribut défini" />
      )}

      {!loading &&
        items.map((a) => (
          <div className="form-card" key={a.id} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <strong>{a.name}</strong>
              <button onClick={() => removeAttribute(a)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#c02020' }}>
                <IconTrash width={14} height={14} />
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {a.values.map((v) => (
                <span key={v.id} className="badge badge-gray" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {v.value}
                  <button
                    onClick={() => removeValue(v)}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#888', padding: 0, fontSize: 13 }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                style={{ padding: '6px 8px', fontSize: 12, border: '1px solid #ccc', borderRadius: 6 }}
                placeholder="ajouter une valeur…"
                value={newValueDraft[a.id] || ''}
                onChange={(e) => setNewValueDraft({ ...newValueDraft, [a.id]: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && addValue(a)}
              />
              <button className="btn-ghost" onClick={() => addValue(a)}>
                Ajouter
              </button>
            </div>
          </div>
        ))}
    </div>
  )
}

export function CategoriesAttributes() {
  return (
    <div>
      <CatalogNav />
      <div className="page-header">
        <div>
          <h2>Catégories &amp; Attributs</h2>
          <p className="subtitle">Arborescence des catégories et spécifications produit</p>
        </div>
      </div>
      <CategoriesTree />
      <Attributes />
    </div>
  )
}

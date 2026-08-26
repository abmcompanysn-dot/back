import { useEffect, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { IconSecurity } from '../../components/Icons'

// RBAC par module (2026-08-26) : un rôle = un nom + une liste de modules
// autorisés (tout ou rien par module, pas de granularité lecture/écriture
// pour l'instant — choix volontairement simple, voir la discussion qui a
// mené à ce module). Un admin sans role_id garde l'accès total (ancien
// système claims["role"]=="admin", inchangé) — ces rôles n'ajoutent qu'une
// restriction optionnelle, assignée depuis l'onglet Admins.
const MODULES: { key: string; label: string }[] = [
  { key: 'dashboard', label: 'Tableau de bord' },
  { key: 'catalog', label: 'Catalogue' },
  { key: 'media', label: 'Médiathèque' },
  { key: 'vendors', label: 'Vendeurs' },
  { key: 'orders', label: 'Commandes' },
  { key: 'users', label: 'Utilisateurs' },
  { key: 'shipping', label: 'Livraison' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'email_templates', label: 'Modèles de messages' },
  { key: 'finance', label: 'Finances' },
  { key: 'security', label: 'Sécurité' },
  { key: 'system', label: 'Système' },
  { key: 'configuration', label: 'Configuration' },
]

interface AdminRole {
  id: number
  name: string
  permissions: { modules?: string[] }
  created_at: string
}

const EMPTY_DRAFT = { name: '', modules: [] as string[] }

export function AdminRoles() {
  const [roles, setRoles] = useState<AdminRole[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingID, setEditingID] = useState<number | 'new' | null>(null)
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const body = await api.get<{ items: AdminRole[] }>('/admin/api/admin-roles')
      setRoles(body.items || [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  function startCreate() {
    setDraft(EMPTY_DRAFT)
    setEditingID('new')
  }

  function startEdit(role: AdminRole) {
    setDraft({ name: role.name, modules: role.permissions?.modules || [] })
    setEditingID(role.id)
  }

  function toggleModule(key: string) {
    setDraft((d) => ({
      ...d,
      modules: d.modules.includes(key) ? d.modules.filter((m) => m !== key) : [...d.modules, key],
    }))
  }

  async function save() {
    if (!draft.name.trim()) return
    setSaving(true)
    setError(null)
    try {
      if (editingID === 'new') {
        await api.post('/admin/api/admin-roles', draft)
      } else {
        await api.patch(`/admin/api/admin-roles/${editingID}`, draft)
      }
      setEditingID(null)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "échec de l'enregistrement")
    } finally {
      setSaving(false)
    }
  }

  async function remove(role: AdminRole) {
    if (!window.confirm(`Supprimer le rôle "${role.name}" ? Les admins qui l'ont repasseront en accès total.`)) return
    try {
      await api.delete(`/admin/api/admin-roles/${role.id}`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la suppression')
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Rôles &amp; Permissions</h2>
          <p className="subtitle">Chaque rôle donne accès à une liste de modules — assignez-le depuis l'onglet Admins</p>
        </div>
        <button className="btn-primary" onClick={startCreate} type="button">
          + Nouveau rôle
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}

      {editingID !== null && (
        <div className="form-card" style={{ marginBottom: 20 }}>
          <div className="form-field">
            <label>Nom du rôle</label>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="ex: Gestion commandes"
            />
          </div>
          <div className="form-field" style={{ marginTop: 12 }}>
            <label>Modules accessibles</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8, marginTop: 8 }}>
              {MODULES.map((m) => (
                <label key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={draft.modules.includes(m.key)} onChange={() => toggleModule(m.key)} />
                  {m.label}
                </label>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="btn-primary" disabled={saving || !draft.name.trim()} onClick={save} type="button">
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
            <button className="btn-ghost" onClick={() => setEditingID(null)} type="button">
              Annuler
            </button>
          </div>
        </div>
      )}

      {!loading && roles.length === 0 && editingID === null && (
        <EmptyState icon={<IconSecurity width={40} height={40} strokeWidth={1.4} />} title="Aucun rôle créé" />
      )}

      {!loading && roles.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Rôle</th>
                <th>Modules</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.id}>
                  <td className="cell-primary">{r.name}</td>
                  <td>
                    {(r.permissions?.modules || []).length === 0 ? (
                      <span className="cell-secondary">Aucun module</span>
                    ) : (
                      (r.permissions?.modules || []).map((m) => (
                        <span key={m} className="badge badge-gray" style={{ marginRight: 4 }}>
                          {MODULES.find((mod) => mod.key === m)?.label || m}
                        </span>
                      ))
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn-ghost" onClick={() => startEdit(r)} type="button">
                      Éditer
                    </button>{' '}
                    <button className="btn-ghost" onClick={() => remove(r)} type="button">
                      Supprimer
                    </button>
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

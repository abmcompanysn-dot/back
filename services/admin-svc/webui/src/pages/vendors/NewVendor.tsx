import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../../lib/api'
import { VendorNav } from './VendorNav'
import { ImageUploadField } from '../../components/ImageUploadField'

const EMPTY = { name: '', email: '', phone: '', country: '', city: '', logo_url: '' }

export function NewVendor() {
  const navigate = useNavigate()
  const [draft, setDraft] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    if (!draft.name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const body = await api.post<{ id: number }>('/admin/api/vendors', draft)
      navigate(`/admin/vendors/${body.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la création')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <VendorNav />
      <div className="page-header">
        <div>
          <h2>Ajouter un Vendeur</h2>
          <p className="subtitle">Création manuelle par l'admin — le compte est activé immédiatement</p>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="form-card">
        <div className="form-grid">
          <div className="form-field">
            <label>Nom commercial</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="form-field">
            <label>Email</label>
            <input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
          </div>
          <div className="form-field">
            <label>Téléphone</label>
            <input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
          </div>
          <div className="form-field">
            <label>Pays</label>
            <input value={draft.country} onChange={(e) => setDraft({ ...draft, country: e.target.value })} />
          </div>
          <div className="form-field">
            <label>Ville</label>
            <input value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} />
          </div>
          <ImageUploadField
            label="Logo"
            value={draft.logo_url}
            prefix="vendors"
            onChange={(url) => setDraft({ ...draft, logo_url: url })}
          />
        </div>
        <p className="hint" style={{ marginTop: 12 }}>
          Aucun compte client (identifiants de connexion) n'est créé automatiquement — utilisez la
          création de compte vendeur habituelle (voir node scripts/miad.mjs create-vendor) si un accès
          de connexion est nécessaire pour ce vendeur.
        </p>
        <div className="form-actions">
          <button className="btn-primary" disabled={saving || !draft.name.trim()} onClick={create}>
            {saving ? 'Création…' : 'Créer la boutique'}
          </button>
          <button className="btn-ghost" onClick={() => navigate('/admin/vendors')}>
            Annuler
          </button>
        </div>
      </div>
    </div>
  )
}

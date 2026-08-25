import { useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { IconSearch, IconTrash } from '../../components/Icons'

interface MediaFile {
  id: number
  filename: string
  url: string
  folder: string
  size_bytes: number
  content_type: string
  uploaded_by: string
  created_at: string
}

const FOLDERS = [
  { value: '', label: 'Tous les dossiers' },
  { value: 'products', label: 'Produits' },
  { value: 'vendors', label: 'Vendeurs' },
  { value: 'categories', label: 'Catégories' },
]

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

export function MediaLibrary() {
  const [items, setItems] = useState<MediaFile[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState('')
  const [uploadFolder, setUploadFolder] = useState('products')
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [selected, setSelected] = useState<MediaFile | null>(null)
  const [showOrphans, setShowOrphans] = useState(false)
  const [orphans, setOrphans] = useState<MediaFile[]>([])
  const [scanningOrphans, setScanningOrphans] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, query])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page_size: '60' })
      if (folder) params.set('folder', folder)
      if (query.trim()) params.set('q', query.trim())
      const body = await api.get<{ items: MediaFile[]; total: number }>(`/admin/api/media?${params.toString()}`)
      setItems(body.items || [])
      setTotal(body.total || 0)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    setUploading(true)
    setError(null)
    try {
      for (const file of Array.from(files)) {
        const form = new FormData()
        form.append('file', file)
        form.append('prefix', uploadFolder)
        const res = await fetch('/admin/api/media/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${localStorage.getItem('miad_admin_jwt') || ''}` },
          body: form,
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body?.error?.message || 'échec de l\'upload')
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'échec de l\'upload')
    } finally {
      setUploading(false)
    }
  }

  async function remove(f: MediaFile) {
    if (!window.confirm(`Supprimer "${f.filename}" définitivement ?`)) return
    try {
      await api.delete(`/admin/api/media/${f.id}`)
      setSelected(null)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la suppression')
    }
  }

  async function scanOrphans() {
    setScanningOrphans(true)
    setError(null)
    try {
      const body = await api.get<{ items: MediaFile[] }>('/admin/api/media/orphans')
      setOrphans(body.items || [])
      setShowOrphans(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la détection')
    } finally {
      setScanningOrphans(false)
    }
  }

  const list = showOrphans ? orphans : items

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Médiathèque</h2>
          <p className="subtitle">{total} fichier{total > 1 ? 's' : ''} — images produits, vendeurs, catégories</p>
        </div>
        <div className="page-header-actions">
          <button className="btn-ghost" disabled={scanningOrphans} onClick={scanOrphans}>
            {scanningOrphans ? 'Analyse…' : 'Détecter les orphelins'}
          </button>
          <select
            value={uploadFolder}
            onChange={(e) => setUploadFolder(e.target.value)}
            title="Dossier de destination pour le prochain téléversement"
          >
            {FOLDERS.filter((f) => f.value).map((f) => (
              <option key={f.value} value={f.value}>
                Envoyer vers : {f.label}
              </option>
            ))}
          </select>
          <button className="btn-primary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? 'Envoi…' : '+ Téléverser'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => e.target.files && uploadFiles(e.target.files)}
          />
        </div>
      </div>

      {showOrphans && (
        <div className="bulk-bar">
          <span>{orphans.length} fichier(s) orphelin(s) — non référencés par aucun produit/boutique/catégorie</span>
          <div className="spacer" />
          <button className="btn-ghost" onClick={() => setShowOrphans(false)}>
            Revenir à la médiathèque
          </button>
        </div>
      )}

      {!showOrphans && (
        <div className="filters-bar">
          <input className="search-input" placeholder="Rechercher un fichier…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select value={folder} onChange={(e) => setFolder(e.target.value)}>
            {FOLDERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div
        className={`image-dropzone${dragOver ? ' dragover' : ''}`}
        style={{ width: '100%', height: 60, marginBottom: 16, fontSize: 13 }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files)
        }}
      >
        Glissez-déposez des images ici pour les téléverser
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && !showOrphans && <p>Chargement…</p>}

      {!loading && list.length === 0 && (
        <EmptyState
          icon={<IconSearch width={40} height={40} strokeWidth={1.4} />}
          title={showOrphans ? 'Aucun fichier orphelin' : 'Aucun fichier'}
          description={showOrphans ? 'Tous les fichiers sont référencés quelque part.' : 'Téléversez votre première image.'}
        />
      )}

      {list.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
          {list.map((f) => (
            <div
              key={f.id}
              className="table-card"
              style={{ padding: 8, cursor: 'pointer' }}
              onClick={() => setSelected(f)}
            >
              <img src={f.url} alt={f.filename} style={{ width: '100%', height: 100, objectFit: 'cover', borderRadius: 6, background: '#f0f1f3' }} />
              <div className="cell-secondary" style={{ marginTop: 6, wordBreak: 'break-all' }}>
                {f.filename}
              </div>
              <div className="cell-secondary">{formatSize(f.size_bytes)}</div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
          onClick={() => setSelected(null)}
        >
          <div className="form-card" style={{ maxWidth: 480, width: '90%' }} onClick={(e) => e.stopPropagation()}>
            <img src={selected.url} alt={selected.filename} style={{ width: '100%', borderRadius: 8, marginBottom: 12 }} />
            <p className="cell-primary">{selected.filename}</p>
            <p className="cell-secondary">
              {formatSize(selected.size_bytes)} · {selected.content_type} · dossier {selected.folder}
            </p>
            <p className="cell-secondary" style={{ wordBreak: 'break-all' }}>
              {selected.url}
            </p>
            <div className="form-actions">
              <button className="btn-ghost" onClick={() => navigator.clipboard.writeText(selected.url)}>
                Copier l'URL
              </button>
              <button className="btn-danger" onClick={() => remove(selected)}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <IconTrash width={14} height={14} /> Supprimer
                </span>
              </button>
              <button className="btn-ghost" onClick={() => setSelected(null)}>
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

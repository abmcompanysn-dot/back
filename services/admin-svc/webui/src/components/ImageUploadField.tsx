import { useRef, useState } from 'react'

// ImageUploadField — même mécanisme d'upload que la galerie de
// ProductForm.tsx (POST /admin/api/media/upload, drag&drop + clic),
// mais pour UNE seule image (logo, bannière, image de catégorie…).
// Ajouté le 2026-08-27 : avant ce composant, la fiche vendeur (et
// probablement d'autres écrans) n'avait qu'un simple champ texte où
// coller une URL à la main — seule ProductForm avait un vrai upload,
// incohérence signalée par le fondateur.
interface ImageUploadFieldProps {
  label: string
  value: string
  onChange: (url: string) => void
  prefix: string // dossier MinIO cible, ex: "vendors", "categories"
}

export function ImageUploadField({ label, value, onChange, prefix }: ImageUploadFieldProps) {
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function uploadFile(file: File) {
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('prefix', prefix)
      const res = await fetch('/admin/api/media/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('miad_admin_jwt') || ''}` },
        body: form,
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error?.message || "échec de l'upload")
      onChange(body.url)
    } catch (err) {
      setError(err instanceof Error ? err.message : "échec de l'upload")
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="form-field">
      <label>{label}</label>
      <div className="image-gallery">
        {value && (
          <div className="image-slot">
            <img src={value} alt="" />
            <button className="remove-btn" onClick={() => onChange('')} type="button">
              ×
            </button>
          </div>
        )}
        {!value && (
          <div
            className={`image-dropzone${dragOver ? ' dragover' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0])
            }}
          >
            {uploading ? '…' : '+'}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])}
        />
      </div>
      {error && <p className="hint" style={{ color: 'var(--color-danger, #c00)' }}>{error}</p>}
      <p className="hint" style={{ marginTop: 8 }}>Glissez-déposez une image ou cliquez sur +.</p>
    </div>
  )
}

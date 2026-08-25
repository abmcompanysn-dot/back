import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ApiError, api } from '../../lib/api'
import { CatalogNav } from './CatalogNav'

interface Vendor {
  id: number
  name: string
}
interface Category {
  id: number
  name: string
}
interface Brand {
  id: number
  name: string
}

interface Draft {
  vendor_id: string
  category_id: string
  brand_id: string
  name_fr: string
  name_en: string
  slug: string
  description: string
  short_description: string
  price_usd: string
  sale_price_usd: string
  sku: string
  barcode: string
  stock: string
  low_stock_threshold: string
  backorders_allowed: boolean
  images: string[]
  weight_kg: string
  length_cm: string
  width_cm: string
  height_cm: string
  shipping_class: string
  meta_title: string
  meta_description: string
}

const EMPTY: Draft = {
  vendor_id: '',
  category_id: '',
  brand_id: '',
  name_fr: '',
  name_en: '',
  slug: '',
  description: '',
  short_description: '',
  price_usd: '',
  sale_price_usd: '',
  sku: '',
  barcode: '',
  stock: '0',
  low_stock_threshold: '3',
  backorders_allowed: false,
  images: [],
  weight_kg: '',
  length_cm: '',
  width_cm: '',
  height_cm: '',
  shipping_class: '',
  meta_title: '',
  meta_description: '',
}

const TABS = [
  { key: 'general', label: 'Informations générales' },
  { key: 'category', label: 'Catégorisation' },
  { key: 'pricing', label: 'Prix & Inventaire' },
  { key: 'media', label: 'Médias' },
  { key: 'shipping', label: 'Livraison' },
  { key: 'seo', label: 'SEO' },
]

export function ProductForm() {
  const { id } = useParams()
  const isEdit = Boolean(id)
  const navigate = useNavigate()
  const [tab, setTab] = useState('general')
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [brands, setBrands] = useState<Brand[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.get<{ items: Vendor[] }>('/admin/api/vendors').then((b) => setVendors(b.items || [])).catch(() => {})
    api.get<{ categories: Category[] }>('/admin/api/categories').then((b) => setCategories(b.categories || [])).catch(() => {})
    api.get<{ items: Brand[] }>('/admin/api/brands').then((b) => setBrands(b.items || [])).catch(() => {})
  }, [])

  useEffect(() => {
    if (!isEdit) return
    api
      .get<any>(`/admin/api/products/${id}`)
      .then((p) => {
        setDraft({
          vendor_id: String(p.vendor_id ?? ''),
          category_id: String(p.category_id ?? ''),
          brand_id: String(p.brand_id ?? ''),
          name_fr: p.name ?? '',
          name_en: '',
          slug: p.slug ?? '',
          description: p.description ?? '',
          short_description: '',
          price_usd: String(p.price_usd ?? ''),
          sale_price_usd: p.sale_price ? String(p.sale_price) : '',
          sku: p.sku ?? '',
          barcode: '',
          stock: String(p.stock ?? 0),
          low_stock_threshold: String(p.low_stock_threshold ?? 3),
          backorders_allowed: false,
          images: (p.images || []).map((im: { src: string }) => im.src),
          weight_kg: '',
          length_cm: '',
          width_cm: '',
          height_cm: '',
          shipping_class: '',
          meta_title: '',
          meta_description: '',
        })
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'échec du chargement du produit'))
  }, [id, isEdit])

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  async function uploadFiles(files: FileList | File[]) {
    setUploading(true)
    setError(null)
    try {
      for (const file of Array.from(files)) {
        const form = new FormData()
        form.append('file', file)
        form.append('prefix', 'products')
        const res = await fetch('/admin/api/media/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${localStorage.getItem('miad_admin_jwt') || ''}` },
          body: form,
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body?.error?.message || 'échec de l\'upload')
        set('images', [...draft.images, body.url])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'échec de l\'upload')
    } finally {
      setUploading(false)
    }
  }

  function removeImage(url: string) {
    set('images', draft.images.filter((u) => u !== url))
  }

  async function save() {
    if (!draft.name_fr.trim()) {
      setError('le nom du produit (FR) est obligatoire')
      setTab('general')
      return
    }
    if (!isEdit && !draft.vendor_id) {
      setError('le vendeur est obligatoire')
      setTab('category')
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (isEdit) {
        await api.patch(`/admin/api/products/${id}`, {
          name: draft.name_fr,
          description: draft.description,
          short_description: draft.short_description,
          category_id: draft.category_id ? Number(draft.category_id) : undefined,
          brand_id: draft.brand_id ? Number(draft.brand_id) : undefined,
          price_usd: draft.price_usd ? Number(draft.price_usd) : undefined,
          sale_price_usd: draft.sale_price_usd ? Number(draft.sale_price_usd) : null,
          sku: draft.sku,
          barcode: draft.barcode,
          stock: Number(draft.stock || 0),
          low_stock_threshold: Number(draft.low_stock_threshold || 3),
          backorders_allowed: draft.backorders_allowed,
          images: draft.images,
          weight_kg: draft.weight_kg ? Number(draft.weight_kg) : undefined,
          length_cm: draft.length_cm ? Number(draft.length_cm) : undefined,
          width_cm: draft.width_cm ? Number(draft.width_cm) : undefined,
          height_cm: draft.height_cm ? Number(draft.height_cm) : undefined,
          shipping_class: draft.shipping_class,
          meta_title: draft.meta_title,
          meta_description: draft.meta_description,
        })
      } else {
        await api.post('/admin/api/products', {
          vendor_id: Number(draft.vendor_id),
          category_id: draft.category_id ? Number(draft.category_id) : 0,
          brand_id: draft.brand_id ? Number(draft.brand_id) : 0,
          name_fr: draft.name_fr,
          name_en: draft.name_en,
          price_usd: Number(draft.price_usd || 0),
          sku: draft.sku,
          barcode: draft.barcode,
          stock: Number(draft.stock || 0),
          images: draft.images,
          is_variable: false,
        })
      }
      navigate('/admin/catalog/products')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de l\'enregistrement')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <CatalogNav />
      <div className="page-header">
        <div>
          <h2>{isEdit ? 'Éditer le produit' : 'Ajouter un produit'}</h2>
          <p className="subtitle">{isEdit ? `Produit #${id}` : 'Créer une nouvelle fiche produit'}</p>
        </div>
      </div>

      <div className="form-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)} type="button">
            {t.label}
          </button>
        ))}
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="form-card">
        {tab === 'general' && (
          <div className="form-grid">
            <div className="form-field">
              <label>Nom du produit (FR)</label>
              <input value={draft.name_fr} onChange={(e) => set('name_fr', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Nom du produit (EN)</label>
              <input value={draft.name_en} onChange={(e) => set('name_en', e.target.value)} placeholder="optionnel — repli sur le FR" />
            </div>
            <div className="form-field full">
              <label>Description courte</label>
              <textarea rows={2} value={draft.short_description} onChange={(e) => set('short_description', e.target.value)} />
            </div>
            <div className="form-field full">
              <label>Description détaillée</label>
              <textarea rows={8} value={draft.description} onChange={(e) => set('description', e.target.value)} />
            </div>
          </div>
        )}

        {tab === 'category' && (
          <div className="form-grid">
            <div className="form-field">
              <label>Vendeur / Boutique</label>
              <select value={draft.vendor_id} onChange={(e) => set('vendor_id', e.target.value)} disabled={isEdit}>
                <option value="">— sélectionner —</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
              {isEdit && <span className="hint">Le vendeur ne peut pas être changé après création.</span>}
            </div>
            <div className="form-field">
              <label>Catégorie</label>
              <select value={draft.category_id} onChange={(e) => set('category_id', e.target.value)}>
                <option value="">— sélectionner —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label>Marque</label>
              <select value={draft.brand_id} onChange={(e) => set('brand_id', e.target.value)}>
                <option value="">— aucune —</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {tab === 'pricing' && (
          <div className="form-grid">
            <div className="form-field">
              <label>Prix régulier (USD)</label>
              <input type="number" step="0.01" value={draft.price_usd} onChange={(e) => set('price_usd', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Prix promo (USD)</label>
              <input type="number" step="0.01" value={draft.sale_price_usd} onChange={(e) => set('sale_price_usd', e.target.value)} placeholder="laisser vide = pas de promo" />
            </div>
            <div className="form-field">
              <label>SKU</label>
              <input value={draft.sku} onChange={(e) => set('sku', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Code-barres (EAN/UPC)</label>
              <input value={draft.barcode} onChange={(e) => set('barcode', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Quantité en stock</label>
              <input type="number" value={draft.stock} onChange={(e) => set('stock', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Seuil d'alerte stock bas</label>
              <input type="number" value={draft.low_stock_threshold} onChange={(e) => set('low_stock_threshold', e.target.value)} />
            </div>
            <div className="form-field">
              <label>
                <input
                  type="checkbox"
                  checked={draft.backorders_allowed}
                  onChange={(e) => set('backorders_allowed', e.target.checked)}
                  style={{ marginRight: 6 }}
                />
                Autoriser les commandes en rupture
              </label>
            </div>
          </div>
        )}

        {tab === 'media' && (
          <div>
            <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 8 }}>
              Image principale &amp; galerie
            </label>
            <div className="image-gallery">
              {draft.images.map((url) => (
                <div className="image-slot" key={url}>
                  <img src={url} alt="" />
                  <button className="remove-btn" onClick={() => removeImage(url)} type="button">
                    ×
                  </button>
                </div>
              ))}
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
                  if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files)
                }}
              >
                {uploading ? '…' : '+'}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => e.target.files && uploadFiles(e.target.files)}
              />
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              Glissez-déposez des images ou cliquez sur + — la première image est utilisée comme image principale.
            </p>
          </div>
        )}

        {tab === 'shipping' && (
          <div className="form-grid">
            <div className="form-field">
              <label>Poids (kg)</label>
              <input type="number" step="0.01" value={draft.weight_kg} onChange={(e) => set('weight_kg', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Longueur (cm)</label>
              <input type="number" step="0.1" value={draft.length_cm} onChange={(e) => set('length_cm', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Largeur (cm)</label>
              <input type="number" step="0.1" value={draft.width_cm} onChange={(e) => set('width_cm', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Hauteur (cm)</label>
              <input type="number" step="0.1" value={draft.height_cm} onChange={(e) => set('height_cm', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Classe de livraison</label>
              <select value={draft.shipping_class} onChange={(e) => set('shipping_class', e.target.value)}>
                <option value="">Standard</option>
                <option value="fragile">Fragile</option>
                <option value="heavy">Lourd</option>
              </select>
            </div>
          </div>
        )}

        {tab === 'seo' && (
          <div className="form-grid">
            <div className="form-field full">
              <label>Meta titre</label>
              <input value={draft.meta_title} onChange={(e) => set('meta_title', e.target.value)} />
            </div>
            <div className="form-field full">
              <label>Meta description</label>
              <textarea rows={3} value={draft.meta_description} onChange={(e) => set('meta_description', e.target.value)} />
            </div>
            <div className="form-field full">
              <label>Aperçu Google</label>
              <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, background: '#fafbfc' }}>
                <div style={{ color: '#1a0dab', fontSize: 16 }}>{draft.meta_title || draft.name_fr || 'Titre du produit'}</div>
                <div style={{ color: '#006621', fontSize: 12 }}>miadmarket.ca/?v=product&amp;slug={draft.slug || 'slug-du-produit'}</div>
                <div style={{ color: '#545454', fontSize: 13 }}>{draft.meta_description || draft.short_description || 'Description du produit…'}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="form-actions">
        <button className="btn-primary" disabled={saving} onClick={save}>
          {saving ? 'Enregistrement…' : isEdit ? 'Enregistrer les modifications' : 'Créer le produit'}
        </button>
        <button className="btn-ghost" onClick={() => navigate('/admin/catalog/products')}>
          Annuler
        </button>
      </div>
    </div>
  )
}

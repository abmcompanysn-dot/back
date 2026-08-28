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

// VariationRow — même forme que product_variations côté catalog-svc
// (attributes: objet clé/valeur libre, ex: {"Taille": "M"} — PAS un array
// {name,option} comme le dashboard vendeur Next.js le suppose à tort).
interface VariationRow {
  id?: number
  sku: string
  attributes: Record<string, string>
  price_usd: string
  stock: string
  image_url: string
}

// TranslatedFields — tout ce qui est traduisible côté produit (chaque
// langue est une ligne distincte côté catalog-svc, voir products.lang).
// Le reste du Draft (prix, stock, images, catégorie...) est partagé et
// dupliqué automatiquement par createProduct sur les deux lignes — pas
// besoin de le traduire, une seule copie suffit dans le formulaire.
interface TranslatedFields {
  name: string
  description: string
  short_description: string
  meta_title: string
  meta_description: string
}

const EMPTY_TRANSLATION: TranslatedFields = {
  name: '',
  description: '',
  short_description: '',
  meta_title: '',
  meta_description: '',
}

interface Draft {
  vendor_id: string
  category_id: string
  brand_id: string
  slug: string
  price_usd: string
  sale_price_usd: string
  sku: string
  barcode: string
  stock: string
  low_stock_threshold: string
  backorders_allowed: boolean
  images: string[]
  tags: string[]
  weight_kg: string
  length_cm: string
  width_cm: string
  height_cm: string
  shipping_class: string
  product_type: 'simple' | 'variable'
  variations: VariationRow[]
}

const EMPTY: Draft = {
  vendor_id: '',
  category_id: '',
  brand_id: '',
  slug: '',
  price_usd: '',
  sale_price_usd: '',
  sku: '',
  barcode: '',
  stock: '0',
  low_stock_threshold: '3',
  backorders_allowed: false,
  images: [],
  tags: [],
  weight_kg: '',
  length_cm: '',
  width_cm: '',
  height_cm: '',
  shipping_class: '',
  product_type: 'simple',
  variations: [],
}

const EMPTY_VARIATION: VariationRow = { sku: '', attributes: {}, price_usd: '', stock: '', image_url: '' }

// --- Pointures chaussures (aligné sur catalog-svc : shoeSizeAttrName /
// shoeSizeGrid / shoeCategoryKeywords). Toute chaussure DOIT avoir des
// variations de taille — bouton de génération + blocage à l'enregistrement.
const SHOE_SIZE_ATTR = 'Pointure'
const SHOE_SIZE_GRID = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46']
const SHOE_CATEGORY_KEYWORDS = [
  'chaussure', 'sandale', 'babouche', 'basket', 'sneaker', 'mocassin', 'botte',
  'bottine', 'escarpin', 'tong', 'derby', 'derbies', 'ballerine', 'espadrille',
  'claquette', 'mule', 'footwear', 'shoe', 'slipper', 'boot',
]
function stripAccentsLower(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}
function isShoeCategoryName(name: string) {
  const n = stripAccentsLower(name || '')
  return SHOE_CATEGORY_KEYWORDS.some((kw) => n.includes(kw))
}
function variationHasSizeAttr(v: VariationRow) {
  return Object.keys(v.attributes || {}).some((k) =>
    ['pointure', 'taille', 'size'].includes(stripAccentsLower(k))
  )
}

const TABS = [
  { key: 'general', label: 'Informations générales' },
  { key: 'category', label: 'Catégorisation' },
  { key: 'pricing', label: 'Prix & Inventaire' },
  { key: 'variations', label: 'Variations' },
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

  // Traductions : deux lignes distinctes côté catalog-svc (products.lang),
  // reliées par trid — voir le commentaire sur TranslatedFields. En
  // création, seul editLang='fr' est utilisé (name_en optionnel géré à
  // part côté POST, voir save()). En édition, on charge les deux langues
  // via `linked` (renvoyé par GET /products/{id}) pour permettre de
  // switcher FR/EN dans le même formulaire sans perdre les saisies.
  const [editLang, setEditLang] = useState<'fr' | 'en'>('fr')
  const [translations, setTranslations] = useState<Record<'fr' | 'en', TranslatedFields>>({
    fr: { ...EMPTY_TRANSLATION },
    en: { ...EMPTY_TRANSLATION },
  })
  const [productIDs, setProductIDs] = useState<Record<'fr' | 'en', string | null>>({ fr: id ?? null, en: null })

  useEffect(() => {
    api.get<{ items: Vendor[] }>('/admin/api/vendors').then((b) => setVendors(b.items || [])).catch(() => {})
    api.get<{ categories: Category[] }>('/admin/api/categories').then((b) => setCategories(b.categories || [])).catch(() => {})
    api.get<{ items: Brand[] }>('/admin/api/brands').then((b) => setBrands(b.items || [])).catch(() => {})
  }, [])

  function applyProductToState(p: any, lang: 'fr' | 'en') {
    setTranslations((t) => ({
      ...t,
      [lang]: {
        name: p.name ?? '',
        description: p.description ?? '',
        short_description: p.short_description ?? '',
        meta_title: p.meta_title ?? '',
        meta_description: p.meta_description ?? '',
      },
    }))
    setProductIDs((ids) => ({ ...ids, [lang]: String(p.id) }))
    // Champs partagés (non traduisibles) : chargés une seule fois depuis
    // la langue FR de référence — les deux lignes sont censées être
    // identiques sur ces champs (dupliqués à l'écriture, voir
    // createProduct/updateProductImages côté Go).
    if (lang === 'fr') {
      setDraft({
        vendor_id: String(p.vendor_id ?? ''),
        category_id: String(p.category_id ?? ''),
        brand_id: String(p.brand_id ?? ''),
        slug: p.slug ?? '',
        price_usd: String(p.price_usd ?? ''),
        sale_price_usd: p.sale_price ? String(p.sale_price) : '',
        sku: p.sku ?? '',
        barcode: p.barcode ?? '',
        stock: String(p.stock ?? 0),
        low_stock_threshold: String(p.low_stock_threshold ?? 3),
        backorders_allowed: !!p.backorders_allowed,
        images: (p.images || []).map((im: { src: string } | string) => (typeof im === 'string' ? im : im.src)),
        tags: p.tags || [],
        weight_kg: p.weight_kg ? String(p.weight_kg) : '',
        length_cm: p.length_cm ? String(p.length_cm) : '',
        width_cm: p.width_cm ? String(p.width_cm) : '',
        height_cm: p.height_cm ? String(p.height_cm) : '',
        shipping_class: p.shipping_class ?? '',
        product_type: p.is_variable ? 'variable' : 'simple',
        variations: (p.variations || []).map((v: any) => ({
          id: v.id,
          sku: v.sku ?? '',
          attributes: v.attributes ?? {},
          price_usd: String(v.price_usd ?? ''),
          stock: String(v.stock ?? 0),
          image_url: v.image_url ?? '',
        })),
      })
    }
  }

  useEffect(() => {
    if (!isEdit || !id) return
    api
      .get<any>(`/admin/api/products/${id}`)
      .then((p) => {
        applyProductToState(p, (p.lang as 'fr' | 'en') || 'fr')
        const linkedID = p.linked?.id
        const linkedLang = p.linked?.lang as 'fr' | 'en' | undefined
        if (linkedID && linkedLang) {
          api
            .get<any>(`/admin/api/products/${linkedID}`)
            .then((lp) => applyProductToState(lp, linkedLang))
            .catch(() => {})
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'échec du chargement du produit'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isEdit])

  function setTranslated<K extends keyof TranslatedFields>(key: K, value: TranslatedFields[K]) {
    setTranslations((t) => ({ ...t, [editLang]: { ...t[editLang], [key]: value } }))
  }

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

  // Ce produit est-il une chaussure ? (nom de la catégorie sélectionnée)
  const selectedCategoryName = categories.find((c) => String(c.id) === draft.category_id)?.name || ''
  const isShoeProduct = isShoeCategoryName(selectedCategoryName)
  const hasSizeVariation = draft.variations.some(variationHasSizeAttr)

  function addVariation() {
    set('variations', [...draft.variations, { ...EMPTY_VARIATION }])
  }

  // generateShoeSizes — remplit la grille EU 36→46 sous l'attribut
  // "Pointure", en reprenant prix/stock du produit. Passe aussi le produit
  // en "variable". Ne recrée pas une pointure déjà présente.
  function generateShoeSizes() {
    const existing = new Set(
      draft.variations
        .filter(variationHasSizeAttr)
        .map((v) => String(v.attributes[SHOE_SIZE_ATTR] ?? Object.values(v.attributes)[0] ?? ''))
    )
    const basePrice = draft.price_usd || ''
    const baseStock = draft.stock || '0'
    const added: VariationRow[] = SHOE_SIZE_GRID.filter((s) => !existing.has(s)).map((size) => ({
      sku: draft.sku ? `${draft.sku}-${size}` : '',
      attributes: { [SHOE_SIZE_ATTR]: size },
      price_usd: basePrice,
      stock: baseStock,
      image_url: '',
    }))
    setDraft((d) => ({
      ...d,
      product_type: 'variable',
      variations: [...d.variations, ...added],
    }))
    setTab('variations')
  }

  function updateVariation(idx: number, patch: Partial<VariationRow>) {
    set('variations', draft.variations.map((v, i) => (i === idx ? { ...v, ...patch } : v)))
  }

  function removeVariationRow(idx: number) {
    const v = draft.variations[idx]
    set('variations', draft.variations.filter((_, i) => i !== idx))
    // Suppression immédiate côté serveur si la variation existait déjà —
    // sinon elle n'a jamais été persistée, rien à supprimer côté API.
    if (isEdit && v?.id) {
      api.delete(`/admin/api/products/${id}/variations/${v.id}`).catch(() => {})
    }
  }

  async function saveVariations(productId: string | number) {
    for (const v of draft.variations) {
      const payload = {
        sku: v.sku,
        attributes: v.attributes,
        price_usd: Number(v.price_usd || 0),
        stock: Number(v.stock || 0),
        image_url: v.image_url,
      }
      if (v.id) {
        await api.put(`/admin/api/products/${productId}/variations/${v.id}`, payload)
      } else {
        await api.post(`/admin/api/products/${productId}/variations`, payload)
      }
    }
  }

  // Champs partagés (non traduisibles) — identiques quelle que soit la
  // langue, dupliqués sur les deux lignes côté catalog-svc.
  function sharedPayload() {
    return {
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
      tags: draft.tags,
      weight_kg: draft.weight_kg ? Number(draft.weight_kg) : undefined,
      length_cm: draft.length_cm ? Number(draft.length_cm) : undefined,
      width_cm: draft.width_cm ? Number(draft.width_cm) : undefined,
      height_cm: draft.height_cm ? Number(draft.height_cm) : undefined,
      shipping_class: draft.shipping_class,
    }
  }

  async function save() {
    if (!translations.fr.name.trim()) {
      setError('le nom du produit (FR) est obligatoire')
      setEditLang('fr')
      setTab('general')
      return
    }
    if (!isEdit && !draft.vendor_id) {
      setError('le vendeur est obligatoire')
      setTab('category')
      return
    }
    if (draft.product_type === 'variable' && draft.variations.length === 0) {
      setError('un produit variable doit avoir au moins une variation')
      setTab('variations')
      return
    }
    // Blocage chaussures : toute chaussure/sandale/babouche… doit avoir des
    // variations de taille (décision du 2026-08-28).
    if (isShoeProduct && !hasSizeVariation) {
      setError(
        `« ${selectedCategoryName} » est une catégorie de chaussures : ce produit doit avoir des variations de pointure. ` +
          'Utilisez le bouton « Générer les pointures 36–46 » dans l\'onglet Variations.'
      )
      setTab('variations')
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (isEdit) {
        const shared = sharedPayload()
        // La ligne FR reçoit systématiquement les champs partagés (source
        // de vérité) ; la ligne EN ne les reçoit que si elle existe déjà
        // (linked résolu au chargement) — jamais recréée ici.
        await api.patch(`/admin/api/products/${productIDs.fr}`, {
          ...shared,
          name: translations.fr.name,
          description: translations.fr.description,
          short_description: translations.fr.short_description,
          meta_title: translations.fr.meta_title,
          meta_description: translations.fr.meta_description,
        })
        if (productIDs.en) {
          await api.patch(`/admin/api/products/${productIDs.en}`, {
            ...shared,
            name: translations.en.name || translations.fr.name,
            description: translations.en.description,
            short_description: translations.en.short_description,
            meta_title: translations.en.meta_title,
            meta_description: translations.en.meta_description,
          })
        }
        if (draft.product_type === 'variable') {
          await saveVariations(productIDs.fr!)
        }
      } else {
        await api.post('/admin/api/products', {
          vendor_id: Number(draft.vendor_id),
          category_id: draft.category_id ? Number(draft.category_id) : 0,
          brand_id: draft.brand_id ? Number(draft.brand_id) : 0,
          name_fr: translations.fr.name,
          name_en: translations.en.name,
          price_usd: Number(draft.price_usd || 0),
          sku: draft.sku,
          barcode: draft.barcode,
          stock: Number(draft.stock || 0),
          images: draft.images,
          tags: draft.tags,
          is_variable: draft.product_type === 'variable',
          variations: draft.product_type === 'variable'
            ? draft.variations.map((v) => ({
                sku: v.sku,
                attributes: v.attributes,
                price_usd: Number(v.price_usd || 0),
                stock: Number(v.stock || 0),
                image_url: v.image_url,
              }))
            : undefined,
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
        {tab === 'general' && !isEdit && (
          <div className="form-grid">
            <div className="form-field">
              <label>Nom du produit (FR)</label>
              <input value={translations.fr.name} onChange={(e) => setTranslations((t) => ({ ...t, fr: { ...t.fr, name: e.target.value } }))} />
            </div>
            <div className="form-field">
              <label>Nom du produit (EN)</label>
              <input
                value={translations.en.name}
                onChange={(e) => setTranslations((t) => ({ ...t, en: { ...t.en, name: e.target.value } }))}
                placeholder="optionnel — repli sur le FR"
              />
            </div>
            <div className="form-field full">
              <label>Description courte</label>
              <textarea
                rows={2}
                value={translations.fr.short_description}
                onChange={(e) => setTranslations((t) => ({ ...t, fr: { ...t.fr, short_description: e.target.value } }))}
              />
            </div>
            <div className="form-field full">
              <label>Description détaillée</label>
              <textarea
                rows={8}
                value={translations.fr.description}
                onChange={(e) => setTranslations((t) => ({ ...t, fr: { ...t.fr, description: e.target.value } }))}
              />
            </div>
          </div>
        )}

        {tab === 'general' && isEdit && (
          <div>
            {/* Toggle FR/EN — édition uniquement : en création la version EN
                est juste un repli optionnel saisi à côté (voir ci-dessus),
                mais une fois le produit créé, les deux langues sont deux
                lignes indépendantes à éditer séparément (voir save()). */}
            <div className="form-tabs" style={{ marginBottom: 16 }}>
              <button type="button" className={editLang === 'fr' ? 'active' : ''} onClick={() => setEditLang('fr')}>
                🇫🇷 Français
              </button>
              <button
                type="button"
                className={editLang === 'en' ? 'active' : ''}
                onClick={() => setEditLang('en')}
                disabled={!productIDs.en}
                title={productIDs.en ? undefined : 'Aucune traduction anglaise liée à ce produit'}
              >
                🇬🇧 English {!productIDs.en && '(absente)'}
              </button>
            </div>
            <div className="form-grid">
              <div className="form-field full">
                <label>Nom du produit ({editLang.toUpperCase()})</label>
                <input value={translations[editLang].name} onChange={(e) => setTranslated('name', e.target.value)} />
              </div>
              <div className="form-field full">
                <label>Description courte ({editLang.toUpperCase()})</label>
                <textarea rows={2} value={translations[editLang].short_description} onChange={(e) => setTranslated('short_description', e.target.value)} />
              </div>
              <div className="form-field full">
                <label>Description détaillée ({editLang.toUpperCase()})</label>
                <textarea rows={8} value={translations[editLang].description} onChange={(e) => setTranslated('description', e.target.value)} />
              </div>
              {editLang === 'en' && !productIDs.en && (
                <p className="hint">
                  Ce produit n'a pas encore de traduction anglaise. Utilisez le CLI (<code>--name-en</code>) pour en créer une —
                  la création de traduction depuis cet écran n'est pas encore disponible.
                </p>
              )}
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
            <div className="form-field full">
              <label>Tags de recherche</label>
              <input
                value={draft.tags.join(', ')}
                onChange={(e) =>
                  set(
                    'tags',
                    e.target.value
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean)
                  )
                }
                placeholder="ex. bio, artisanal, fait main"
              />
              <span className="hint">Séparez les tags par une virgule — utilisés pour la recherche et le filtrage côté client.</span>
            </div>
          </div>
        )}

        {tab === 'pricing' && (
          <div className="form-grid">
            <div className="form-field full">
              <label>Type de produit</label>
              <select value={draft.product_type} onChange={(e) => set('product_type', e.target.value as 'simple' | 'variable')}>
                <option value="simple">Simple — un seul prix</option>
                <option value="variable">Variable — plusieurs variations (taille, couleur, quantité…)</option>
              </select>
              {draft.product_type === 'variable' && (
                <span className="hint">Le prix/stock ci-dessous ne sert plus — gérez-les dans l'onglet "Variations".</span>
              )}
            </div>
            <div className="form-field">
              <label>Prix régulier (USD)</label>
              <input type="number" step="0.01" value={draft.price_usd} onChange={(e) => set('price_usd', e.target.value)} disabled={draft.product_type === 'variable'} />
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

        {tab === 'variations' && (
          <div>
            {isShoeProduct && (
              <div
                className={hasSizeVariation ? 'hint' : 'error-text'}
                style={{
                  marginBottom: 12,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: `1px solid ${hasSizeVariation ? '#cfe9d5' : '#f0c9c9'}`,
                  background: hasSizeVariation ? '#f2faf4' : '#fdf3f3',
                }}
              >
                <strong>Catégorie chaussures « {selectedCategoryName} ».</strong>{' '}
                {hasSizeVariation
                  ? 'Ce produit a bien des variations de pointure.'
                  : 'Ce produit doit avoir des variations de pointure pour pouvoir être enregistré.'}
                <div style={{ marginTop: 8 }}>
                  <button className="btn-primary" type="button" onClick={generateShoeSizes}>
                    Générer les pointures 36–46
                  </button>
                </div>
              </div>
            )}
            {draft.product_type === 'simple' ? (
              <p className="hint">
                Ce produit est de type "Simple" — passez-le en "Variable" dans l'onglet Prix &amp; Inventaire pour ajouter des variations (ex : "1 pièce" à 15$, "3 pièces" à 40$).
              </p>
            ) : (
              <>
                <div className="table-card">
                  <table style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Libellé (ex: "1 pièce", "Pointure 40")</th>
                        <th>SKU</th>
                        <th>Prix (USD)</th>
                        <th>Stock</th>
                        <th>Image</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {draft.variations.map((v, idx) => {
                        // Un seul champ "libellé" : on édite l'attribut existant
                        // (Pointure pour une chaussure, sinon Variante).
                        const attrKey = variationHasSizeAttr(v)
                          ? Object.keys(v.attributes).find((k) =>
                              ['pointure', 'taille', 'size'].includes(stripAccentsLower(k))
                            ) || SHOE_SIZE_ATTR
                          : 'Variante'
                        const label = v.attributes[attrKey] ?? ''
                        return (
                          <tr key={v.id ?? `new-${idx}`}>
                            <td>
                              <input
                                value={label}
                                placeholder={attrKey === SHOE_SIZE_ATTR ? '40' : '1 pièce'}
                                onChange={(e) => updateVariation(idx, { attributes: { ...v.attributes, [attrKey]: e.target.value } })}
                              />
                            </td>
                            <td>
                              <input value={v.sku} onChange={(e) => updateVariation(idx, { sku: e.target.value })} />
                            </td>
                            <td>
                              <input type="number" step="0.01" value={v.price_usd} onChange={(e) => updateVariation(idx, { price_usd: e.target.value })} style={{ width: 90 }} />
                            </td>
                            <td>
                              <input type="number" value={v.stock} onChange={(e) => updateVariation(idx, { stock: e.target.value })} style={{ width: 70 }} />
                            </td>
                            <td>
                              <input value={v.image_url} placeholder="URL image (optionnel)" onChange={(e) => updateVariation(idx, { image_url: e.target.value })} />
                            </td>
                            <td>
                              <button className="btn-ghost" type="button" onClick={() => removeVariationRow(idx)}>
                                Supprimer
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <button className="btn-ghost" type="button" onClick={addVariation} style={{ marginTop: 12 }}>
                  + Ajouter une variation
                </button>
                {isShoeProduct && (
                  <button className="btn-ghost" type="button" onClick={generateShoeSizes} style={{ marginTop: 12, marginLeft: 8 }}>
                    Générer les pointures 36–46
                  </button>
                )}
                <p className="hint" style={{ marginTop: 8 }}>
                  Le libellé (ex : "1 pièce", "3 pièces", "40") est stocké comme attribut
                  {isShoeProduct ? ' "Pointure" pour les chaussures' : ' "Variante"'} — c'est ce libellé qui
                  s'affiche comme sélecteur sur la fiche produit.
                </p>
              </>
            )}
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
            {isEdit && (
              <p className="hint form-field full">
                Édition du SEO pour la langue {editLang.toUpperCase()} — changez de langue depuis l'onglet
                « Informations générales ».
              </p>
            )}
            <div className="form-field full">
              <label>Meta titre</label>
              <input value={translations[editLang].meta_title} onChange={(e) => setTranslated('meta_title', e.target.value)} />
            </div>
            <div className="form-field full">
              <label>Meta description</label>
              <textarea rows={3} value={translations[editLang].meta_description} onChange={(e) => setTranslated('meta_description', e.target.value)} />
            </div>
            <div className="form-field full">
              <label>Aperçu Google</label>
              <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, background: '#fafbfc' }}>
                <div style={{ color: '#1a0dab', fontSize: 16 }}>
                  {translations[editLang].meta_title || translations[editLang].name || 'Titre du produit'}
                </div>
                <div style={{ color: '#006621', fontSize: 12 }}>miadmarket.ca/?v=product&amp;slug={draft.slug || 'slug-du-produit'}</div>
                <div style={{ color: '#545454', fontSize: 13 }}>
                  {translations[editLang].meta_description || translations[editLang].short_description || 'Description du produit…'}
                </div>
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

import { useEffect, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { IconStar } from '../../components/Icons'
import { CatalogNav } from './CatalogNav'

interface Review {
  id: number
  product_id: number
  product_name: string
  customer_id: number | null
  guest_name: string
  guest_email: string
  rating: number
  title?: string
  comment: string
  photos?: string[]
  verified_purchase: boolean
  is_community?: boolean
  review_type?: string
  moderation_reason?: string
  reviewer_country?: string
  status: string
  admin_reply: string
  created_at: string
}

const STATUS_TABS = [
  { value: 'pending', label: 'En attente' },
  { value: 'approved', label: 'Approuvés' },
  { value: 'rejected', label: 'Rejetés' },
  { value: '', label: 'Tous' },
]

function Stars({ n }: { n: number }) {
  return <span style={{ color: '#e0a500' }}>{'★'.repeat(n)}{'☆'.repeat(5 - n)}</span>
}

export function Reviews() {
  const [items, setItems] = useState<Review[]>([])
  const [status, setStatus] = useState('pending')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState<Record<number, string>>({})
  const [busyId, setBusyId] = useState<number | null>(null)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page_size: '50' })
      if (status) params.set('status', status)
      const body = await api.get<{ items: Review[] }>(`/admin/api/reviews?${params.toString()}`)
      setItems(body.items || [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  async function moderate(r: Review, newStatus: 'approved' | 'rejected') {
    setBusyId(r.id)
    try {
      await api.patch(`/admin/api/reviews/${r.id}`, { status: newStatus })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la modération')
    } finally {
      setBusyId(null)
    }
  }

  // ── Seed d'avis "de la communauté" sur un produit recommandé ──
  const [seedOpen, setSeedOpen] = useState(false)
  const [seed, setSeed] = useState({ product_id: '', count: '6', vendor_avatar: '', rep_avatar: '', countries: 'SN,CI,CM,BJ,GN,ML' })
  const [seedBusy, setSeedBusy] = useState(false)
  const [seedMsg, setSeedMsg] = useState<string | null>(null)

  async function runSeed() {
    if (!seed.product_id.trim()) return
    setSeedBusy(true)
    setSeedMsg(null)
    try {
      const body = await api.post<{ created: number }>('/admin/api/reviews/seed', {
        product_id: Number(seed.product_id),
        count: Number(seed.count) || 6,
        vendor_avatar: seed.vendor_avatar.trim() || undefined,
        rep_avatar: seed.rep_avatar.trim() || undefined,
        countries: seed.countries.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean),
      })
      setSeedMsg(`${body.created} avis de la communauté créés.`)
      if (status === '' || status === 'approved') await load()
    } catch (err) {
      setSeedMsg(err instanceof ApiError ? err.message : 'échec du seed')
    } finally {
      setSeedBusy(false)
    }
  }

  // ── Seed sur TOUT le catalogue (2-5 avis/produit, moyenne ~4,3) ──
  const [catSeed, setCatSeed] = useState({ min: '2', max: '5', photo_ratio: '40', only_missing: true })
  const [catBusy, setCatBusy] = useState(false)
  const [catMsg, setCatMsg] = useState<string | null>(null)

  async function runCatalogSeed(dryRun: boolean) {
    setCatBusy(true)
    setCatMsg(null)
    try {
      const body = await api.post<{
        dry_run: boolean
        products_seen: number
        products_processed: number
        products_skipped: number
        reviews_created: number
      }>('/admin/api/reviews/seed-catalog', {
        min: Number(catSeed.min) || 2,
        max: Number(catSeed.max) || 5,
        photo_ratio: Number(catSeed.photo_ratio) || 40,
        only_missing: catSeed.only_missing,
        rating_mix: { '5': 50, '4': 30, '3': 15, '2': 5 },
        dry_run: dryRun,
      })
      setCatMsg(
        `${body.dry_run ? 'SIMULATION — ' : ''}${body.reviews_created} avis ${
          body.dry_run ? 'seraient créés' : 'créés'
        } sur ${body.products_processed} produits (${body.products_skipped} ignorés, ${body.products_seen} vus).`,
      )
      if (!dryRun && (status === '' || status === 'approved')) await load()
    } catch (err) {
      setCatMsg(err instanceof ApiError ? err.message : 'échec du seed catalogue')
    } finally {
      setCatBusy(false)
    }
  }

  async function sendReply(r: Review) {
    const reply = (replyDraft[r.id] || '').trim()
    if (!reply) return
    setBusyId(r.id)
    try {
      await api.patch(`/admin/api/reviews/${r.id}`, { admin_reply: reply })
      setReplyDraft({ ...replyDraft, [r.id]: '' })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de l\'envoi')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <CatalogNav />
      <div className="page-header">
        <div>
          <h2>Avis &amp; Modération</h2>
          <p className="subtitle">Réputation des produits et retours clients</p>
        </div>
        <button className="btn-ghost" onClick={() => setSeedOpen((v) => !v)}>
          {seedOpen ? 'Fermer' : 'Avis de la communauté…'}
        </button>
      </div>

      {seedOpen && (
        <div className="form-card" style={{ marginBottom: 16, background: '#fafbfc' }}>
          <p style={{ fontWeight: 700, marginTop: 0 }}>Générer des avis « de la communauté » sur un produit recommandé</p>
          <p className="subtitle" style={{ marginTop: 0 }}>
            Avis crédibles SANS badge « Achat vérifié » (mention « Avis de la communauté »). Nom + pays
            tirés au sort, avatar = photo du vendeur ou du représentant du pays, photos réutilisées de la
            galerie du produit. À réserver aux produits mis en avant.
          </p>
          <div className="form-grid">
            <div className="form-field">
              <label>ID produit (version FR)</label>
              <input value={seed.product_id} onChange={(e) => setSeed({ ...seed, product_id: e.target.value })} placeholder="ex. 199" />
            </div>
            <div className="form-field">
              <label>Nombre d'avis</label>
              <input type="number" value={seed.count} onChange={(e) => setSeed({ ...seed, count: e.target.value })} />
            </div>
            <div className="form-field full">
              <label>Photo du représentant du pays (URL, prioritaire pour l'avatar)</label>
              <input value={seed.rep_avatar} onChange={(e) => setSeed({ ...seed, rep_avatar: e.target.value })} placeholder="https://img.miadmarket.ca/…" />
            </div>
            <div className="form-field full">
              <label>Photo du vendeur (URL, avatar de repli)</label>
              <input value={seed.vendor_avatar} onChange={(e) => setSeed({ ...seed, vendor_avatar: e.target.value })} placeholder="https://img.miadmarket.ca/…" />
            </div>
            <div className="form-field full">
              <label>Pays à faire tourner (codes ISO2, séparés par des virgules)</label>
              <input value={seed.countries} onChange={(e) => setSeed({ ...seed, countries: e.target.value })} />
            </div>
          </div>
          <button className="btn-primary" disabled={seedBusy || !seed.product_id.trim()} onClick={runSeed}>
            {seedBusy ? 'Génération…' : 'Générer les avis'}
          </button>
          {seedMsg && <span style={{ marginLeft: 12, fontSize: 13 }}>{seedMsg}</span>}

          <hr style={{ margin: '20px 0', border: 0, borderTop: '1px solid #e6e8eb' }} />

          <p style={{ fontWeight: 700, marginTop: 0 }}>Tout le catalogue — en une fois</p>
          <p className="subtitle" style={{ marginTop: 0 }}>
            2 à 5 avis par produit (aléatoire), moyenne ≈ 4,3 (50 % 5★, 30 % 4★, 15 % 3★, 5 % 2★).
            Signataires = représentant du pays du vendeur (son vrai nom) sinon prénoms génériques du
            pays ; avatar = logo de la boutique sinon initiale. Photos = images d'origine du produit
            uniquement (jamais les visuels générés). <strong>Lancer d'abord la simulation.</strong>
          </p>
          <div className="form-grid">
            <div className="form-field">
              <label>Min. avis / produit</label>
              <input type="number" value={catSeed.min} onChange={(e) => setCatSeed({ ...catSeed, min: e.target.value })} />
            </div>
            <div className="form-field">
              <label>Max. avis / produit</label>
              <input type="number" value={catSeed.max} onChange={(e) => setCatSeed({ ...catSeed, max: e.target.value })} />
            </div>
            <div className="form-field">
              <label>% d'avis avec photo</label>
              <input type="number" value={catSeed.photo_ratio} onChange={(e) => setCatSeed({ ...catSeed, photo_ratio: e.target.value })} />
            </div>
            <div className="form-field full">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={catSeed.only_missing}
                  onChange={(e) => setCatSeed({ ...catSeed, only_missing: e.target.checked })}
                />
                Ne traiter que les produits sans avis « communauté » (recommandé)
              </label>
            </div>
          </div>
          <button className="btn-ghost" disabled={catBusy} onClick={() => runCatalogSeed(true)}>
            {catBusy ? 'Calcul…' : 'Simuler (dry-run)'}
          </button>
          <button className="btn-primary" style={{ marginLeft: 8 }} disabled={catBusy} onClick={() => runCatalogSeed(false)}>
            {catBusy ? 'Génération…' : 'Lancer sur tout le catalogue'}
          </button>
          {catMsg && <div style={{ marginTop: 10, fontSize: 13 }}>{catMsg}</div>}
        </div>
      )}

      <div className="subnav" style={{ marginBottom: 16 }}>
        {STATUS_TABS.map((t) => (
          <a
            key={t.value}
            className={status === t.value ? 'active' : ''}
            onClick={(e) => {
              e.preventDefault()
              setStatus(t.value)
            }}
            href="#"
          >
            {t.label}
          </a>
        ))}
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}

      {!loading && items.length === 0 && (
        <EmptyState
          icon={<IconStar width={40} height={40} strokeWidth={1.4} />}
          title="Aucun avis dans cette file"
          description="Les avis clients apparaîtront ici au fur et à mesure."
        />
      )}

      {!loading &&
        items.map((r) => (
          <div className="form-card" key={r.id} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div className="cell-primary">{r.product_name || `Produit #${r.product_id}`}</div>
                <div className="cell-secondary">
                  {r.guest_name || (r.customer_id ? `Client #${r.customer_id}` : 'Anonyme')}
                  {r.guest_email && ` (${r.guest_email})`} · {new Date(r.created_at).toLocaleDateString('fr-FR')}
                  {r.verified_purchase && <span className="badge badge-blue" style={{ marginLeft: 8 }}>Achat vérifié</span>}
                </div>
              </div>
              <Stars n={r.rating} />
            </div>
            {(r.is_community || r.review_type === 'delivery' || r.moderation_reason) && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
                {r.is_community && <span className="badge" style={{ background: '#eef1f4', color: '#5a6270' }}>Avis de la communauté</span>}
                {r.review_type === 'delivery' && <span className="badge" style={{ background: '#e8f5e9', color: '#2e7d32' }}>Confirmation de livraison</span>}
                {r.moderation_reason && (
                  <span className="badge" style={{ background: '#fff3cd', color: '#8a6d1d' }}>
                    ⚠ {r.moderation_reason}
                  </span>
                )}
                {r.reviewer_country && <span className="badge">{r.reviewer_country}</span>}
              </div>
            )}
            {r.title && <p style={{ margin: '8px 0 2px', fontWeight: 700 }}>{r.title}</p>}
            <p style={{ margin: '4px 0 10px' }}>{r.comment || <em style={{ color: '#999' }}>Sans commentaire</em>}</p>

            {Array.isArray(r.photos) && r.photos.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                {r.photos.map((src) => (
                  <a key={src} href={src} target="_blank" rel="noreferrer">
                    <img
                      src={src}
                      alt=""
                      style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid #e0e0e0' }}
                    />
                  </a>
                ))}
              </div>
            )}

            {r.admin_reply && (
              <div style={{ background: '#f4f5f7', borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 10 }}>
                <strong>Réponse de la plateforme :</strong> {r.admin_reply}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {r.status !== 'approved' && (
                <button className="btn-primary" disabled={busyId === r.id} onClick={() => moderate(r, 'approved')}>
                  Approuver
                </button>
              )}
              {r.status !== 'rejected' && (
                <button className="btn-danger" disabled={busyId === r.id} onClick={() => moderate(r, 'rejected')}>
                  Masquer
                </button>
              )}
              <input
                style={{ flex: 1, minWidth: 180, padding: '6px 8px', fontSize: 12, border: '1px solid #ccc', borderRadius: 6 }}
                placeholder="Répondre au client…"
                value={replyDraft[r.id] || ''}
                onChange={(e) => setReplyDraft({ ...replyDraft, [r.id]: e.target.value })}
              />
              <button className="btn-ghost" disabled={busyId === r.id} onClick={() => sendReply(r)}>
                Répondre
              </button>
            </div>
          </div>
        ))}
    </div>
  )
}

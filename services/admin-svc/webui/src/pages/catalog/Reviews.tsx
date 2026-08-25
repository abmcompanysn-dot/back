import { useEffect, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { IconStar } from '../../components/Icons'
import { CatalogNav } from './CatalogNav'

interface Review {
  id: number
  product_id: number
  product_name: string
  customer_id: number
  rating: number
  comment: string
  verified_purchase: boolean
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
      </div>

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
                  Client #{r.customer_id} · {new Date(r.created_at).toLocaleDateString('fr-FR')}
                  {r.verified_purchase && <span className="badge badge-blue" style={{ marginLeft: 8 }}>Achat vérifié</span>}
                </div>
              </div>
              <Stars n={r.rating} />
            </div>
            <p style={{ margin: '10px 0' }}>{r.comment || <em style={{ color: '#999' }}>Sans commentaire</em>}</p>

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

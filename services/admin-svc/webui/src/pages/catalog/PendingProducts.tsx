import { useEffect, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'
import { IconAlert } from '../../components/Icons'
import { CatalogNav } from './CatalogNav'

interface PendingProduct {
  id: number
  name: string
  vendor_id: number
  price_usd: number
  image: string
  status: string
}

export function PendingProducts() {
  const [items, setItems] = useState<PendingProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [reasonDraft, setReasonDraft] = useState<Record<number, string>>({})

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const body = await api.get<{ items: PendingProduct[] }>('/admin/api/products?status=pending_review&admin=true')
      setItems(body.items || [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  async function moderate(p: PendingProduct, status: 'approved' | 'rejected') {
    setBusyId(p.id)
    try {
      await api.patch(`/admin/api/products/${p.id}/moderate`, {
        status,
        reason: status === 'rejected' ? reasonDraft[p.id] || '' : undefined,
      })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la modération')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <CatalogNav />
      <div className="page-header">
        <div>
          <h2>Produits en attente</h2>
          <p className="subtitle">Produits soumis par des vendeurs modérés — à approuver avant publication</p>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}

      {!loading && items.length === 0 && (
        <EmptyState
          icon={<IconAlert width={40} height={40} strokeWidth={1.4} />}
          title="Aucun produit en attente"
          description="Les produits soumis par des vendeurs modérés apparaîtront ici."
        />
      )}

      {!loading &&
        items.map((p) => (
          <div className="form-card" key={p.id} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {p.image && (
                <img src={p.image} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8 }} />
              )}
              <div style={{ flex: 1 }}>
                <div className="cell-primary">{p.name}</div>
                <div className="cell-secondary">
                  Vendeur #{p.vendor_id} · {p.price_usd} $
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
              <button className="btn-primary" disabled={busyId === p.id} onClick={() => moderate(p, 'approved')}>
                Approuver
              </button>
              <input
                style={{ flex: 1, minWidth: 180, padding: '6px 8px', fontSize: 12, border: '1px solid #ccc', borderRadius: 6 }}
                placeholder="Motif du rejet (optionnel)…"
                value={reasonDraft[p.id] || ''}
                onChange={(e) => setReasonDraft({ ...reasonDraft, [p.id]: e.target.value })}
              />
              <button className="btn-danger" disabled={busyId === p.id} onClick={() => moderate(p, 'rejected')}>
                Rejeter
              </button>
            </div>
          </div>
        ))}
    </div>
  )
}

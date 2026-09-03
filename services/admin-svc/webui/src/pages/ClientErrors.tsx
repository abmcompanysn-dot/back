import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'

// ClientErrors — page "Erreurs du site" du back-office (2026-09-03).
// Remplace Sentry côté navigateur, incompatible avec le pipeline
// @cloudflare/next-on-pages de ce projet (deux tentatives infructueuses
// le 2026-09-03 : @sentry/nextjs cassait le build, @sentry/cloudflare
// cassait le site entier à l'exécution). Deux types d'erreurs remontées
// via POST /api/log-client-error → admin-svc → client_error_log :
// 'js_error' (crash React, app/global-error.tsx) et 'image_error'
// (chargement d'image définitivement échoué, LazyImage.tsx — ajouté après
// coup le même jour, demande du fondateur suite aux signalements
// d'images lentes/cassées).

interface ClientError {
  id: number
  message: string
  stack: string
  digest: string
  url: string
  user_agent: string
  user_id: string
  type: string
  created_at: string
}

const TYPE_LABELS: Record<string, string> = {
  js_error: 'Erreur JS',
  image_error: 'Image cassée',
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}

export function ClientErrors() {
  const [items, setItems] = useState<ClientError[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [typeFilter, setTypeFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const pageSize = 40

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const typeParam = typeFilter ? `&type=${typeFilter}` : ''
      const data = await api.get<{ items: ClientError[]; total: number }>(
        `/admin/api/client-errors?page=${page}&page_size=${pageSize}${typeParam}`
      )
      setItems(data.items || [])
      setTotal(data.total || 0)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Chargement impossible')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setPage(1)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter])

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Erreurs du site</h2>
          <p className="subtitle">
            Crashs et images cassées rencontrés par les visiteurs sur miadmarket.ca —
            remplace le suivi Sentry, non compatible avec ce site. Les plus récentes en premier.
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[
          { value: '', label: 'Tout' },
          { value: 'js_error', label: 'Erreurs JS' },
          { value: 'image_error', label: 'Images cassées' },
        ].map((opt) => (
          <button
            key={opt.value}
            className={`btn btn-sm ${typeFilter === opt.value ? 'btn-primary' : ''}`}
            onClick={() => setTypeFilter(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {error && <div className="alert alert-red" style={{ marginBottom: 16 }}>{error}</div>}
      {loading && <p className="subtitle">Chargement…</p>}

      {!loading && items.length === 0 && !error && (
        <p className="subtitle">Aucune erreur enregistrée — bon signe.</p>
      )}

      {!loading && items.length > 0 && (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Quand</th>
                <th>Message</th>
                <th>Page</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <>
                  <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                    <td>
                      <span className={`badge ${e.type === 'image_error' ? 'badge-orange' : 'badge-red'}`}>
                        {TYPE_LABELS[e.type] || e.type}
                      </span>
                    </td>
                    <td className="subtitle" style={{ whiteSpace: 'nowrap' }}>{formatDate(e.created_at)}</td>
                    <td>{e.message}</td>
                    <td className="subtitle" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.url}
                    </td>
                    <td>{expanded === e.id ? '▲' : '▼'}</td>
                  </tr>
                  {expanded === e.id && (
                    <tr key={`${e.id}-detail`}>
                      <td colSpan={5}>
                        <div style={{ background: 'var(--muted, #f5f5f5)', padding: 12, borderRadius: 8, fontSize: 12 }}>
                          {e.digest && <p><strong>Digest :</strong> {e.digest}</p>}
                          {e.user_id && <p><strong>Utilisateur :</strong> {e.user_id}</p>}
                          {e.user_agent && <p><strong>Navigateur :</strong> {e.user_agent}</p>}
                          {e.stack && (
                            <pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', marginTop: 8 }}>{e.stack}</pre>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
              <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Précédent</button>
              <span className="subtitle" style={{ alignSelf: 'center' }}>Page {page} / {totalPages}</span>
              <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Suivant</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

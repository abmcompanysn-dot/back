"use client"

import { useState } from 'react'
import useSWR from 'swr'
import { RefreshCw, ScrollText, ChevronLeft, ChevronRight } from 'lucide-react'

interface LogEntry {
  id: number
  actor_id: number
  actor_email: string
  actor_role: string
  action: string
  wp_endpoint: string
  status: 'success' | 'error'
  wp_status: number | null
  ip: string
  country: string
  user_agent: string
  metadata: string | null
  created_at: string
}

interface LogResponse {
  entries?: LogEntry[]
  total?: number
  error?: string
  wpStatus?: number
  wpBody?: string
}

const PER_PAGE = 30

function fmtDate(str: string) {
  if (!str) return '—'
  const d = new Date(str + 'Z')
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' })
}

const fetchLog = async (url: string): Promise<LogResponse> => {
  const token = localStorage.getItem('miad_token')
  if (!token) return { error: 'Non connecté' }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
  return res.json()
}

export function AdminActionLog() {
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)

  const params = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) })
  if (status) params.set('status', status)

  const { data, isLoading, mutate } = useSWR<LogResponse>(
    `/api/admin/action-log?${params}`,
    fetchLog,
    { refreshInterval: 30_000 }
  )

  const entries = data?.entries || []
  const total = data?.total || 0
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-muted-foreground">
          Chaque action admin/représentant qui appelle WordPress est tracée ici : qui, quoi, quand, depuis où.
        </p>
        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={e => { setStatus(e.target.value); setPage(1) }}
            aria-label="Filtrer par statut"
            className="text-[11px] border border-border rounded-lg px-2 py-1.5 bg-background"
          >
            <option value="">Tous les statuts</option>
            <option value="success">Succès</option>
            <option value="error">Erreur</option>
          </select>
          <button
            type="button"
            onClick={() => mutate()}
            aria-label="Actualiser"
            className="p-1.5 rounded-lg hover:bg-muted transition-colors"
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin text-primary' : 'text-muted-foreground'} />
          </button>
        </div>
      </div>

      {data?.error ? (
        <div className="text-xs text-destructive space-y-1 p-4 bg-destructive/5 rounded-xl border border-destructive/20">
          <p>{data.error}</p>
          {(data.wpStatus || data.wpBody) && (
            <p className="text-[10px] text-destructive/70 break-all">
              {data.wpStatus ? `WP HTTP ${data.wpStatus}` : ''}{data.wpBody ? ` — ${data.wpBody.slice(0, 300)}` : ''}
            </p>
          )}
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
          <ScrollText size={36} className="opacity-30 mb-3" />
          <p className="text-sm font-bold">{isLoading ? 'Chargement…' : 'Aucune action enregistrée pour le moment'}</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left font-black uppercase text-[10px] tracking-wide px-3 py-2">Horodatage</th>
                  <th className="text-left font-black uppercase text-[10px] tracking-wide px-3 py-2">Admin</th>
                  <th className="text-left font-black uppercase text-[10px] tracking-wide px-3 py-2">Action</th>
                  <th className="text-left font-black uppercase text-[10px] tracking-wide px-3 py-2">Statut</th>
                  <th className="text-left font-black uppercase text-[10px] tracking-wide px-3 py-2">Origine</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map(e => (
                  <>
                    <tr
                      key={e.id}
                      className={`hover:bg-muted/20 ${e.metadata ? 'cursor-pointer' : ''}`}
                      onClick={() => e.metadata && setExpanded(x => x === e.id ? null : e.id)}
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground" suppressHydrationWarning>{fmtDate(e.created_at)}</td>
                      <td className="px-3 py-2">
                        <div className="font-bold">{e.actor_email || `#${e.actor_id}`}</div>
                        <div className="text-[10px] text-muted-foreground">{e.actor_role}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-mono">{e.action}</div>
                        <div className="text-[10px] text-muted-foreground truncate max-w-[220px]">{e.wp_endpoint}</div>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`px-1.5 py-0.5 rounded-full font-bold text-[10px] ${e.status === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {e.status === 'success' ? 'Succès' : `Erreur${e.wp_status ? ` (${e.wp_status})` : ''}`}
                        </span>
                        {e.metadata && <span className="ml-1 text-[10px] text-muted-foreground underline">détail</span>}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        <div>{e.ip || '—'} {e.country ? `· ${e.country}` : ''}</div>
                        <div className="text-[10px] truncate max-w-[180px]">{e.user_agent}</div>
                      </td>
                    </tr>
                    {expanded === e.id && e.metadata && (
                      <tr key={`${e.id}-detail`}>
                        <td colSpan={5} className="px-3 py-2 bg-muted/20">
                          <pre className="text-[10px] whitespace-pre-wrap break-all text-muted-foreground max-h-40 overflow-y-auto">{e.metadata}</pre>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                aria-label="Page précédente"
                className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-xs text-muted-foreground">Page {page} / {totalPages}</span>
              <button
                type="button"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                aria-label="Page suivante"
                className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

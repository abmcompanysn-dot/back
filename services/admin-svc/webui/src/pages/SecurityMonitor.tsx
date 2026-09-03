import { useCallback, useEffect, useState } from 'react'
import { ApiError, api } from '../lib/api'
import { EmptyState } from '../components/EmptyState'
import { IconAlert } from '../components/Icons'

// Surveillance de sécurité — journal du "guard" (internal/kit/guard.go) :
// règles de détection déclenchées (balayage d'IDs, bourrage
// d'identifiants, énumération OTP, test de cartes, scraping…), IP
// bloquées automatiquement, avec déblocage / blocage manuel.
// Audit sécurité 2026-09-03.

interface SecurityEvent {
  id: number
  created_at: string
  svc: string
  rule: string
  severity: 'info' | 'warn' | 'critical'
  action: 'alert' | 'throttle' | 'block'
  ip: string
  subject: string
  method: string
  path: string
  count: number
  window_sec: number
  detail: string
}

interface BlockedIP {
  ip: string
  created_at: string
  expires_at: string
  rule: string
  reason: string
  hits: number
  manual: boolean
  active: boolean
}

const SEVERITY_LABEL: Record<string, string> = {
  info: 'Information',
  warn: 'À surveiller',
  critical: 'Critique',
}
const ACTION_LABEL: Record<string, string> = {
  alert: 'Alerte',
  throttle: 'Ralenti (429)',
  block: 'IP bloquée',
}

function severityClass(s: string) {
  if (s === 'critical') return 'badge badge-red'
  if (s === 'warn') return 'badge badge-orange'
  return 'badge'
}

function fmtWindow(sec: number) {
  if (sec % 3600 === 0) return `${sec / 3600} h`
  if (sec % 60 === 0) return `${sec / 60} min`
  return `${sec} s`
}

export function SecurityMonitor() {
  const [events, setEvents] = useState<SecurityEvent[]>([])
  const [blocks, setBlocks] = useState<BlockedIP[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyIP, setBusyIP] = useState<string | null>(null)
  const [severityFilter, setSeverityFilter] = useState('')

  const load = useCallback(async () => {
    setError(null)
    try {
      const [ev, bl] = await Promise.all([
        api.get<{ items: SecurityEvent[] }>('/admin/api/security/events?limit=200'),
        api.get<{ items: BlockedIP[] }>('/admin/api/security/blocks'),
      ])
      setEvents(ev.items || [])
      setBlocks(bl.items || [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000) // rafraîchissement auto
    return () => clearInterval(t)
  }, [load])

  async function unblock(ip: string) {
    if (!window.confirm(`Débloquer ${ip} ? Ses requêtes seront de nouveau acceptées immédiatement.`)) return
    setBusyIP(ip)
    try {
      await api.post('/admin/api/security/unblock', { ip })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec du déblocage')
    } finally {
      setBusyIP(null)
    }
  }

  async function blockManual() {
    const ip = window.prompt('Adresse IP à bloquer :')
    if (!ip) return
    const minutesStr = window.prompt('Durée du blocage en minutes :', '60')
    if (minutesStr === null) return
    const reason = window.prompt('Motif (visible dans le journal) :', 'blocage manuel') || ''
    setBusyIP(ip)
    try {
      await api.post('/admin/api/security/block', {
        ip: ip.trim(),
        minutes: parseInt(minutesStr, 10) || 60,
        reason,
      })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec du blocage')
    } finally {
      setBusyIP(null)
    }
  }

  const filteredEvents = severityFilter
    ? events.filter((e) => e.severity === severityFilter)
    : events

  const activeBlocks = blocks.filter((b) => b.active)

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Surveillance de sécurité</h2>
          <p className="subtitle">
            Détection automatique des comportements suspects — {activeBlocks.length} IP actuellement bloquée
            {activeBlocks.length > 1 ? 's' : ''}
          </p>
        </div>
        <div className="page-header-actions">
          <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
            <option value="">Toutes gravités</option>
            <option value="critical">Critique</option>
            <option value="warn">À surveiller</option>
            <option value="info">Information</option>
          </select>
          <button className="btn-ghost" onClick={load}>
            Rafraîchir
          </button>
          <button className="btn-danger" onClick={blockManual}>
            Bloquer une IP
          </button>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}

      {!loading && (
        <>
          <h3 style={{ marginTop: 8 }}>IP bloquées</h3>
          {blocks.length === 0 ? (
            <EmptyState
              icon={<IconAlert width={36} height={36} strokeWidth={1.4} />}
              title="Aucune IP bloquée"
              description=""
            />
          ) : (
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th>Adresse IP</th>
                    <th>Règle</th>
                    <th>Motif</th>
                    <th>Refus</th>
                    <th>Expire</th>
                    <th>État</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {blocks.map((b) => (
                    <tr key={b.ip}>
                      <td>
                        <code>{b.ip}</code>
                        {b.manual && <span className="badge" style={{ marginLeft: 6 }}>manuel</span>}
                      </td>
                      <td className="cell-secondary">{b.rule || '—'}</td>
                      <td className="cell-secondary">{b.reason || '—'}</td>
                      <td className="cell-secondary">{b.hits}</td>
                      <td className="cell-secondary">
                        {new Date(b.expires_at).toLocaleString('fr-FR')}
                      </td>
                      <td>
                        <span className={b.active ? 'badge badge-red' : 'badge'}>
                          {b.active ? 'Actif' : 'Expiré'}
                        </span>
                      </td>
                      <td>
                        {b.active && (
                          <button
                            className="btn-ghost"
                            disabled={busyIP === b.ip}
                            onClick={() => unblock(b.ip)}
                          >
                            Débloquer
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 style={{ marginTop: 24 }}>Événements récents</h3>
          {filteredEvents.length === 0 ? (
            <EmptyState
              icon={<IconAlert width={36} height={36} strokeWidth={1.4} />}
              title="Aucun événement"
              description=""
            />
          ) : (
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Gravité</th>
                    <th>Règle</th>
                    <th>Action</th>
                    <th>Service</th>
                    <th>IP</th>
                    <th>Concerné</th>
                    <th>Détail</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map((e) => (
                    <tr key={e.id}>
                      <td className="cell-secondary" style={{ whiteSpace: 'nowrap' }}>
                        {new Date(e.created_at).toLocaleString('fr-FR')}
                      </td>
                      <td>
                        <span className={severityClass(e.severity)}>
                          {SEVERITY_LABEL[e.severity] || e.severity}
                        </span>
                      </td>
                      <td>
                        <code>{e.rule}</code>
                      </td>
                      <td className="cell-secondary">{ACTION_LABEL[e.action] || e.action}</td>
                      <td className="cell-secondary">{e.svc}</td>
                      <td>
                        <code>{e.ip || '—'}</code>
                      </td>
                      <td className="cell-secondary">{e.subject || '—'}</td>
                      <td className="cell-secondary">
                        {e.detail}
                        {e.count > 0 && (
                          <span style={{ display: 'block', fontSize: 12, opacity: 0.7 }}>
                            {e.count} occurrence{e.count > 1 ? 's' : ''} / {fmtWindow(e.window_sec)}
                            {e.path ? ` · ${e.method} ${e.path}` : ''}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

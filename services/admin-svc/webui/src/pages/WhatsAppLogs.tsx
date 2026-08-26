import { useEffect, useState } from 'react'
import { ApiError, api } from '../lib/api'
import { EmptyState } from '../components/EmptyState'
import { IconAlert } from '../components/Icons'

// Journal des notifications WhatsApp (Twilio) — représentants/super-reps,
// admin, clients — voir loyalty-svc (whatsapp_logs). Reprend le testeur
// "renvoyer la notification" du plugin WordPress d'origine.

interface WhatsappLog {
  id: number
  direction: 'in' | 'out'
  phone: string
  recipient_type: string
  order_id: number | null
  template_sid: string
  message_body: string
  status: 'queued' | 'sent' | 'failed'
  error: string
  created_at: string
}

const RECIPIENT_TABS = [
  { value: '', label: 'Tous' },
  { value: 'representative', label: 'Représentants' },
  { value: 'super_rep', label: 'Super-représentants' },
  { value: 'admin', label: 'Admin' },
  { value: 'client', label: 'Clients' },
]

export function WhatsAppLogs() {
  const [items, setItems] = useState<WhatsappLog[]>([])
  const [recipientType, setRecipientType] = useState('')
  const [orderIdFilter, setOrderIdFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [resendOrderId, setResendOrderId] = useState('')
  const [resending, setResending] = useState(false)
  const [resendNotice, setResendNotice] = useState<string | null>(null)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipientType])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ limit: '100' })
      if (recipientType) params.set('recipient_type', recipientType)
      if (orderIdFilter) params.set('order_id', orderIdFilter)
      const body = await api.get<{ items: WhatsappLog[] }>(`/admin/api/whatsapp/logs?${params.toString()}`)
      setItems(body.items || [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  async function resend() {
    if (!resendOrderId) return
    setResending(true)
    setResendNotice(null)
    setError(null)
    try {
      await api.post(`/admin/api/whatsapp/resend/${resendOrderId}`, {})
      setResendNotice(`Notification renvoyée pour la commande #${resendOrderId}.`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec du renvoi')
    } finally {
      setResending(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Logs WhatsApp</h2>
          <p className="subtitle">Notifications Twilio envoyées aux représentants, à l’admin et aux clients</p>
        </div>
      </div>

      <div className="form-card" style={{ marginBottom: 16 }}>
        <div className="form-grid">
          <div className="form-field">
            <label>Renvoyer la notification d’une commande</label>
            <input
              type="number"
              placeholder="ID de commande"
              value={resendOrderId}
              onChange={(e) => setResendOrderId(e.target.value)}
            />
            <span className="hint">Rejoue la notification représentant/admin sans changer le statut de la commande</span>
          </div>
        </div>
        <div className="form-actions">
          <button className="btn-primary" disabled={resending || !resendOrderId} onClick={resend}>
            {resending ? 'Envoi…' : 'Renvoyer la notification'}
          </button>
        </div>
        {resendNotice && <p className="hint" style={{ color: '#1a7f37', fontWeight: 600 }}>{resendNotice}</p>}
      </div>

      <div className="subnav" style={{ marginBottom: 16 }}>
        {RECIPIENT_TABS.map((t) => (
          <a
            key={t.value}
            className={recipientType === t.value ? 'active' : ''}
            href="#"
            onClick={(e) => {
              e.preventDefault()
              setRecipientType(t.value)
            }}
          >
            {t.label}
          </a>
        ))}
      </div>

      <div className="form-field" style={{ marginBottom: 16, maxWidth: 260 }}>
        <label>Filtrer par ID de commande</label>
        <input
          type="number"
          placeholder="ex: 42353"
          value={orderIdFilter}
          onChange={(e) => setOrderIdFilter(e.target.value)}
          onBlur={load}
        />
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}

      {!loading && items.length === 0 && (
        <EmptyState icon={<IconAlert width={40} height={40} strokeWidth={1.4} />} title="Aucune notification WhatsApp pour l’instant" />
      )}

      {!loading && items.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Sens</th>
                <th>Destinataire</th>
                <th>Téléphone</th>
                <th>Commande</th>
                <th>Statut</th>
                <th>Message</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {items.map((log) => (
                <tr key={log.id}>
                  <td>{log.direction === 'in' ? 'Reçu' : 'Envoyé'}</td>
                  <td className="cell-secondary">{log.recipient_type || '—'}</td>
                  <td>{log.phone}</td>
                  <td className="cell-primary">{log.order_id ? `#${log.order_id}` : '—'}</td>
                  <td>
                    <span
                      style={{
                        fontWeight: 700,
                        color: log.status === 'sent' ? '#1a7f37' : log.status === 'failed' ? '#b42318' : '#8a6d00',
                      }}
                    >
                      {log.status}
                    </span>
                    {log.error && <div className="cell-secondary">{log.error}</div>}
                  </td>
                  <td className="cell-secondary" style={{ maxWidth: 320 }}>{log.message_body}</td>
                  <td className="cell-secondary">{new Date(log.created_at).toLocaleString('fr-FR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

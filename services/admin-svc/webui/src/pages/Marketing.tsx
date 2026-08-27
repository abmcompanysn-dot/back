import { useState } from 'react'
import { ApiError, api } from '../lib/api'
import { EmptyState } from '../components/EmptyState'
import { IconMarketing } from '../components/Icons'

// Coupons/fidélité (loyalty-svc) + tracking publicitaire (GTM/Meta Pixel/
// GA/flux catalogue Shopping) restent à venir — seul l'envoi d'email en
// masse (demandé le 2026-08-27) est construit ici pour l'instant.

const AUDIENCES = [
  { value: 'admins', label: 'Administrateurs' },
  { value: 'vendors', label: 'Tous les vendeurs' },
  { value: 'customers', label: 'Tous les clients' },
]

export function Marketing() {
  const [audience, setAudience] = useState('admins')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ sent: number; failed: number; total: number } | null>(null)

  async function send() {
    const audienceLabel = AUDIENCES.find((a) => a.value === audience)?.label || audience
    if (!window.confirm(`Envoyer cet email à : ${audienceLabel} ? Cette action est irréversible.`)) return
    setSending(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.post<{ sent: number; failed: number; total: number }>('/admin/api/emails/broadcast', {
        audience,
        subject,
        body: message,
      })
      setResult(res)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "échec de l'envoi")
    } finally {
      setSending(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Marketing</h2>
          <p className="subtitle">Coupons, fidélité, tracking publicitaire, envoi d'email en masse</p>
        </div>
      </div>

      <div className="form-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>Envoyer un email en masse</h3>
        <div className="form-grid">
          <div className="form-field full">
            <label>Destinataires</label>
            <select value={audience} onChange={(e) => setAudience(e.target.value)}>
              {AUDIENCES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field full">
            <label>Objet</label>
            <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Objet de l'email" />
          </div>
          <div className="form-field full">
            <label>Message</label>
            <textarea
              rows={8}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Votre message — texte simple, les retours à la ligne sont conservés"
            />
          </div>
        </div>
        <div className="form-actions">
          <button className="btn-primary" disabled={sending || !subject || !message} onClick={send}>
            {sending ? 'Envoi…' : 'Envoyer'}
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
        {result && (
          <p className="hint" style={{ marginTop: 8, color: '#1a7f37', fontWeight: 600 }}>
            {result.sent} email(s) envoyé(s) sur {result.total}
            {result.failed > 0 ? ` — ${result.failed} échec(s)` : ''}.
          </p>
        )}
      </div>

      <EmptyState
        icon={<IconMarketing width={40} height={40} strokeWidth={1.4} />}
        title="Module Marketing à venir"
        description="Coupons & promotions, programme de fidélité, et pixels de tracking (GTM, Meta Pixel, Google Analytics, flux Shopping) arriveront ici."
      />
    </div>
  )
}

import { useEffect, useState } from 'react'
import { ApiError, api } from '../lib/api'
import { EmptyState } from '../components/EmptyState'
import { IconMarketing } from '../components/Icons'

// Marketing — envoi d'email en masse (2026-08-27) + tracking publicitaire
// & flux catalogue (2026-09-02) : Pixel Meta, GA4, Conversions API Meta,
// et les URLs des flux Google Merchant / Facebook Catalogue.
// Coupons/fidélité (loyalty-svc) restent à venir.

const SITE = 'https://miadmarket.ca'

interface AdminSettings {
  meta_pixel_id?: string
  ga_measurement_id?: string
  meta_capi_token_configured?: boolean
}

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

  // ── Tracking & flux ──────────────────────────────────────────────────
  const [pixelId, setPixelId] = useState('')
  const [gaId, setGaId] = useState('')
  const [capiToken, setCapiToken] = useState('') // vide = inchangé
  const [capiConfigured, setCapiConfigured] = useState(false)
  const [savingTracking, setSavingTracking] = useState(false)
  const [trackingMsg, setTrackingMsg] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<AdminSettings>('/admin/api/settings')
      .then((s) => {
        setPixelId(s.meta_pixel_id || '')
        setGaId(s.ga_measurement_id || '')
        setCapiConfigured(!!s.meta_capi_token_configured)
      })
      .catch(() => {})
  }, [])

  async function saveTracking() {
    setSavingTracking(true)
    setTrackingMsg(null)
    try {
      const payload: Record<string, string> = {
        meta_pixel_id: pixelId.trim(),
        ga_measurement_id: gaId.trim(),
      }
      // Champ secret : n'envoyer que s'il a été rempli (vide = garder l'existant).
      if (capiToken.trim()) payload.meta_capi_token = capiToken.trim()
      await api.put('/admin/api/settings', payload)
      setCapiToken('')
      if (payload.meta_capi_token) setCapiConfigured(true)
      setTrackingMsg('Enregistré. Le site s’aligne dans les 5 min (cache).')
    } catch (e) {
      setTrackingMsg(e instanceof ApiError ? e.message : 'Enregistrement impossible')
    } finally {
      setSavingTracking(false)
    }
  }

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

      {/* ── Tracking publicitaire ─────────────────────────────────── */}
      <div className="form-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>Tracking publicitaire</h3>
        <p className="subtitle">
          Pixel Meta (Facebook/Instagram) + Google Analytics, injectés sur le site au runtime.
          La Conversions API Meta double le suivi côté serveur (fiable malgré les bloqueurs).
        </p>
        <div className="form-grid">
          <div className="form-field full">
            <label>ID du Pixel Meta</label>
            <input
              type="text"
              value={pixelId}
              onChange={(e) => setPixelId(e.target.value)}
              placeholder="ex. 1234567890123456 (chiffres uniquement)"
            />
          </div>
          <div className="form-field full">
            <label>ID de mesure Google Analytics 4</label>
            <input
              type="text"
              value={gaId}
              onChange={(e) => setGaId(e.target.value)}
              placeholder="G-XXXXXXXXXX (optionnel)"
            />
          </div>
          <div className="form-field full">
            <label>
              Token Conversions API Meta {capiConfigured && <span className="badge badge-green">configuré</span>}
            </label>
            <input
              type="password"
              value={capiToken}
              onChange={(e) => setCapiToken(e.target.value)}
              placeholder={capiConfigured ? 'laisser vide pour ne pas changer' : 'Events Manager → Paramètres → Générer un token'}
            />
          </div>
        </div>
        <div className="form-actions">
          <button className="btn-primary" disabled={savingTracking} onClick={saveTracking}>
            {savingTracking ? 'Enregistrement…' : 'Enregistrer le tracking'}
          </button>
        </div>
        {trackingMsg && (
          <p className="hint" style={{ marginTop: 8, fontWeight: 600 }}>
            {trackingMsg}
          </p>
        )}
      </div>

      {/* ── Flux catalogue ────────────────────────────────────────── */}
      <div className="form-card">
        <h3 style={{ marginTop: 0 }}>Flux catalogue (Shopping / Catalogue)</h3>
        <p className="subtitle">
          URLs à soumettre dans Google Merchant Center et dans Meta Commerce Manager.
          Actualisées automatiquement (cache 1 h) — pas d’export manuel.
        </p>
        <ul style={{ lineHeight: 1.9 }}>
          <li>
            <b>Google Merchant Center</b> →{' '}
            <a href={`${SITE}/merchant-feed.xml`} target="_blank" rel="noreferrer">
              {SITE}/merchant-feed.xml
            </a>
          </li>
          <li>
            <b>Facebook / Instagram Catalogue</b> →{' '}
            <a href={`${SITE}/facebook-feed.xml`} target="_blank" rel="noreferrer">
              {SITE}/facebook-feed.xml
            </a>
          </li>
        </ul>
        <p className="subtitle">
          Images servies en 800×800 via Cloudflare Images. Si l’aperçu Google refuse des
          images, activer <i>Speed → Optimization → Image Resizing</i> sur la zone Cloudflare.
        </p>
      </div>

      <EmptyState
        icon={<IconMarketing width={40} height={40} strokeWidth={1.4} />}
        title="Coupons & fidélité à venir"
        description="Le programme de fidélité et les coupons promotionnels (loyalty-svc) arriveront ici."
      />
    </div>
  )
}

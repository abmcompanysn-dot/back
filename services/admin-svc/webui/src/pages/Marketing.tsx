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

interface Coupon {
  code: string
  type: 'percent' | 'fixed'
  amount: number // percent: 1-100 ; fixed: centimes USD
  coin_cost: number
  max_uses: number
  used_count: number
  expires_at?: string
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

  // ── Coupons ──────────────────────────────────────────────────────────
  const [coupons, setCoupons] = useState<Coupon[]>([])
  const [couponMsg, setCouponMsg] = useState<string | null>(null)
  const [savingCoupon, setSavingCoupon] = useState(false)
  const [form, setForm] = useState({ code: '', type: 'percent' as 'percent' | 'fixed', amount: '', max_uses: '', expires_at: '' })

  function loadCoupons() {
    api
      .get<{ coupons: Coupon[] }>('/admin/api/coupons')
      .then((d) => setCoupons(d.coupons || []))
      .catch(() => {})
  }

  useEffect(() => {
    api
      .get<AdminSettings>('/admin/api/settings')
      .then((s) => {
        setPixelId(s.meta_pixel_id || '')
        setGaId(s.ga_measurement_id || '')
        setCapiConfigured(!!s.meta_capi_token_configured)
      })
      .catch(() => {})
    loadCoupons()
  }, [])

  async function saveCoupon() {
    const amt = parseInt(form.amount, 10)
    if (!form.code.trim() || !(amt > 0)) {
      setCouponMsg('Code et montant (> 0) requis.')
      return
    }
    if (form.type === 'percent' && amt > 100) {
      setCouponMsg('Un pourcentage ne peut pas dépasser 100.')
      return
    }
    setSavingCoupon(true)
    setCouponMsg(null)
    try {
      await api.post('/admin/api/coupons', {
        code: form.code.trim().toUpperCase(),
        type: form.type,
        // fixed : l'admin saisit des dollars → on stocke des centimes.
        amount: form.type === 'fixed' ? Math.round(amt * 100) : amt,
        max_uses: parseInt(form.max_uses, 10) || 0,
        expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
      })
      setForm({ code: '', type: 'percent', amount: '', max_uses: '', expires_at: '' })
      loadCoupons()
      setCouponMsg('Coupon enregistré.')
    } catch (e) {
      setCouponMsg(e instanceof ApiError ? e.message : 'Enregistrement impossible')
    } finally {
      setSavingCoupon(false)
    }
  }

  async function removeCoupon(code: string) {
    if (!window.confirm(`Supprimer le coupon ${code} ?`)) return
    try {
      await api.delete(`/admin/api/coupons/${encodeURIComponent(code)}`)
      loadCoupons()
    } catch (e) {
      setCouponMsg(e instanceof ApiError ? e.message : 'Suppression impossible')
    }
  }

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

      {/* ── Coupons ───────────────────────────────────────────────── */}
      <div className="form-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>Codes promo</h3>
        <p className="subtitle">
          Actifs immédiatement au checkout (loyalty-svc). Le site affiche les codes non
          expirés / non épuisés dans le carrousel « Tickets Réduction » (cache 5 min).
        </p>

        <table className="data-table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Code</th>
              <th>Réduction</th>
              <th>Utilisations</th>
              <th>Expire</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {coupons.length === 0 && (
              <tr>
                <td colSpan={5} className="subtitle">Aucun code promo.</td>
              </tr>
            )}
            {coupons.map((c) => (
              <tr key={c.code}>
                <td><b>{c.code}</b></td>
                <td>{c.type === 'percent' ? `${c.amount} %` : `${(c.amount / 100).toFixed(2)} $`}</td>
                <td>{c.max_uses > 0 ? `${c.used_count} / ${c.max_uses}` : `${c.used_count} / ∞`}</td>
                <td>{c.expires_at ? new Date(c.expires_at).toLocaleDateString('fr-FR') : '—'}</td>
                <td>
                  <button className="btn btn-sm btn-danger" onClick={() => removeCoupon(c.code)}>
                    Supprimer
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div
          className="form-grid"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginTop: 16 }}
        >
          <label>
            <span>Code</span>
            <input
              type="text"
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
              placeholder="MIAD10"
            />
          </label>
          <label>
            <span>Type</span>
            <select
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as 'percent' | 'fixed' }))}
            >
              <option value="percent">Pourcentage</option>
              <option value="fixed">Montant fixe ($)</option>
            </select>
          </label>
          <label>
            <span>{form.type === 'percent' ? 'Pourcentage (1-100)' : 'Montant en $'}</span>
            <input
              type="number"
              min="1"
              step={form.type === 'percent' ? '1' : '0.01'}
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            />
          </label>
          <label>
            <span>Utilisations max (0 = illimité)</span>
            <input
              type="number"
              min="0"
              value={form.max_uses}
              onChange={(e) => setForm((f) => ({ ...f, max_uses: e.target.value }))}
            />
          </label>
          <label>
            <span>Expiration (optionnel)</span>
            <input
              type="date"
              value={form.expires_at}
              onChange={(e) => setForm((f) => ({ ...f, expires_at: e.target.value }))}
            />
          </label>
        </div>
        <div className="form-actions" style={{ marginTop: 12 }}>
          <button className="btn-primary" disabled={savingCoupon} onClick={saveCoupon}>
            {savingCoupon ? 'Enregistrement…' : 'Ajouter / mettre à jour'}
          </button>
        </div>
        {couponMsg && (
          <p className="hint" style={{ marginTop: 8, fontWeight: 600 }}>
            {couponMsg}
          </p>
        )}
      </div>

      <EmptyState
        icon={<IconMarketing width={40} height={40} strokeWidth={1.4} />}
        title="Programme de fidélité à venir"
        description="Les points fidélité et paliers (loyalty-svc) arriveront ici."
      />
    </div>
  )
}

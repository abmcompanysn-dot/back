import { useState } from 'react'
import { ApiError, api } from '../lib/api'

interface Setup2FAResponse {
  secret: string
  otpauth_url: string
}

export function Security() {
  const [setupResult, setSetupResult] = useState<Setup2FAResponse | null>(null)
  const [verifyCode, setVerifyCode] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  async function startSetup() {
    setMessage(null)
    setBusy(true)
    try {
      const body = await api.post<Setup2FAResponse>('/auth/admin/2fa/setup')
      setSetupResult(body)
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : 'échec', ok: false })
    } finally {
      setBusy(false)
    }
  }

  async function confirmSetup() {
    setBusy(true)
    try {
      await api.post('/auth/admin/2fa/verify', { code: verifyCode })
      setMessage({ text: '2FA activée — elle sera exigée à la prochaine connexion.', ok: true })
      setSetupResult(null)
      setVerifyCode('')
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : 'échec', ok: false })
    } finally {
      setBusy(false)
    }
  }

  async function disable() {
    setBusy(true)
    try {
      await api.post('/auth/admin/2fa/disable', { code: disableCode })
      setMessage({ text: '2FA désactivée.', ok: true })
      setDisableCode('')
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : 'échec', ok: false })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="qr-box">
      <h3>Double authentification (2FA)</h3>
      <p>Protège la connexion admin avec un code à usage unique, en plus du mot de passe.</p>

      <p>
        Pour activer : générez un secret, scannez-le (ou saisissez-le manuellement) dans Google
        Authenticator / Authy, puis confirmez avec le premier code généré.
      </p>
      <button className="btn-primary" onClick={startSetup} disabled={busy}>
        Générer un secret
      </button>

      {setupResult && (
        <div>
          <p style={{ marginTop: 12 }}>Secret (saisie manuelle si le scan ne fonctionne pas) :</p>
          <div className="secret-code">{setupResult.secret}</div>
          <p style={{ fontSize: 12, wordBreak: 'break-all' }}>{setupResult.otpauth_url}</p>
          <p>Entrez le code généré par l'app pour confirmer :</p>
          <input
            placeholder="123456"
            inputMode="numeric"
            maxLength={6}
            value={verifyCode}
            onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
            style={{ width: 120, padding: 6, marginRight: 8 }}
          />
          <button className="btn-primary" onClick={confirmSetup} disabled={busy || verifyCode.length !== 6}>
            Confirmer et activer
          </button>
        </div>
      )}

      <hr style={{ margin: '16px 0', border: 'none', borderTop: '1px solid #eee' }} />
      <p>Pour désactiver une 2FA déjà active, entrez un code valide :</p>
      <input
        placeholder="123456"
        inputMode="numeric"
        maxLength={6}
        value={disableCode}
        onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ''))}
        style={{ width: 120, padding: 6, marginRight: 8 }}
      />
      <button className="btn-danger" onClick={disable} disabled={busy || disableCode.length !== 6}>
        Désactiver la 2FA
      </button>

      {message && (
        <p style={{ fontSize: 13, color: message.ok ? '#0a7a2f' : '#c02020' }}>{message.text}</p>
      )}
    </div>
  )
}

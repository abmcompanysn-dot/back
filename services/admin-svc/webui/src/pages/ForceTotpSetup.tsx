import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { ApiError, api } from '../lib/api'

// ForceTotpSetup — 2FA obligatoire (2026-08-26). Affiché à la place du
// dashboard tant que totpSetupRequired est true (voir App.tsx) : un admin
// nouvellement créé, ou dont la 2FA a été désactivée, ne peut accéder à
// AUCUNE page tant qu'il n'a pas configuré et confirmé un premier code.
// Pas de génération de QR code (aucune lib externe dans ce dépôt, voir
// api.ts) — le secret et l'URL otpauth sont affichés en texte, saisissables
// manuellement dans une app d'authentification (Google Authenticator, Authy,
// 1Password...), qui savent aussi coller directement une otpauth://.
export function ForceTotpSetup() {
  const { logout, markTotpSetupComplete } = useAuth()
  const [secret, setSecret] = useState('')
  const [otpauthURL, setOtpauthURL] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [verifying, setVerifying] = useState(false)

  useEffect(() => {
    setup()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function setup() {
    setLoading(true)
    setError('')
    try {
      const body = await api.post<{ secret: string; otpauth_url: string }>('/auth/admin/2fa/setup')
      setSecret(body.secret)
      setOtpauthURL(body.otpauth_url)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'impossible de générer un secret 2FA')
    } finally {
      setLoading(false)
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault()
    setVerifying(true)
    setError('')
    try {
      await api.post('/auth/admin/2fa/verify', { code })
      markTotpSetupComplete()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'code incorrect')
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={confirm} style={{ maxWidth: 420 }}>
        <h2>Configuration de la double authentification</h2>
        <p className="login-hint">
          Obligatoire pour tous les comptes admin. Ouvrez une application d'authentification (Google Authenticator,
          Authy, 1Password…) et ajoutez ce compte avec la clé ci-dessous.
        </p>

        {loading && <p>Génération du secret…</p>}

        {!loading && secret && (
          <>
            <div className="form-field">
              <label>Clé secrète (à saisir manuellement)</label>
              <input readOnly value={secret} onClick={(e) => (e.target as HTMLInputElement).select()} />
            </div>
            <p className="hint" style={{ wordBreak: 'break-all' }}>
              <a href={otpauthURL}>{otpauthURL}</a>
            </p>

            <p className="login-hint">Entrez le code à 6 chiffres généré par l'application pour confirmer :</p>
            <input
              className="totp-input"
              placeholder="123456"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
              required
            />
            <button type="submit" disabled={verifying || code.length !== 6}>
              {verifying ? '…' : 'Confirmer et continuer'}
            </button>
          </>
        )}

        {error && <p className="login-error">{error}</p>}

        <button type="button" className="btn-ghost" onClick={logout} style={{ marginTop: 12 }}>
          Se déconnecter
        </button>
      </form>
    </div>
  )
}

import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { ApiError } from '../lib/api'

export function Login() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await login(email, password, step === 'totp' ? totpCode : undefined)
      if (result.totpRequired) {
        setStep('totp')
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'erreur inattendue')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <h2>Connexion admin</h2>
        {step === 'credentials' ? (
          <>
            <input
              type="email"
              placeholder="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
            />
            <input
              type="password"
              placeholder="mot de passe"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </>
        ) : (
          <>
            <p className="login-hint">Code de vérification (application d'authentification)</p>
            <input
              className="totp-input"
              placeholder="123456"
              inputMode="numeric"
              maxLength={6}
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
              required
            />
          </>
        )}
        <button type="submit" disabled={loading}>
          {loading ? '…' : step === 'credentials' ? 'Se connecter' : 'Valider'}
        </button>
        {error && <p className="login-error">{error}</p>}
      </form>
    </div>
  )
}

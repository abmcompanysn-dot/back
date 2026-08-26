import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { ApiError, SESSION_EXPIRED_EVENT, api, clearToken, getToken, setToken } from './api'

interface LoginResult {
  totpRequired: boolean
}

interface AuthContextValue {
  isAuthenticated: boolean
  email: string | null
  totpSetupRequired: boolean
  login: (email: string, password: string, totpCode?: string) => Promise<LoginResult>
  logout: () => void
  markTotpSetupComplete: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

interface AdminSession {
  jwt: string
  expires_at: string
}

interface AdminLoginResponse {
  session?: AdminSession
  totp_required?: boolean
  totp_setup_required?: boolean
  role?: string
  email?: string
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getToken())
  const [email, setEmail] = useState<string | null>(null)
  // 2FA obligatoire (2026-08-26) : true dès que le login renvoie
  // totp_setup_required — bloque l'accès au dashboard (voir App.tsx,
  // RequireAuth) tant que l'admin n'a pas configuré/confirmé sa 2FA via
  // ForceTotpSetup. Pas persisté au rechargement de page volontairement :
  // un rechargement avec un token déjà valide (2FA déjà active côté
  // serveur) ne doit pas re-déclencher le blocage — seul un NOUVEAU login
  // sans totp_enabled le fait, cohérent avec le fait que adminLogin est
  // la seule route qui renvoie ce flag.
  const [totpSetupRequired, setTotpSetupRequired] = useState(false)

  async function login(loginEmail: string, password: string, totpCode?: string): Promise<LoginResult> {
    const body = await api.post<AdminLoginResponse>('/auth/admin/login', {
      email: loginEmail,
      password,
      totp_code: totpCode || undefined,
    })
    if (body.totp_required) {
      return { totpRequired: true }
    }
    if (!body.session) {
      throw new ApiError(500, 'no_session', 'réponse de connexion inattendue')
    }
    setToken(body.session.jwt)
    setEmail(loginEmail)
    setTotpSetupRequired(!!body.totp_setup_required)
    setIsAuthenticated(true)
    return { totpRequired: false }
  }

  function logout() {
    clearToken()
    setIsAuthenticated(false)
    setEmail(null)
    setTotpSetupRequired(false)
  }

  function markTotpSetupComplete() {
    setTotpSetupRequired(false)
  }

  // Déconnexion automatique quand une requête API revient 401/403 (token
  // expiré ou révoqué via /revoke-sessions) — voir SESSION_EXPIRED_EVENT
  // dans api.ts. Sans ça, isAuthenticated restait bloqué à true jusqu'au
  // prochain rechargement manuel de page.
  useEffect(() => {
    const onSessionExpired = () => logout()
    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired)
  }, [])

  return (
    <AuthContext.Provider value={{ isAuthenticated, email, totpSetupRequired, login, logout, markTotpSetupComplete }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth doit être utilisé dans <AuthProvider>')
  return ctx
}

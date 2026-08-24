import { createContext, useContext, useState, type ReactNode } from 'react'
import { ApiError, api, clearToken, getToken, setToken } from './api'

interface LoginResult {
  totpRequired: boolean
}

interface AuthContextValue {
  isAuthenticated: boolean
  email: string | null
  login: (email: string, password: string, totpCode?: string) => Promise<LoginResult>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

interface AdminSession {
  jwt: string
  expires_at: string
}

interface AdminLoginResponse {
  session?: AdminSession
  totp_required?: boolean
  role?: string
  email?: string
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getToken())
  const [email, setEmail] = useState<string | null>(null)

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
    setIsAuthenticated(true)
    return { totpRequired: false }
  }

  function logout() {
    clearToken()
    setIsAuthenticated(false)
    setEmail(null)
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, email, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth doit être utilisé dans <AuthProvider>')
  return ctx
}

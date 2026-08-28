// Client HTTP minimal — pas de bibliothèque externe, cohérent avec le
// reste du dépôt (JWT signé à la main, TOTP RFC 6238 en Go pur, etc.).

const TOKEN_KEY = 'miad_admin_jwt'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

// SESSION_EXPIRED_EVENT — émis dès qu'une requête revient 401/403 (JWT
// expiré, révoqué via /revoke-sessions, ou absent). AuthProvider (auth.tsx)
// écoute cet événement pour déclencher logout() immédiatement, plutôt que
// de laisser chaque page gérer silencieusement son propre ApiError — sans
// ça, une session expirée ne redirigeait jamais vers /admin/login, elle
// se contentait de faire échouer les appels un par un.
export const SESSION_EXPIRED_EVENT = 'miad-admin-session-expired'

// request — toutes les routes /admin/api/* passent par admin-svc (même
// origine que le dashboard). Les routes /auth/* (login, 2FA) passent
// directement par la passerelle Caddy, même origine également.
async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${getToken()}`,
      ...opts.headers,
    },
  })
  if (res.status === 401 || res.status === 403) {
    const hadToken = !!getToken()
    clearToken()
    // Seulement si on avait un token : évite de déclencher un logout/
    // redirection en boucle sur la page de login elle-même (ses appels
    // à /auth/admin/login échouent normalement en 401 sans token au
    // premier chargement, ce n'est pas une session qui expire).
    if (hadToken) {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
    }
    throw new ApiError(res.status, 'forbidden', 'session expirée — reconnectez-vous')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code || 'error', body?.error?.message || 'erreur API')
  }
  return body as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', body: data ? JSON.stringify(data) : undefined }),
  patch: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PATCH', body: data ? JSON.stringify(data) : undefined }),
  put: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PUT', body: data ? JSON.stringify(data) : undefined }),
  // data optionnel — ajouté le 2026-08-28 (PaymentRouting.tsx a besoin
  // d'identifier la ligne à supprimer par son contenu, pas juste son
  // path) : la plupart des appels DELETE existants n'en ont pas besoin
  // (path suffit), donc reste optionnel plutôt que de casser leur appel.
  delete: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'DELETE', body: data ? JSON.stringify(data) : undefined }),
}

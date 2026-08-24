/**
 * Signature de JWT pour les comptes de service Firebase/Google, en utilisant
 * uniquement la Web Crypto API (compatible Node.js ET Cloudflare Workers —
 * contrairement au module `crypto` natif de Node, indisponible sur l'edge).
 */

type ServiceAccount = { client_email: string; private_key: string }

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlFromString(input: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(input))
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function getServiceAccount(): ServiceAccount {
  const key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
  if (!key) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY not set')
  return JSON.parse(key) as ServiceAccount
}

/**
 * Signe un JWT RS256 pour un compte de service Google/Firebase à partir de
 * claims arbitraires (aud/scope variables selon l'usage : Firebase Auth
 * custom token, OAuth2 pour l'API FCM HTTP v1, etc.).
 */
async function signServiceAccountJWT(claims: Record<string, unknown>): Promise<string> {
  const sa = getServiceAccount()
  const iat = Math.floor(Date.now() / 1000)

  const header  = base64UrlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64UrlFromString(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    iat,
    exp: iat + 3600,
    ...claims,
  }))

  const signingInput = `${header}.${payload}`

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  )

  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`
}

/**
 * Crée un Firebase custom token (pour signInWithCustomToken côté client).
 */
export async function createFirebaseCustomToken(uid: string, additionalClaims?: Record<string, unknown>): Promise<string> {
  return signServiceAccountJWT({
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    uid,
    ...(additionalClaims ? { claims: additionalClaims } : {}),
  })
}

/**
 * Échange un JWT signé contre un access token OAuth2 Google, pour appeler
 * des API Google (ex: FCM HTTP v1) sans le SDK firebase-admin.
 */
export async function getGoogleAccessToken(scope: string): Promise<string> {
  const jwt = await signServiceAccountJWT({
    aud: 'https://oauth2.googleapis.com/token',
    scope,
  })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`,
  })

  if (!res.ok) throw new Error(`OAuth2 token exchange failed: ${await res.text()}`)
  const data = await res.json() as { access_token: string }
  return data.access_token
}

/**
 * Dérive un UID Firebase déterministe à partir d'une adresse email.
 * Le même email produit toujours le même UID — aucune recherche utilisateur nécessaire.
 */
export async function uidFromEmail(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.toLowerCase()))
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
  return 'otp_' + hex.slice(0, 28)
}

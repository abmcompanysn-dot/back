/**
 * Authentification serveur — vérifie le JWT HS256 émis par auth-svc
 * (backend Go) directement côté edge via Web Crypto, sans aller-retour
 * réseau pour la simple vérification de rôle. Remplace les deux
 * mécanismes WordPress incompatibles (jetons miad_* et wp-json/jwt-auth)
 * qui n'ont plus cours depuis la migration vers le backend Go.
 *
 * fetchWpUser/isAdmin/isRep gardent leur nom et leur signature (utilisés
 * tels quels par ~14 routes app/api/**) pour limiter le nombre de fichiers
 * à toucher lors de la migration — seul leur contenu change.
 */

import { requireEnv } from './require-env'

export const CATALOG_SVC_URL = requireEnv('CATALOG_SVC_URL')
export const VENDOR_SVC_URL = requireEnv('VENDOR_SVC_URL')
export const ORDER_SVC_URL = requireEnv('ORDER_SVC_URL')
export const PAYMENT_SVC_URL = requireEnv('PAYMENT_SVC_URL')
export const SHIPPING_SVC_URL = requireEnv('SHIPPING_SVC_URL')
export const AUTH_SVC_URL = requireEnv('AUTH_SVC_URL')
export const NOTIFICATION_SVC_URL = requireEnv('NOTIFICATION_SVC_URL')
export const EMAIL_SVC_URL = requireEnv('EMAIL_SVC_URL')
export const FULFILLMENT_SVC_URL = requireEnv('FULFILLMENT_SVC_URL')
export const LOYALTY_SVC_URL = requireEnv('LOYALTY_SVC_URL')
export const ADMIN_SVC_URL = requireEnv('ADMIN_SVC_URL')
const JWT_SECRET = requireEnv('JWT_SECRET')

export const REP_ROLES = ['representative']

interface JWTClaims {
  sub: number | string
  role: string
  email?: string
  vendor_id?: number | null
  provider?: string
  exp: number
  [key: string]: unknown
}

/** En-tête d'autorisation unique — un seul mécanisme (JWT HS256 auth-svc). */
export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

// Alias conservé pour les ~14 fichiers app/api/** qui importent encore
// wpHeaders sans avoir été réécrits individuellement (Pattern 1/2 de la
// migration) — même comportement qu'authHeaders, juste l'ancien nom.
export const wpHeaders = authHeaders

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function base64UrlToString(b64url: string): string {
  return new TextDecoder().decode(base64UrlToBytes(b64url))
}

let cachedKey: Promise<CryptoKey> | null = null
function hmacKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    cachedKey = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
  }
  return cachedKey
}

/**
 * Vérifie la signature HS256 et l'expiration d'un JWT émis par auth-svc,
 * entièrement côté edge (Web Crypto) — pas d'appel réseau pour un simple
 * contrôle de rôle. Renvoie les claims si valides, null sinon.
 */
export async function verifyJWT(token: string): Promise<JWTClaims | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header, payload, signature] = parts

    const key = await hmacKey()
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    )
    if (!valid) return null

    const claims = JSON.parse(base64UrlToString(payload)) as JWTClaims
    if (typeof claims.exp === 'number' && Date.now() / 1000 > claims.exp) return null
    return claims
  } catch {
    return null
  }
}

/**
 * fetchWpUser — nom conservé pour compatibilité avec les ~14 appelants
 * existants. Ne fait plus d'appel réseau (le rôle est déjà dans le JWT) :
 * vérifie juste la signature et renvoie un objet compatible avec l'usage
 * actuel (isAdmin/isRep lisent `.role`).
 */
export async function fetchWpUser(token: string): Promise<JWTClaims | null> {
  return verifyJWT(token)
}

export function isAdmin(user: JWTClaims | null): boolean {
  return user?.role === 'admin'
}

// Un vendeur est un customer avec vendor_id non nul dans son JWT (voir
// A.10 côté auth-svc) — pas un rôle séparé.
export function isVendor(user: JWTClaims | null): boolean {
  return user?.role === 'customer' && user?.vendor_id != null
}

/**
 * isRep — le rôle représentant n'est pas un claim JWT (loyalty-svc est la
 * source de vérité, résolu par email — auth-svc n'a pas de claim
 * representative_id dédié) : nécessite un appel réseau, contrairement à
 * isAdmin/isVendor. Fonction ASYNCHRONE : tout appelant doit faire
 * `await isRep(user)`, jamais `isRep(user)` seul (une Promise est
 * toujours truthy — `if (!isRep(user))` sans await ne rejetterait jamais
 * personne). Voir fetchRepresentative pour récupérer aussi les données
 * complètes en un seul appel si la route en a besoin de toute façon.
 */
export async function isRep(user: JWTClaims | null): Promise<boolean> {
  return (await fetchRepresentative(user)) !== null
}

export interface Representative {
  id: number
  name: string
  email: string
  country: string
  is_super_rep: boolean
  commission_pct: number
}

export async function fetchRepresentative(user: JWTClaims | null): Promise<Representative | null> {
  if (!user?.email) return null
  try {
    const res = await fetch(`${LOYALTY_SVC_URL}/representative/by-email/${encodeURIComponent(user.email)}`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    return (await res.json()) as Representative
  } catch {
    return null
  }
}

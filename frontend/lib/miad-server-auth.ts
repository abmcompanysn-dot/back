/**
 * Server-side helpers for authenticating Next.js → WordPress calls.
 *
 * For miad_ session tokens (OTP login): sends X-Headless-Secret + X-Miad-Session
 * so the JWT Auth WordPress plugin never intercepts the token.
 *
 * For JWT tokens (Gmail/Firebase login): sends the standard Authorization header.
 */

import { requireEnv } from './require-env'

export const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')
export const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

export const REP_ROLES = [
  'miad_representative', 'miad_representant', 'representant', 'miad_rep', 'miad_agent',
  'miad_super_rep',
]

/**
 * Headers for WordPress calls.
 *
 * For miad_ tokens we send BOTH:
 *   - X-Miad-Session  → picked up by Method 2 in miad_get_user_from_token() (new PHP)
 *   - Authorization   → picked up by Method 1, which works once the
 *                       rest_authentication_errors bypass at PHP_INT_MAX is active (old PHP)
 * Either mechanism is sufficient; having both makes the system robust across deploy states.
 */
export function wpHeaders(token: string): Record<string, string> {
  if (token.startsWith('miad_')) {
    // No Authorization header — JWT Auth only intercepts Bearer tokens.
    // X-Headless-Secret + X-Miad-Session is the server-to-server channel
    // that bypasses JWT Auth completely (Method 2 in PHP).
    return {
      'X-Headless-Secret': INTERNAL_SECRET,
      'X-Miad-Session': token,
      'Content-Type': 'application/json',
      'User-Agent': 'MIAD-Headless-Client',
    }
  }
  return {
    Authorization: `Bearer ${token}`,
    'X-Headless-Secret': INTERNAL_SECRET,
    'Content-Type': 'application/json',
    'User-Agent': 'MIAD-Headless-Client',
  }
}

/**
 * Returns the correct "who am I?" endpoint for the token type.
 * miad_ → /miad/v1/me  (reads X-Miad-Session, no JWT Auth)
 * JWT  → /wp/v2/users/me
 */
export function meUrl(token: string): string {
  return token.startsWith('miad_')
    ? `${WOO_URL}/wp-json/miad/v1/me`
    : `${WOO_URL}/wp-json/wp/v2/users/me?context=edit`
}

/**
 * Fetch the WordPress user profile for a given token.
 * Returns null if invalid / expired.
 */
export async function fetchWpUser(token: string): Promise<any | null> {
  try {
    const res = await fetch(meUrl(token), { headers: wpHeaders(token), cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    if (!data) return null
    // Normalise roles array
    return { ...data, roles: data.roles || (data.role ? [data.role] : []) }
  } catch {
    return null
  }
}

export function isAdmin(user: any): boolean {
  const roles: string[] = user?.roles || []
  return roles.includes('administrator') || user?.role === 'admin'
}

export function isRep(user: any): boolean {
  const roles: string[] = user?.roles || []
  const role: string = user?.role || ''
  return REP_ROLES.includes(role) || roles.some(r => REP_ROLES.includes(r))
}

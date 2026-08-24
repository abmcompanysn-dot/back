/**
 * Client headless centralisé pour les routes admin/représentant.
 *
 * Toute route Next.js qui (1) vérifie un rôle admin/rep puis (2) relaie un
 * appel vers le backend Go doit passer par callHeadlessAdmin() au lieu de
 * dupliquer auth + fetch + gestion d'erreur à la main. Bénéfices :
 *  - jamais d'échec silencieux : toute erreur renvoie upstreamStatus/upstreamBody
 *  - chaque appel est tracé dans le journal admin-svc (POST /admin/api/
 *    action-log), en tâche de fond — n'ajoute jamais de latence perceptible
 *    à l'action admin elle-même.
 *
 * Migration WordPress → backend Go : `path` pointe désormais vers admin-svc
 * (ex. "/admin/api/orders" au lieu de "/wp-json/wc/v3/orders"), plus de
 * Basic Auth WooCommerce (auth: 'wc-basic' supprimé — admin-svc vérifie le
 * même JWT que le reste du site).
 */

import { ADMIN_SVC_URL, fetchWpUser, isAdmin, isRep } from './miad-server-auth'

export type HeadlessAdminResult<T = any> =
  | { ok: true; status: 200; data: T }
  | { ok: false; status: number; error: string; upstreamStatus?: number; upstreamBody?: string }

export interface CallHeadlessAdminOptions {
  /** Rôle minimum requis pour exécuter l'action. */
  role: 'admin' | 'rep' | 'admin-or-rep'
  /** Libellé court pour le journal, ex: "orders.admin.list". */
  action: string
  /** Chemin admin-svc, ex: "/admin/api/orders". */
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH'
  /** Peut dépendre de l'utilisateur authentifié résolu (ex: filtrer par rep_id). */
  query?: Record<string, string | number | undefined> | ((user: any) => Record<string, string | number | undefined>)
  /** Corps de la requête — peut dépendre de l'utilisateur authentifié résolu. */
  body?: unknown | ((user: any) => unknown)
}

async function scheduleBackground(task: Promise<unknown>): Promise<void> {
  try {
    // Import dynamique : n'existe pas en `next dev` local (pas de contexte Cloudflare).
    const { getRequestContext } = await import('@cloudflare/next-on-pages')
    getRequestContext().ctx.waitUntil(task.catch(() => {}))
  } catch {
    await task.catch(() => {})
  }
}

async function logAdminAction(
  request: Request,
  token: string,
  user: any,
  opts: CallHeadlessAdminOptions,
  outcome: { status: 'success' | 'error'; upstreamStatus?: number; detail?: string }
): Promise<void> {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || ''
  const country = request.headers.get('cf-ipcountry') || ''
  const userAgent = request.headers.get('user-agent') || ''
  const actorRole = isAdmin(user) ? 'admin' : (await isRep(user)) ? 'rep' : (user?.role || 'unknown')

  await fetch(`${ADMIN_SVC_URL}/admin/api/action-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      actor_id: user?.sub,
      actor_email: user?.email,
      actor_role: actorRole,
      action: opts.action,
      endpoint: opts.path,
      status: outcome.status,
      wp_status: outcome.upstreamStatus,
      ip,
      country,
      user_agent: userAgent,
      // Détail de l'erreur (corps de la réponse upstream tronqué) — sans
      // ça, le journal montre un statut mais jamais la vraie cause.
      metadata: outcome.detail ? outcome.detail.slice(0, 1500) : undefined,
    }),
  }).catch(() => {})
}

export async function callHeadlessAdmin<T = any>(
  request: Request,
  opts: CallHeadlessAdminOptions
): Promise<HeadlessAdminResult<T>> {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Non autorisé' }
  }
  const token = auth.slice(7)

  const user = await fetchWpUser(token)
  if (!user) {
    return { ok: false, status: 401, error: 'Session invalide' }
  }

  const allowed =
    opts.role === 'admin' ? isAdmin(user) :
    opts.role === 'rep' ? await isRep(user) :
    isAdmin(user) || (await isRep(user))
  if (!allowed) {
    return { ok: false, status: 403, error: 'Accès refusé' }
  }

  const method = opts.method || 'GET'
  const resolvedQuery = typeof opts.query === 'function' ? opts.query(user) : (opts.query || {})
  const url = new URL(`${ADMIN_SVC_URL}${opts.path}`)
  for (const [key, value] of Object.entries(resolvedQuery)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }

  let bodyStr: string | undefined
  if (opts.body !== undefined && method !== 'GET') {
    const resolvedBody = typeof opts.body === 'function' ? (opts.body as (u: any) => unknown)(user) : opts.body
    bodyStr = JSON.stringify(resolvedBody)
    headers['Content-Type'] = 'application/json'
  }

  let res: Response
  try {
    res = await fetch(url.toString(), { method, headers, body: bodyStr, cache: 'no-store' })
  } catch (e: any) {
    await scheduleBackground(logAdminAction(request, token, user, opts, { status: 'error', detail: e?.message }))
    return { ok: false, status: 502, error: 'Impossible de joindre le backend' }
  }

  if (!res.ok) {
    const upstreamBody = await res.text().catch(() => '')
    await scheduleBackground(logAdminAction(request, token, user, opts, { status: 'error', upstreamStatus: res.status, detail: upstreamBody }))
    // Status 200 délibéré : certains niveaux d'infra (CDN/edge) remplacent le
    // corps des réponses 5xx par leur propre page générique, ce qui masquait
    // le vrai diagnostic côté client. L'erreur reste dans le champ `error`.
    return { ok: false, status: 200, error: 'Erreur serveur backend', upstreamStatus: res.status, upstreamBody: upstreamBody.slice(0, 500) }
  }

  const data = await res.json().catch(() => null)
  await scheduleBackground(logAdminAction(request, token, user, opts, { status: 'success', upstreamStatus: res.status }))
  return { ok: true, status: 200, data: data as T }
}

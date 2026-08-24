/**
 * Client headless centralisé pour les routes admin/représentant.
 *
 * Toute route Next.js qui (1) vérifie un rôle admin/rep puis (2) relaie un
 * appel vers WordPress doit passer par callHeadlessAdmin() au lieu de
 * dupliquer auth + fetch + gestion d'erreur à la main. Bénéfices :
 *  - jamais d'échec silencieux : toute erreur renvoie wpStatus/wpBody
 *  - chaque appel est tracé (qui, quoi, quand, depuis où) dans le journal
 *    WordPress (/miad/v1/admin-action-log), en tâche de fond — n'ajoute
 *    jamais de latence perceptible à l'action admin elle-même.
 */

import { WOO_URL, INTERNAL_SECRET, fetchWpUser, isAdmin, isRep } from './miad-server-auth'

export type HeadlessAdminResult<T = any> =
  | { ok: true; status: 200; data: T }
  | { ok: false; status: number; error: string; wpStatus?: number; wpBody?: string }

export interface CallHeadlessAdminOptions {
  /** Rôle minimum requis pour exécuter l'action. */
  role: 'admin' | 'rep' | 'admin-or-rep'
  /** Libellé court pour le journal, ex: "orders.admin.list". */
  action: string
  /** Chemin WordPress, ex: "/wp-json/wc/v3/orders". */
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH'
  /**
   * 'secret' (défaut) : appel à un endpoint miad/* protégé par X-Headless-Secret.
   * 'wc-basic' : appel à un endpoint wc/v3/* core WooCommerce, authentifié par
   *              Basic Auth avec les clés WOO_CONSUMER_KEY/SECRET.
   */
  auth?: 'secret' | 'wc-basic'
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

function logAdminAction(
  request: Request,
  user: any,
  opts: CallHeadlessAdminOptions,
  outcome: { status: 'success' | 'error'; wpStatus?: number; detail?: string }
): Promise<void> {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || ''
  const country = request.headers.get('cf-ipcountry') || ''
  const userAgent = request.headers.get('user-agent') || ''
  const actorRole = isAdmin(user) ? 'admin' : isRep(user) ? 'rep' : (user?.role || 'unknown')

  return fetch(`${WOO_URL}/wp-json/miad/v1/admin-action-log`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Headless-Secret': INTERNAL_SECRET,
      'User-Agent': 'MIAD-Headless-Client',
    },
    body: JSON.stringify({
      actor_id: user?.id,
      actor_email: user?.email,
      actor_role: actorRole,
      action: opts.action,
      wp_endpoint: opts.path,
      status: outcome.status,
      wp_status: outcome.wpStatus,
      ip,
      country,
      user_agent: userAgent,
      // Détail de l'erreur (corps de la réponse WP tronqué) — sans ça, le
      // journal montre un statut mais jamais la vraie cause (cf. le 500 sur
      // recommendations.send-emails découvert le 2026-07-10, illisible sans
      // ce champ).
      metadata: outcome.detail ? outcome.detail.slice(0, 1500) : undefined,
    }),
  }).then(() => {})
}

export async function callHeadlessAdmin<T = any>(
  request: Request,
  opts: CallHeadlessAdminOptions
): Promise<HeadlessAdminResult<T>> {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Non autorisé' }
  }

  const user = await fetchWpUser(auth.slice(7))
  if (!user) {
    return { ok: false, status: 401, error: 'Session invalide' }
  }

  const allowed =
    opts.role === 'admin' ? isAdmin(user) :
    opts.role === 'rep' ? isRep(user) :
    isAdmin(user) || isRep(user)
  if (!allowed) {
    return { ok: false, status: 403, error: 'Accès refusé' }
  }

  const method = opts.method || 'GET'
  const resolvedQuery = typeof opts.query === 'function' ? opts.query(user) : (opts.query || {})
  const url = new URL(`${WOO_URL}${opts.path}`)
  for (const [key, value] of Object.entries(resolvedQuery)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  const headers: Record<string, string> = { 'User-Agent': 'MIAD-Headless-Client' }
  if (opts.auth === 'wc-basic') {
    const wcKey = process.env.WOO_CONSUMER_KEY || ''
    const wcSecret = process.env.WOO_CONSUMER_SECRET || ''
    headers.Authorization = `Basic ${Buffer.from(`${wcKey}:${wcSecret}`).toString('base64')}`
  } else {
    headers['X-Headless-Secret'] = INTERNAL_SECRET
  }

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
    await scheduleBackground(logAdminAction(request, user, opts, { status: 'error', detail: e?.message }))
    return { ok: false, status: 502, error: 'Impossible de joindre le serveur WordPress' }
  }

  if (!res.ok) {
    const wpBody = await res.text().catch(() => '')
    await scheduleBackground(logAdminAction(request, user, opts, { status: 'error', wpStatus: res.status, detail: wpBody }))
    // Status 200 délibéré : certains niveaux d'infra (CDN/edge) remplacent le
    // corps des réponses 5xx par leur propre page générique, ce qui masquait
    // le vrai diagnostic côté client (voir /api/analytics/summary, pattern
    // déjà en place avant ce fichier). L'erreur reste dans le champ `error`.
    return { ok: false, status: 200, error: 'Erreur serveur WordPress', wpStatus: res.status, wpBody: wpBody.slice(0, 500) }
  }

  const data = await res.json().catch(() => null)
  await scheduleBackground(logAdminAction(request, user, opts, { status: 'success', wpStatus: res.status }))
  return { ok: true, status: 200, data: data as T }
}

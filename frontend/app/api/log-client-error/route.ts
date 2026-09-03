import { NextResponse } from 'next/server'
import { ADMIN_SVC_URL } from '@/lib/miad-server-auth'
import { requireEnv } from '@/lib/require-env'

export const runtime = 'edge';

const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

// POST /api/log-client-error — relais vers admin-svc POST
// /admin/api/log-client-error (secret interne, jamais exposé au
// navigateur). Suivi d'erreurs frontend maison (2026-09-03), voir
// app/global-error.tsx pour l'appelant et le contexte (remplace Sentry,
// incompatible avec le pipeline @cloudflare/next-on-pages de ce projet).
// Best-effort côté appelant aussi : ne renvoie jamais une erreur qui
// ferait planter la page qui rapporte déjà un crash — toujours 202.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    if (!body?.message) {
      return NextResponse.json({ ok: false }, { status: 202 })
    }
    await fetch(`${ADMIN_SVC_URL}/admin/api/log-client-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
      body: JSON.stringify({
        message: String(body.message).slice(0, 2000),
        stack: String(body.stack || '').slice(0, 8000),
        digest: String(body.digest || ''),
        url: String(body.url || ''),
        user_agent: request.headers.get('user-agent') || '',
        user_id: String(body.user_id || ''),
        // 'js_error' (défaut, crashs React via global-error.tsx) ou
        // 'image_error' (échec définitif de chargement, voir LazyImage.tsx).
        type: body.type === 'image_error' ? 'image_error' : 'js_error',
      }),
    })
  } catch {
    // Best-effort : jamais bloquant, voir commentaire ci-dessus.
  }
  return NextResponse.json({ ok: true }, { status: 202 })
}

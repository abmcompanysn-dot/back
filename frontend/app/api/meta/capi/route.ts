import { NextResponse } from 'next/server'
import { ADMIN_SVC_URL } from '@/lib/miad-server-auth'
import { requireEnv } from '@/lib/require-env'

export const runtime = 'edge'

const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

// Conversions API Meta — relais. Le navigateur POST ici (marketing-events
// .ts sendCapi), on transmet à admin-svc /admin/api/meta/capi qui ajoute
// le token CAPI stocké (jamais exposé) et forwarde à graph.facebook.com.
//
// On enrichit user_data avec l'IP réelle (Meta la demande pour le
// matching) — indisponible côté navigateur, ajoutée ici.
export async function POST(request: Request) {
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'json invalide' }, { status: 400 })
  }

  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    ''
  if (ip && Array.isArray(body?.data)) {
    for (const ev of body.data) {
      ev.user_data = { ...(ev.user_data || {}), client_ip_address: ip }
    }
  }

  try {
    const res = await fetch(`${ADMIN_SVC_URL}/admin/api/meta/capi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    return new NextResponse(text, {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch {
    // CAPI est du "best effort" : un échec ici ne doit rien casser côté client.
    return NextResponse.json({ ok: false }, { status: 200 })
  }
}

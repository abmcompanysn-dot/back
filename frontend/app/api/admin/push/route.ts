import { NextRequest, NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

// GET /api/admin/push — nombre d'appareils abonnés aux notifications push
export async function GET(request: NextRequest) {
  const result = await callHeadlessAdmin(request, {
    role: 'admin',
    action: 'admin.push.stats',
    path: '/wp-json/miad/v1/push/stats',
  })
  if (!result.ok) return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  return NextResponse.json(result.data)
}

// POST /api/admin/push — diffuse une notification push à tous les appareils abonnés
export async function POST(request: NextRequest) {
  const body = await request.json()
  const { title, text, url } = body

  if (!title?.trim() || !text?.trim()) {
    return NextResponse.json({ error: 'Titre et message requis' }, { status: 400 })
  }

  // Pas de token/user_id transmis à WordPress : /push/send envoie alors à
  // tous les appareils enregistrés (miad_send_push_to_all), voir miad-push.php.
  const result = await callHeadlessAdmin(request, {
    role: 'admin',
    action: 'admin.push.broadcast',
    method: 'POST',
    path: '/wp-json/miad/v1/push/send',
    body: { title, body: text, url: url?.trim() || undefined },
  })
  if (!result.ok) return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  return NextResponse.json(result.data)
}

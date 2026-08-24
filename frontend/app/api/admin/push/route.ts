import { NextRequest, NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge'

// GET /api/admin/push — nombre d'appareils abonnés aux notifications push
export async function GET(request: NextRequest) {
  const result = await callHeadlessAdmin(request, {
    role: 'admin',
    action: 'admin.push.stats',
    path: '/admin/api/push/stats',
  })
  if (!result.ok) return NextResponse.json({ error: result.error, upstreamStatus: result.upstreamStatus, upstreamBody: result.upstreamBody }, { status: result.status })
  return NextResponse.json(result.data)
}

// POST /api/admin/push — diffuse une notification push à tous les appareils abonnés
export async function POST(request: NextRequest) {
  const body = await request.json()
  const { title, text } = body

  if (!title?.trim() || !text?.trim()) {
    return NextResponse.json({ error: 'Titre et message requis' }, { status: 400 })
  }

  const result = await callHeadlessAdmin(request, {
    role: 'admin',
    action: 'admin.push.broadcast',
    method: 'POST',
    path: '/admin/api/push/broadcast',
    body: { title, message: text },
  })
  if (!result.ok) return NextResponse.json({ error: result.error, upstreamStatus: result.upstreamStatus, upstreamBody: result.upstreamBody }, { status: result.status })
  return NextResponse.json(result.data)
}

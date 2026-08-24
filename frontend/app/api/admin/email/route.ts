import { NextRequest, NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

// GET /api/admin/email — subscriber stats
export async function GET(request: NextRequest) {
  const result = await callHeadlessAdmin(request, {
    role: 'admin',
    action: 'admin.email.subscribers',
    path: '/wp-json/miad/v1/email/subscribers',
  })
  if (!result.ok) return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  return NextResponse.json(result.data)
}

// POST /api/admin/email — send email or broadcast
export async function POST(request: NextRequest) {
  const body = await request.json()
  const { mode, to, subject, content, audience, includeRecommendations, template } = body
  const safeTemplate = template === 'list' ? 'list' : 'grid'

  if (!subject?.trim() || !content?.trim()) {
    return NextResponse.json({ error: 'Sujet et contenu requis' }, { status: 400 })
  }

  if (mode === 'single') {
    if (!to?.trim()) return NextResponse.json({ error: 'Destinataire requis' }, { status: 400 })
    const result = await callHeadlessAdmin(request, {
      role: 'admin',
      action: 'admin.email.send',
      method: 'POST',
      path: '/wp-json/miad/v1/email/send',
      body: { to, subject, body: content, includeRecommendations: !!includeRecommendations, template: safeTemplate },
    })
    if (!result.ok) return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
    return NextResponse.json(result.data)
  }

  const result = await callHeadlessAdmin(request, {
    role: 'admin',
    action: 'admin.email.broadcast',
    method: 'POST',
    path: '/wp-json/miad/v1/email/broadcast',
    body: { subject, body: content, audience: audience || 'subscribers', includeRecommendations: !!includeRecommendations, template: safeTemplate },
  })
  if (!result.ok) return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  return NextResponse.json(result.data)
}

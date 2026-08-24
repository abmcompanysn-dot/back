import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params

  const result = await callHeadlessAdmin(req, {
    role: 'admin',
    action: 'analytics.session',
    path: `/wp-json/miad-analytics/v1/session/${encodeURIComponent(sessionId)}`,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  }
  return NextResponse.json(result.data)
}

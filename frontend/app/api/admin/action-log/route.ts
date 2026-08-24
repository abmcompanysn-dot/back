import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge'

// GET /api/admin/action-log — journal des actions admin/représentant
// (qui a fait quoi, quand, depuis où). Alimenté par callHeadlessAdmin()
// à chaque appel admin proxifié vers admin-svc.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)

  const result = await callHeadlessAdmin(req, {
    role: 'admin',
    action: 'admin.action-log.list',
    path: '/admin/api/action-log',
    query: {
      page: searchParams.get('page') || undefined,
      page_size: searchParams.get('per_page') || undefined,
      status: searchParams.get('status') || undefined,
      action: searchParams.get('filterAction') || undefined,
    },
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error, upstreamStatus: result.upstreamStatus, upstreamBody: result.upstreamBody }, { status: result.status })
  }
  return NextResponse.json(result.data)
}

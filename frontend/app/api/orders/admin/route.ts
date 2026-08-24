import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const perPage = searchParams.get('per_page') || '50'
  const page = searchParams.get('page') || '1'
  const status = searchParams.get('status') || 'any'

  const result = await callHeadlessAdmin<any[]>(request, {
    role: 'admin',
    action: 'orders.admin.list',
    path: '/admin/api/orders',
    query: { page_size: perPage, page, status: status === 'any' ? undefined : status },
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error, upstreamStatus: result.upstreamStatus, upstreamBody: result.upstreamBody }, { status: result.status })
  }

  const items = (result.data as any)?.items
  return NextResponse.json({ orders: Array.isArray(items) ? items : [] })
}

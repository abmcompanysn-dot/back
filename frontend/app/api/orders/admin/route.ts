import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const perPage = searchParams.get('per_page') || '50'
  const page = searchParams.get('page') || '1'
  const status = searchParams.get('status') || 'any'

  const result = await callHeadlessAdmin<any[]>(request, {
    role: 'admin',
    action: 'orders.admin.list',
    path: '/wp-json/wc/v3/orders',
    auth: 'wc-basic',
    query: { per_page: perPage, page, status },
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  }

  return NextResponse.json({ orders: Array.isArray(result.data) ? result.data : [] })
}

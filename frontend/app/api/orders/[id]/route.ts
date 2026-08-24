import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'orders.get',
    path: `/admin/api/orders/parent/${id}`,
  })

  if (!result.ok) return NextResponse.json({ error: result.error, upstreamStatus: result.upstreamStatus, upstreamBody: result.upstreamBody }, { status: result.status })
  return NextResponse.json({ order: result.data })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const [{ id }, body] = await Promise.all([params, request.json().catch(() => ({}))])

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'orders.update',
    method: 'PUT',
    path: `/admin/api/orders/${id}/status`,
    body: { status: body.status },
  })

  if (!result.ok) return NextResponse.json({ error: result.error, upstreamStatus: result.upstreamStatus, upstreamBody: result.upstreamBody }, { status: result.status })
  return NextResponse.json({ order: result.data })
}

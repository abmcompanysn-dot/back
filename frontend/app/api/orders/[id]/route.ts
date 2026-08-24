import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'orders.get',
    path: `/wp-json/wc/v3/orders/${id}`,
    auth: 'wc-basic',
  })

  if (!result.ok) return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  return NextResponse.json({ order: result.data })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const [{ id }, body] = await Promise.all([params, request.json().catch(() => ({}))])

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'orders.update',
    method: 'PUT',
    path: `/wp-json/wc/v3/orders/${id}`,
    auth: 'wc-basic',
    body,
  })

  if (!result.ok) return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  return NextResponse.json({ order: result.data })
}

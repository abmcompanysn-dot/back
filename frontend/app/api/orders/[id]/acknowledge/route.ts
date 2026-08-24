import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'orders.acknowledge',
    method: 'POST',
    path: `/admin/api/representative/orders/${id}/acknowledge`,
    body: (user: any) => ({ rep_name: user.email || 'Représentant' }),
  })

  if (!result.ok) return NextResponse.json({ error: result.error, upstreamStatus: result.upstreamStatus, upstreamBody: result.upstreamBody }, { status: result.status })
  return NextResponse.json(result.data)
}

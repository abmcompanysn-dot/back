import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'orders.acknowledge',
    method: 'POST',
    path: `/wp-json/miad/v1/orders/${id}/acknowledge`,
    body: (user: any) => ({ rep_name: user.display_name || user.name || 'Représentant' }),
  })

  if (!result.ok) return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  return NextResponse.json(result.data)
}

import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge'

// POST /api/messages/[id] — add a reply to a message
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const [{ id }, body] = await Promise.all([params, request.json()])
  const { text, from_name, from_role } = body

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'messages.reply',
    method: 'POST',
    path: `/admin/api/representative/messages/${id}/reply`,
    body: { text, from_name, from_role },
  })

  if (!result.ok) return NextResponse.json({ error: result.error, upstreamStatus: result.upstreamStatus, upstreamBody: result.upstreamBody }, { status: result.status })
  return NextResponse.json(result.data)
}

// PATCH /api/messages/[id] — update message status
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const [{ id }, body] = await Promise.all([params, request.json()])

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'messages.update-status',
    method: 'PATCH',
    path: `/admin/api/representative/messages/${id}`,
    body,
  })

  if (!result.ok) return NextResponse.json({ error: result.error, upstreamStatus: result.upstreamStatus, upstreamBody: result.upstreamBody }, { status: result.status })
  return NextResponse.json(result.data)
}

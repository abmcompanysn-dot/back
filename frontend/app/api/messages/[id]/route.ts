import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

// POST /api/messages/[id] — add a reply to a message
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const [{ id }, body] = await Promise.all([params, request.json()])
  const { text, from_name, from_role } = body

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'messages.reply',
    method: 'POST',
    path: `/wp-json/miad/v1/messages/${id}/reply`,
    body: { text, from_name, from_role },
  })

  if (!result.ok) return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  // WordPress's miad_rest_reply_message already sends the client email via wp_mail()
  return NextResponse.json(result.data)
}

// PATCH /api/messages/[id] — update message status
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const [{ id }, body] = await Promise.all([params, request.json()])

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'messages.update-status',
    method: 'PATCH',
    path: `/wp-json/miad/v1/messages/${id}`,
    body,
  })

  if (!result.ok) return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  return NextResponse.json(result.data)
}

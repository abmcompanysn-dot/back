import { NextResponse } from 'next/server'
import { WOO_URL, INTERNAL_SECRET, isAdmin } from '@/lib/miad-server-auth'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.miadmarket.com').replace(/\/$/, '')

// GET /api/messages — inbox for admin or representative
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'messages.list',
    path: '/wp-json/miad/v1/messages',
    // Reps only see their own messages — admins can filter by any rep_id.
    query: (user) => {
      const base: Record<string, string | undefined> = { per_page: '100' }
      const status = searchParams.get('status')
      if (status) base.status = status
      if (isAdmin(user)) {
        const repId = searchParams.get('rep_id')
        if (repId) base.rep_id = repId
      } else {
        base.rep_id = String(user.id)
      }
      return base
    },
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  }
  return NextResponse.json(result.data)
}

// POST /api/messages — submit contact message (public, no auth required)
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { client_name, client_email, message, rep_id, rep_name, country } = body

    if (!client_name?.trim() || !message?.trim()) {
      return NextResponse.json({ error: 'Données manquantes' }, { status: 400 })
    }

    // Persist message in WordPress
    const storeRes = await fetch(`${WOO_URL}/wp-json/miad/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Headless-Secret': INTERNAL_SECRET,
        'User-Agent': 'MIAD-Headless-Client',
      },
      body: JSON.stringify({ client_name, client_email, message, rep_id, rep_name, country }),
    })

    const stored = await storeRes.json().catch(() => ({ ok: false }))

    // Fetch rep email and send notification (fire-and-forget)
    if (rep_id) {
      fetch(`${WOO_URL}/wp-json/miad/v1/representant/${rep_id}`, {
        headers: { 'X-Headless-Secret': INTERNAL_SECRET, 'User-Agent': 'MIAD-Headless-Client' },
        cache: 'no-store',
      })
        .then(r => r.ok ? r.json() : null)
        .then(repData => {
          const toEmail = repData?.email
          if (!toEmail) return

          const dashLink = `${SITE_URL}/espace-representant`
          const emailHtml = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#111">
  <div style="background:#1a1a1a;padding:24px 32px;border-radius:12px 12px 0 0">
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:900">MIAD Market</h1>
    <p style="color:rgba(255,255,255,.6);margin:4px 0 0;font-size:13px">Nouveau message client</p>
  </div>
  <div style="background:#f9fafb;padding:32px;border:1px solid #e5e7eb;border-top:none">
    <p style="margin:0 0 16px;font-size:15px">Bonjour <strong>${rep_name || 'Représentant'}</strong>,</p>
    <p style="margin:0 0 20px;font-size:14px;color:#374151">
      <strong>${client_name}</strong>${client_email ? ` (${client_email})` : ''} vous a envoyé un message&nbsp;:
    </p>
    <div style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid #1a1a1a;border-radius:8px;padding:16px 20px;margin-bottom:28px">
      <p style="margin:0;font-size:14px;color:#1f2937;line-height:1.6">"${message}"</p>
    </div>
    <a href="${dashLink}" style="display:inline-block;background:#1a1a1a;color:#fff;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px">
      Répondre maintenant →
    </a>
  </div>
  <div style="background:#f3f4f6;padding:16px 32px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none">
    <p style="margin:0;font-size:11px;color:#9ca3af">MIAD Market · Made in Africa, Shared with the World</p>
  </div>
</div>`

          fetch(`${WOO_URL}/wp-json/miad/v1/send-email`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Headless-Secret': INTERNAL_SECRET,
              'User-Agent': 'MIAD-Headless-Client',
            },
            body: JSON.stringify({
              to: toEmail,
              subject: `💬 Nouveau message de ${client_name} — MIAD Market`,
              html: emailHtml,
            }),
          }).catch(() => {})
        })
        .catch(() => {})
    }

    return NextResponse.json({ ok: true, id: stored.id })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

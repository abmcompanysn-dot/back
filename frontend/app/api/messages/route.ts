import { NextResponse } from 'next/server'
import { isAdmin, LOYALTY_SVC_URL, EMAIL_SVC_URL } from '@/lib/miad-server-auth'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge'

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://miadmarket.ca').replace(/\/$/, '')

// GET /api/messages — inbox for admin or representative
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)

  const result = await callHeadlessAdmin(request, {
    role: 'admin-or-rep',
    action: 'messages.list',
    path: '/admin/api/representative/messages',
    query: (user) => {
      const base: Record<string, string | undefined> = {}
      const status = searchParams.get('status')
      if (status) base.status = status
      if (isAdmin(user)) {
        const repId = searchParams.get('rep_id')
        if (repId) base.representative_id = repId
      } else {
        base.representative_id = String(user.representative_id ?? '')
      }
      return base
    },
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error, upstreamStatus: result.upstreamStatus, upstreamBody: result.upstreamBody }, { status: result.status })
  }
  return NextResponse.json(result.data)
}

// POST /api/messages — submit contact message (public, no auth required)
//
// La table loyalty-svc (rep_messages) exige un customer_id connu — un
// visiteur non authentifié qui utilise le formulaire de contact n'en a
// pas forcément un. Dans ce cas, le message n'est PAS persisté dans
// loyalty-svc (rien à afficher dans l'inbox du représentant), mais la
// notification email part quand même : mieux qu'un échec silencieux total.
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { client_name, client_email, message, rep_id, rep_name, customer_id, country } = body

    if (!client_name?.trim() || !message?.trim()) {
      return NextResponse.json({ error: 'Données manquantes' }, { status: 400 })
    }

    let messageId: number | undefined
    if (rep_id && customer_id) {
      const storeRes = await fetch(`${LOYALTY_SVC_URL}/representative/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          representative_id: Number(rep_id),
          customer_id: Number(customer_id),
          subject: country ? `Message depuis ${country}` : '',
          body: message,
        }),
      })
      if (storeRes.ok) {
        const stored = await storeRes.json().catch(() => ({}))
        messageId = stored.id
      }
    }

    // Notification email au représentant (tâche de fond, ne bloque jamais
    // la réponse au client) — remplace l'ancien envoi direct vers
    // wp-json/miad/v1/send-email.
    if (rep_id) {
      fetch(`${LOYALTY_SVC_URL}/representative/${rep_id}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((repData) => {
          const toEmail = repData?.email
          if (!toEmail) return
          return fetch(`${EMAIL_SVC_URL}/emails/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: toEmail,
              template: 'rep_message_notification',
              subject: `💬 Nouveau message de ${client_name} — MIAD Market`,
              payload: {
                rep_name: rep_name || 'Représentant',
                client_name,
                client_email: client_email || '',
                message,
                dashboard_url: `${SITE_URL}/espace-representant`,
              },
            }),
          })
        })
        .catch(() => {})
    }

    return NextResponse.json({ ok: true, id: messageId })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { LOYALTY_SVC_URL, EMAIL_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.miadmarket.com').replace(/\/$/, '')

/**
 * Notifie un représentant qu'un client lui a écrit. email-svc a un modèle
 * dédié déjà seedé pour ce cas précis — "rep_message_notification" (voir
 * repMessageNotificationHTML dans services/email-svc/main.go), rendu
 * côté serveur avec {{.rep_name}}, {{.client_name}}, {{.client_email}},
 * {{.message}}, {{.dashboard_url}} — donc plus besoin de construire le HTML
 * ici comme sous l'ancien wp-json/miad/v1/send-email.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { repId, repName, repEmail, clientName, clientEmail, message, convId } = body

    if (!clientName || !message) {
      return NextResponse.json({ error: 'Données manquantes' }, { status: 400 })
    }

    // If no repEmail provided, try to get it from loyalty-svc by repId
    let toEmail = repEmail
    if (!toEmail && repId) {
      try {
        const repRes = await fetch(`${LOYALTY_SVC_URL}/representative/${repId}`, { cache: 'no-store' })
        if (repRes.ok) {
          const repData = await repRes.json()
          toEmail = repData.email
        }
      } catch {}
    }

    if (!toEmail) {
      return NextResponse.json({ ok: false, reason: 'no_email' })
    }

    const res = await fetch(`${EMAIL_SVC_URL}/emails/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: toEmail,
        subject: `💬 Nouveau message de ${clientName} — MIAD Market`,
        template: 'rep_message_notification',
        payload: {
          rep_name: repName || 'Représentant',
          client_name: clientName,
          client_email: clientEmail || '',
          message,
          dashboard_url: `${SITE_URL}/espace-representant`,
          conv_id: convId ?? null,
        },
      }),
    })

    if (!res.ok) {
      console.warn('[chat/notify] email-svc failed:', res.status)
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[chat/notify] Error:', e)
    return NextResponse.json({ ok: false })
  }
}

import { NextResponse } from 'next/server'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')
import { requireEnv } from '@/lib/require-env'
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.miadmarket.com').replace(/\/$/, '')

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { repId, repName, repEmail, clientName, clientEmail, message, convId } = body

    if (!clientName || !message) {
      return NextResponse.json({ error: 'Données manquantes' }, { status: 400 })
    }

    // If no repEmail provided, try to get it from WordPress by repId
    let toEmail = repEmail
    if (!toEmail && repId) {
      try {
        const repRes = await fetch(`${WOO_URL}/wp-json/miad/v1/representant/${repId}`, {
          headers: { 'X-Headless-Secret': INTERNAL_SECRET, 'User-Agent': 'MIAD-Headless-Client' },
          cache: 'no-store',
        })
        if (repRes.ok) {
          const repData = await repRes.json()
          toEmail = repData.email || repData.user_email
        }
      } catch {}
    }

    if (!toEmail) {
      return NextResponse.json({ ok: false, reason: 'no_email' })
    }

    const dashLink = `${SITE_URL}/espace-representant`

    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; color: #111;">
        <div style="background: #1a1a1a; padding: 24px 32px; border-radius: 12px 12px 0 0;">
          <h1 style="color: #fff; margin: 0; font-size: 20px; font-weight: 900; letter-spacing: -0.5px;">MIAD Market</h1>
          <p style="color: rgba(255,255,255,0.6); margin: 4px 0 0; font-size: 13px;">Nouveau message client</p>
        </div>
        <div style="background: #f9fafb; padding: 32px; border: 1px solid #e5e7eb; border-top: none;">
          <p style="margin: 0 0 16px; font-size: 15px;">Bonjour <strong>${repName || 'Représentant'}</strong>,</p>
          <p style="margin: 0 0 20px; font-size: 14px; color: #374151;">
            <strong>${clientName}</strong>${clientEmail ? ` (${clientEmail})` : ''} vous a envoyé un message :
          </p>
          <div style="background: #fff; border: 1px solid #e5e7eb; border-left: 4px solid #1a1a1a; border-radius: 8px; padding: 16px 20px; margin-bottom: 28px;">
            <p style="margin: 0; font-size: 14px; color: #1f2937; line-height: 1.6;">"${message}"</p>
          </div>
          <a href="${dashLink}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 13px 28px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 14px; letter-spacing: 0.2px;">
            Répondre maintenant →
          </a>
        </div>
        <div style="background: #f3f4f6; padding: 16px 32px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
          <p style="margin: 0; font-size: 11px; color: #9ca3af;">MIAD Market · Made in Africa, Shared with the World · <a href="${dashLink}" style="color: #6b7280;">${dashLink}</a></p>
        </div>
      </div>
    `

    // Send via WordPress wp_mail wrapper
    const res = await fetch(`${WOO_URL}/wp-json/miad/v1/send-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Headless-Secret': INTERNAL_SECRET,
        'User-Agent': 'MIAD-Headless-Client',
      },
      body: JSON.stringify({
        to: toEmail,
        subject: `💬 Nouveau message de ${clientName} — MIAD Market`,
        html: emailHtml,
      }),
    })

    if (!res.ok) {
      console.warn('[chat/notify] WordPress email endpoint failed:', res.status)
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[chat/notify] Error:', e)
    return NextResponse.json({ ok: false })
  }
}

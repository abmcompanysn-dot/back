import { NextResponse } from 'next/server'
import { getGoogleAccessToken } from '@/lib/firebase-custom-token'

export const runtime = 'edge';

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || ''
const SITE_URL = 'https://miadmarket.ca'
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const CONCURRENCY = 20

async function sendOne(projectId: string, accessToken: string, token: string, title: string, text: string, url: string): Promise<boolean> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body: text },
        webpush: {
          notification: {
            icon: `${SITE_URL}/logo/logo.png`,
            requireInteraction: false,
            vibrate: [200, 100, 200],
          },
          fcm_options: { link: url },
        },
        data: { url },
      },
    }),
  })
  return res.ok
}

export async function POST(request: Request) {
  const secret = request.headers.get('X-Internal-Secret') || request.headers.get('x-push-secret')
  if (!secret || secret !== INTERNAL_SECRET) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'JSON invalide' }, { status: 400 })

  const tokens: string[] = Array.isArray(body.tokens) ? body.tokens : []
  const title = String(body.title || 'MIAD Market')
  const text  = String(body.body  || '')
  const url   = String(body.url   || SITE_URL)

  if (tokens.length === 0) return NextResponse.json({ ok: true, sent: 0 })

  const saKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
  if (!saKey) {
    return NextResponse.json({ ok: false, error: 'FIREBASE_SERVICE_ACCOUNT_KEY manquant' }, { status: 500 })
  }

  try {
    const { project_id: projectId } = JSON.parse(saKey) as { project_id: string }
    const accessToken = await getGoogleAccessToken(FCM_SCOPE)

    let sent = 0
    for (let i = 0; i < tokens.length; i += CONCURRENCY) {
      const chunk = tokens.slice(i, i + CONCURRENCY)
      const results = await Promise.all(
        chunk.map((token) => sendOne(projectId, accessToken, token, title, text, url).catch(() => false))
      )
      sent += results.filter(Boolean).length
    }

    return NextResponse.json({ ok: true, sent })
  } catch (err) {
    console.error('[Push/Send] FCM HTTP v1 error:', err)
    return NextResponse.json({ ok: false, sent: 0, error: String(err) }, { status: 500 })
  }
}

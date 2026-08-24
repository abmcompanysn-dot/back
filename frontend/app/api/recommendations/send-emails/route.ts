import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

// Envoie un email de recommandations personnalisées à chaque client ayant
// déjà commandé (contenu différent par client — jamais un blast identique).
// Action admin sensible (envoie de vrais emails).
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url)
  const template = searchParams.get('template') === 'list' ? 'list' : 'grid'

  const result = await callHeadlessAdmin(req, {
    role: 'admin',
    action: 'recommendations.send-emails',
    method: 'POST',
    path: '/wp-json/miad-analytics/v1/recommendations/send-emails',
    query: { template },
    body: {},
  })

  if (!result.ok) return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  return NextResponse.json(result.data)
}

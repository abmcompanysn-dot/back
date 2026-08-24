import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

// Aperçu avant envoi réel des emails de recommandation : qui recevrait
// quoi, sans jamais envoyer un vrai email — pour valider avant de cliquer
// le bouton d'envoi définitif.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const template = searchParams.get('template') === 'list' ? 'list' : 'grid'

  const result = await callHeadlessAdmin(req, {
    role: 'admin',
    action: 'recommendations.send-emails.preview',
    path: '/wp-json/miad-analytics/v1/recommendations/send-emails/preview',
    query: { template },
  })

  if (!result.ok) return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  return NextResponse.json(result.data)
}

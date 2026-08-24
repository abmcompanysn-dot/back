import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

// Statut du moteur de recommandations (dernier recalcul, nombre de paires).
export async function GET(req: Request) {
  const result = await callHeadlessAdmin(req, {
    role: 'admin',
    action: 'recommendations.status',
    path: '/wp-json/miad-analytics/v1/recommendations/status',
  })

  if (!result.ok) return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  return NextResponse.json(result.data)
}

// Force un recalcul immédiat (au lieu d'attendre le cron quotidien).
export async function POST(req: Request) {
  const result = await callHeadlessAdmin(req, {
    role: 'admin',
    action: 'recommendations.recompute',
    method: 'POST',
    path: '/wp-json/miad-analytics/v1/recommendations/recompute',
    body: {},
  })

  if (!result.ok) return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  return NextResponse.json(result.data)
}

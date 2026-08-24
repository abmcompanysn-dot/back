import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

// Dashboard KPI admin — le rôle WordPress est vérifié côté serveur (jamais un
// flag client, falsifiable) par callHeadlessAdmin() avant de relayer vers
// l'endpoint WordPress protégé par secret.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const days = searchParams.get('days') || '7'

  const result = await callHeadlessAdmin(req, {
    role: 'admin',
    action: 'analytics.summary',
    path: '/wp-json/miad-analytics/v1/summary',
    query: { days },
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  }
  return NextResponse.json(result.data)
}

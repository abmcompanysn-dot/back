import { NextResponse } from 'next/server'
import { callHeadlessAdmin } from '@/lib/miad-admin-api'

export const runtime = 'edge';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const minutesStuck = searchParams.get('minutesStuck') || '30'
  const lookbackDays = searchParams.get('lookbackDays') || '2'

  const result = await callHeadlessAdmin(req, {
    role: 'admin',
    action: 'analytics.stuck-sessions',
    path: '/wp-json/miad-analytics/v1/stuck-sessions',
    query: { minutesStuck, lookbackDays },
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error, wpStatus: result.wpStatus, wpBody: result.wpBody }, { status: result.status })
  }
  return NextResponse.json(result.data)
}

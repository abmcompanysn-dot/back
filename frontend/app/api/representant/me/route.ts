import { NextResponse } from 'next/server'
import { fetchWpUser, fetchRepresentative } from '@/lib/miad-server-auth'

export const runtime = 'edge'

export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Token manquant' }, { status: 401 })
  }
  const token = authHeader.slice(7)

  const userData = await fetchWpUser(token)
  if (!userData) {
    return NextResponse.json({ error: 'Session invalide' }, { status: 401 })
  }

  const rep = await fetchRepresentative(userData)
  if (!rep) {
    return NextResponse.json({ error: 'Accès réservé aux représentants' }, { status: 403 })
  }

  return NextResponse.json({
    success: true,
    id: rep.id,
    name: rep.name,
    email: rep.email,
    country_code: rep.is_super_rep ? 'ALL' : rep.country,
    country_name: rep.is_super_rep ? 'Tous les pays' : rep.country,
    is_super_rep: rep.is_super_rep,
    commission_rate: rep.commission_pct,
  })
}

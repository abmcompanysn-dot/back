import { NextResponse } from 'next/server'
import { fetchWpUser, fetchRepresentative, LOYALTY_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// Dashboard représentant complet (module Parrainage + zone) : by-email
// résout seulement l'identité (id/nom/pays), repDashboard agrège tout le
// reste (vendeurs zone, commandes zone, clients zone, parrainage) —
// RepresentantPage.tsx (670 lignes) attend ce format complet, un simple
// by-email la faisait planter sur des tableaux undefined.
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

  const res = await fetch(`${LOYALTY_SVC_URL}/representative/dashboard/${rep.id}`, { cache: 'no-store' })
  if (!res.ok) {
    return NextResponse.json({ error: 'Dashboard représentant indisponible' }, { status: 502 })
  }
  const dashboard = await res.json()
  return NextResponse.json(dashboard)
}

import { NextResponse } from 'next/server'
import { fetchWpUser, isAdmin } from '@/lib/miad-server-auth'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const MIAD_API = (process.env.MIAD_PRODUCTS_API || 'https://api.miadmarket.com/wp-json/miad-products/v1').replace(/\/$/, '')
const MIAD_SECRET = process.env.MIAD_PRODUCTS_SECRET || ''

// Audit du 2026-08-17 : aucune verification d'auth sur cette route non plus.
export async function GET(req: Request) {
  const auth = req.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  const user = await fetchWpUser(auth.slice(7))
  if (!user || !isAdmin(user)) return NextResponse.json({ error: 'Accès refusé' }, { status: 403 })

  if (!MIAD_SECRET) return NextResponse.json({ error: 'MIAD_PRODUCTS_SECRET manquant sur Cloudflare Pages' }, { status: 500 })

  const { searchParams } = new URL(req.url)
  const trackingNumber = searchParams.get('tracking_number') || ''
  if (!trackingNumber) return NextResponse.json({ error: 'tracking_number requis' }, { status: 400 })

  const res = await fetch(`${MIAD_API}/dhl/tracking?tracking_number=${encodeURIComponent(trackingNumber)}`, {
    headers: { 'X-Miad-Products-Secret': MIAD_SECRET },
    cache: 'no-store',
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: (data as any).error || 'Erreur MIAD API' }, { status: res.status })
  return NextResponse.json(data)
}

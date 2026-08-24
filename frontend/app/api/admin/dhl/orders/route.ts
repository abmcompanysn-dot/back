import { NextResponse } from 'next/server'
import { fetchWpUser, isAdmin } from '@/lib/miad-server-auth'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const MIAD_API = (process.env.MIAD_PRODUCTS_API || 'https://api.miadmarket.com/wp-json/miad-products/v1').replace(/\/$/, '')
const MIAD_SECRET = process.env.MIAD_PRODUCTS_SECRET || ''

// Audit du 2026-08-17 : aucune verification d'auth alors que cette route
// expose la liste complete des commandes (noms, adresses, telephones) avec
// un secret serveur — n'importe quel visiteur pouvait l'appeler directement.
export async function GET(req: Request) {
  const auth = req.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  const user = await fetchWpUser(auth.slice(7))
  if (!user || !isAdmin(user)) return NextResponse.json({ error: 'Accès refusé' }, { status: 403 })

  if (!MIAD_SECRET) return NextResponse.json({ error: 'MIAD_PRODUCTS_SECRET manquant sur Cloudflare Pages' }, { status: 500 })

  const { searchParams } = new URL(req.url)
  const qs = searchParams.toString()

  const res = await fetch(`${MIAD_API}/dhl/orders${qs ? `?${qs}` : ''}`, {
    headers: { 'X-Miad-Products-Secret': MIAD_SECRET },
    cache: 'no-store',
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: (data as any).error || 'Erreur MIAD API' }, { status: res.status })
  return NextResponse.json(data)
}

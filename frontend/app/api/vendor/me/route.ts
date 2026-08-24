import { NextResponse } from 'next/server'
import { fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// Endpoint léger : retourne juste l'id vendeur du client connecté (résolu
// depuis vendor_id dans le JWT — voir A.10 du plan de migration).
export async function GET(request: Request) {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }

  const user = await fetchWpUser(auth.slice(7))
  if (!user?.vendor_id) return NextResponse.json({ error: 'Accès réservé aux vendeurs' }, { status: 403 })

  return NextResponse.json({ userId: user.vendor_id })
}

import { NextResponse } from 'next/server'
import { NOTIFICATION_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

// notification-svc stocke l'abonnement push (POST /push/subscribe) —
// attend { customer_id, fcm_token }, alors que le client envoie
// { token, user_id }. user_id peut être absent (visiteur non connecté) :
// dans ce cas on ne peut pas s'abonner côté serveur (customer_id est
// obligatoire côté Go), donc on répond succès sans appeler le backend.
export async function POST(request: Request) {
  try {
    const { token, user_id } = await request.json()
    if (!token) return NextResponse.json({ error: 'Token manquant' }, { status: 400 })

    if (!user_id) {
      // Pas de compte identifié : rien à persister côté notification-svc.
      return NextResponse.json({ success: true, subscribed: false })
    }

    const res = await fetch(`${NOTIFICATION_SVC_URL}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: Number(user_id), fcm_token: token }),
    })

    if (!res.ok) return NextResponse.json({ success: false }, { status: 200 })
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ success: false }, { status: 500 })
  }
}

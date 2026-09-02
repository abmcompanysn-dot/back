import { NextResponse } from 'next/server'
import { PAYMENT_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// reinit-payment — relais de POST /payments/init (payment-svc), appelé
// SANS mobile_money_provider (juste order_id) pour (re)créer la facture
// de paiement — même appel que POST /api/orders fait normalement à la
// création de commande. Nécessaire après switch-payment-provider
// (2026-09-02) : ce dernier vide provider_ref pour forcer une nouvelle
// facture, mais ne la recrée pas lui-même — sans ce rappel explicite,
// paydunyaSoftpayDepositHandler échouait en 404 "invoice_not_found"
// faute de facture existante (bug repéré via une vraie tentative de
// paiement Wave, commande #421, 2026-09-02).
//
// Sous [id]/ (pas à la racine api/orders/) : un premier essai en route
// statique app/api/orders/reinit-payment/route.ts a donné un 404 en
// production malgré un build local réussi (x-matched-path pointait
// vers /api/orders/[id] au lieu de la nouvelle route, cause exacte non
// confirmée — probablement une limitation du convertisseur
// @cloudflare/next-on-pages face à un nouveau segment statique ajouté
// au même niveau qu'un [id] déjà existant). Ce chemin réutilise le
// même pattern que tous les autres endpoints liés à une commande
// (switch-payment-provider, mobile-money-deposit, etc.), déjà connu
// pour fonctionner.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const auth = request.headers.get('Authorization')
    if (!auth || !auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
    }
    const user = await fetchWpUser(auth.slice(7))
    if (!user?.sub) return NextResponse.json({ error: 'Session invalide' }, { status: 401 })

    const res = await fetch(`${PAYMENT_SVC_URL}/payments/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: Number(params.id) }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return NextResponse.json({ error: data?.error?.message || 'Préparation du paiement impossible' }, { status: res.status })
    }

    return NextResponse.json({ success: true, payment: data?.payment })
  } catch (e: any) {
    console.error('[reinit-payment]', e.message)
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}

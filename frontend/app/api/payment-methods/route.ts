import { NextResponse } from 'next/server';
import { WOO_URL, fetchWpUser, wpHeaders } from '@/lib/miad-server-auth';

export const runtime = 'edge';

// Proxy vers les routes WordPress de cartes Stripe enregistrées. Auth via
// fetchWpUser (couvre les tokens miad_ OTP ET les JWT), même pattern que
// app/api/orders/route.ts — PAS celui de app/api/customer/route.ts, qui
// échoue silencieusement pour les tokens miad_ (voir son propre code).
// Le user.id résolu ici est le SEUL identifiant transmis à WP ; jamais un id
// fourni par le client.

async function resolveUser(request: Request) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const user = await fetchWpUser(token);
  if (!user?.id) return null;
  return { token, id: user.id as number };
}

export async function GET(request: Request) {
  const resolved = await resolveUser(request);
  if (!resolved) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });

  const res = await fetch(
    `${WOO_URL}/wp-json/miad/v1/stripe-payment-methods?user_id=${resolved.id}`,
    { headers: wpHeaders(resolved.token), cache: 'no-store' }
  );
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}

export async function DELETE(request: Request) {
  const resolved = await resolveUser(request);
  if (!resolved) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const paymentMethodId = body?.paymentMethodId;
  if (!paymentMethodId) {
    return NextResponse.json({ error: 'paymentMethodId requis' }, { status: 400 });
  }

  const res = await fetch(`${WOO_URL}/wp-json/miad/v1/stripe-payment-methods/detach`, {
    method: 'POST',
    headers: wpHeaders(resolved.token),
    body: JSON.stringify({ user_id: resolved.id, paymentMethodId }),
  });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}

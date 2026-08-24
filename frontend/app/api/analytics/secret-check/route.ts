import { NextResponse } from 'next/server'
import { requireEnv } from '@/lib/require-env'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '')
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

// Diagnostic temporaire (à retirer une fois le décalage de secret résolu) —
// ne révèle jamais la valeur du secret, seulement sa longueur côté Next.js
// et le résultat de la comparaison côté WordPress.
export async function GET() {
  const res = await fetch(`${WOO_URL}/wp-json/miad-analytics/v1/secret-check`, {
    headers: { 'X-Headless-Secret': INTERNAL_SECRET, 'User-Agent': 'MIAD-Headless-Client' },
    cache: 'no-store',
  })
  const wpData = await res.json().catch(() => null)
  return NextResponse.json({
    nextjs_secret_length: INTERNAL_SECRET.length,
    wp_response: wpData,
  })
}

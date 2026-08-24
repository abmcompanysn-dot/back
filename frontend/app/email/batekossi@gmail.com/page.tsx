import type { Metadata } from 'next'
import { headers } from 'next/headers'
import AdminBatekossiPage from './AdminBatekossiClient'

// Page entierement client ('use client'), donc sans appel a headers() — sans
// ca, Next.js n'applique le nonce CSP a aucun de ses scripts (voir le meme
// correctif sur app/espace-representant/page.tsx), bloquant toute la page.
export const dynamic = 'force-dynamic'
export const runtime = 'edge';

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
}

export default async function Page() {
  await headers()
  return (
    <main>
      <AdminBatekossiPage />
    </main>
  )
}

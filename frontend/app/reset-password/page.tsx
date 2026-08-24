import type { Metadata } from 'next'
import { headers } from 'next/headers'
import ResetPasswordPage from './ResetPasswordClient'

// Page entierement client ('use client'), donc sans appel a headers() — sans
// ca, Next.js n'applique le nonce CSP a aucun de ses scripts, ce qui bloque
// toute la page. Meme correctif que sur app/auth/page.tsx.
export const dynamic = 'force-dynamic'
export const runtime = 'edge';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default async function Page() {
  await headers()
  return (
    <main>
      <ResetPasswordPage />
    </main>
  )
}

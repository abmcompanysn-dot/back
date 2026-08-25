import type { Metadata } from 'next'
import { headers } from 'next/headers'
import AuthPage from './AuthClient'

// Page entierement client ('use client'), donc sans appel a headers() — sans
// ca, Next.js n'applique le nonce CSP a aucun de ses scripts (chunks
// webpack, bootstrap RSC...), ce qui bloque toute la page (liens magiques
// Firebase, reset de mot de passe). Meme correctif que sur
// app/espace-representant/page.tsx.
export const dynamic = 'force-dynamic'
export const runtime = 'edge';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default async function Page() {
  await headers()
  return (
    <main>
      <AuthPage />
    </main>
  )
}

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { RepresentantPage } from '@/components/miad/RepresentantPage'

// force-dynamic seul ne suffisait pas : Next.js n'applique le nonce CSP a ses
// propres scripts (chunks webpack, bootstrap RSC...) que si la page appelle
// reellement headers() au moins une fois pendant le rendu — sans ca, aucun
// <script> de la page ne recoit l'attribut nonce, alors que l'en-tete CSP du
// middleware en exige un different a chaque requete. Tous les scripts
// etaient donc bloques — page bloquee sur "Chargement de votre espace…".
export const dynamic = 'force-dynamic'
export const runtime = 'edge';

export const metadata: Metadata = {
  title: 'Espace Représentant — MIAD Market',
  description: 'Votre tableau de bord représentant MIAD Market.',
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
}

export default async function EspaceRepresentantRoute() {
  await headers() // declenche la propagation du nonce CSP par Next.js, voir commentaire plus haut
  return (
    <main className="min-h-screen bg-background">
      <RepresentantPage />
    </main>
  )
}

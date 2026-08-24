import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { Toaster } from 'sonner'

import BackNavigationGuard from '@/components/miad/BackNavigationGuard'
import PushManager from '@/components/miad/PushManager'
import MagicLinkHandler from '@/components/miad/MagicLinkHandler'
import { MotionConfigProvider } from '@/components/miad/MotionConfigProvider'
import { CurrencyProvider } from '@/contexts/CurrencyContext'
import './globals.css'

const inter = Inter({
  subsets: ["latin"],
  variable: '--font-inter'
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.miadmarket.com'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'MIAD Market — Made in Africa, Shared with the World',
    template: '%s | MIAD Market',
  },
  description: 'La première marketplace panafricaine. Artisanat, mode, alimentation et beauté d\'Afrique. Paiement Wave, Orange Money, carte bancaire. Livraison MIAD Express.',
  keywords: ['marketplace africaine', 'artisanat afrique', 'mode africaine', 'produits africains', 'MIAD Market', 'made in africa', 'Sénégal', 'Côte d\'Ivoire', 'Wave', 'Orange Money'],
  authors: [{ name: 'MIAD Market', url: SITE_URL }],
  creator: 'MIAD Market',
  publisher: 'MIAD Market',
  generator: 'Next.js',
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/logo/logo.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: '/logo/logo.png',
  },
  openGraph: {
    title: 'MIAD Market — Made in Africa, Shared with the World',
    description: 'La première marketplace panafricaine. Artisanat, mode, alimentation, beauté. Vendeurs vérifiés d\'Afrique de l\'Ouest et au-delà. Paiement sécurisé.',
    url: SITE_URL,
    siteName: 'MIAD Market',
    locale: 'fr_FR',
    alternateLocale: 'en_US',
    images: [
      {
        url: '/api/og',
        width: 1200,
        height: 630,
        alt: 'MIAD Market — Made in Africa, Shared with the World',
        type: 'image/png',
      },
    ],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'MIAD Market — Made in Africa, Shared with the World',
    description: 'La première marketplace panafricaine. Artisanat, mode, alimentation, beauté. Paiement Wave, Orange Money.',
    images: ['/api/og'],
    creator: '@miadmarket',
    site: '@miadmarket',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
  // Sans ce lien, aucun critère d'installabilité PWA n'est rempli — le
  // service worker était bien enregistré (MiadMarketClient.tsx) et
  // InstallPrompt.tsx bien monté, mais `beforeinstallprompt` ne se
  // déclenchait jamais faute de manifest lié dans <head> (signalé le
  // 2026-07-30 : "je veux que tu me fasses le PWA très bien").
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'MIAD Market',
  },
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#005826',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="fr">
      <head>
        {/* Préconnexion au CDN images (R2) et aux drapeaux pays — évite que
            la toute première image de chaque origine paie le coût DNS+TLS
            en plus du téléchargement, sur toutes les cartes produit/pays de
            l'accueil (demandé le 2026-07-25 : "je veux que les images
            arrivent plus rapidement"). */}
        <link rel="preconnect" href="https://cdn.miadmarket.com" />
        <link rel="dns-prefetch" href="https://cdn.miadmarket.com" />
        <link rel="preconnect" href="https://flagcdn.com" />
        <link rel="dns-prefetch" href="https://flagcdn.com" />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <MotionConfigProvider>
          <CurrencyProvider>
            <BackNavigationGuard />
            <MagicLinkHandler />
            <PushManager />
            {children}
            {/* InstallPrompt retiré (pas supprimé) le 2026-08-07 pour la stabilité
                du site : blocage Google Play Protect + échecs d'installation sur
                Samsung Internet malgré le correctif du manifest (voir InstallPrompt.tsx
                et public/manifest.json) — à réactiver une fois ces soucis résolus. */}
            <Toaster richColors position="top-center" />
          </CurrencyProvider>
        </MotionConfigProvider>
      </body>
    </html>
  )
}

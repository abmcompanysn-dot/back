import { Suspense } from 'react'
import MiadMarketClient from './MiadMarketClient'
import { CatalogCacheProvider } from '@/components/miad/CatalogCacheProvider'
import { HomeSections } from '@/components/miad/server/HomeSections'
import { fetchInitialCategories } from '@/lib/woo-server'
import { headers } from 'next/headers'

export const runtime = 'edge';

// ISR : revalidate toutes les 60s — les données arrivent du serveur WooCommerce directement
export const revalidate = 60

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://miadmarket.ca'

// Échappe "<" pour empêcher toute évasion de balise (ex: "</script>") quand le
// JSON est injecté brut dans le HTML via dangerouslySetInnerHTML.
function safeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

// Identité de marque pour Google (favorise l'apparition d'un panneau de
// connaissance / sitelinks quand quelqu'un recherche "MIAD Market").
const ORGANIZATION_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'MIAD Market',
  url: SITE_URL,
  logo: `${SITE_URL}/logo/logo.png`,
  sameAs: [
    'https://www.instagram.com/miad_market/',
    'https://www.facebook.com/profile.php?id=61587398935593',
  ],
}

const WEBSITE_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'MIAD Market',
  url: SITE_URL,
}

const SHIPPING_FALLBACK = {
  local: 3, zone_africa: 6,
  zones: {
    AF: { standard: 12, express: 30 }, EU: { standard: 25, express: 45 },
    NA: { standard: 25, express: 50 }, SA: { standard: 25, express: 55 },
    AS: { standard: 25, express: 55 }, OC: { standard: 30, express: 60 },
  },
}

// products/stores volontairement absents de cette attente bloquante : c'était
// la vraie barrière qui empêchait TOUTE section de l'accueil de streamer tant
// que produits+boutiques+catégories+livraison n'avaient pas TOUS répondu.
// MiadMarketClient les récupère déjà lui-même côté client (useSWRInfinite/
// useSWR) ; l'accueil par défaut est désormais peint par HomeSections (voir
// HomeData plus bas), dont chaque section a son propre fetch indépendant.
// needsCategories=false pour les navigations client-side (produit/boutique/
// pays) : MiadMarketClient.tsx récupère déjà les catégories lui-même via
// useSWR('/api/categories...', { fallbackData: initialCategories }) — cette
// requête SWR a son propre cache qui survit déjà à ces navigations (même
// instance de MiadMarketClient, jamais démontée), donc initialCategories
// n'est utile qu'au tout premier rendu serveur. La refetcher à chaque clic
// ajoutait un aller-retour réseau inutile à la lenteur signalée le
// 2026-07-23 sur "Voir tout" — contrairement à shippingRates, qui n'a pas
// d'équivalent client-side et doit donc rester à jour à chaque navigation.
// GAP CONNU (2026-08-25) : shippingResult ci-dessous appelle encore
// l'ancien WordPress mort (NEXT_PUBLIC_WC_URL jamais positionné sur
// Cloudflare Pages) — retombe donc TOUJOURS sur SHIPPING_FALLBACK codé en
// dur, jamais une vraie donnée. Même gap que app/api/shipping-rates/route.ts
// (voir son commentaire) — shipping-svc (Go) a un schéma incompatible,
// décision explicite du fondateur : laisser tel quel pour l'instant.
async function getInitialData(needsCategories: boolean) {
  const WC_BASE = process.env.NEXT_PUBLIC_WC_URL || 'https://api.miadmarket.com'
  const [categoriesResult, shippingResult] = await Promise.allSettled([
    needsCategories ? fetchInitialCategories() : Promise.resolve([]),
    fetch(`${WC_BASE}/wp-json/miad/v1/shipping-rates`, { next: { revalidate: 300 } }).then(r => r.ok ? r.json() : SHIPPING_FALLBACK).catch(() => SHIPPING_FALLBACK),
  ])

  // Détection pays via header Vercel/Cloudflare (côté serveur, pas besoin d'appel API).
  // Remise en place le 2026-07-17 après un aller-retour : la retirer complètement
  // supprimait aussi le pré-remplissage pour les ~98% de visiteurs bien détectés.
  // Le vrai bug était que la détection était appliquée en silence — voir le
  // bandeau CountryDetectionBanner dans MiadMarketClient.tsx, qui rend cette
  // détection visible et corrigeable en un clic au lieu de fausser le prix
  // sans que le client s'en rende compte.
  const headersList = await headers()
  const raw = headersList.get('x-vercel-ip-country') || headersList.get('cf-ipcountry') || ''
  const userCountryCode = raw.toUpperCase()

  return {
    categories: categoriesResult.status === 'fulfilled' ? categoriesResult.value : [],
    shippingRates: shippingResult.status === 'fulfilled' ? shippingResult.value : SHIPPING_FALLBACK,
    userCountryCode,
  }
}

type PageSearchParams = { v?: string; slug?: string; payment_success?: string; order_id?: string; payment_intent?: string; cart?: string; lang?: string }

// Coquille affichée immédiatement (avant même que getInitialData() ait fini) —
// mêmes proportions que le PageSkeleton interne de MiadMarketClient.tsx pour
// éviter tout saut visuel (CLS) à la bascule.
function HomeShell() {
  return (
    <div className="min-h-screen bg-muted/20 py-10 pb-24">
      <div className="container mx-auto px-4">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
          <div className="h-6 w-48 rounded bg-muted animate-pulse" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {[...Array(12)].map((_, i) => (
            <div key={i} className="rounded-xl overflow-hidden border border-border">
              <div className="aspect-square bg-muted animate-pulse" />
              <div className="p-2 space-y-2">
                <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
                <div className="h-3 w-1/2 rounded bg-muted animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Isolé dans son propre composant serveur asynchrone pour pouvoir l'entourer
// d'un <Suspense> : sans ça, Next.js n'envoie pas le moindre octet tant que
// getInitialData() (4 appels API WooCommerce) n'a pas fini — mesuré en
// production à ~3s de TTFB. Avec ce découpage, la coquille (HomeShell) part
// immédiatement pendant que les données produits/catégories/boutiques
// continuent de charger en arrière-plan et s'affichent dès qu'elles arrivent.
async function HomeData({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  const params = await searchParams

  // MiadMarketClient ne rend jamais homeSections en dehors de la vue 'home'
  // (voir le switch sur currentView) — pourtant <HomeSections /> déclenchait
  // quand même, côté serveur, tous ses fetches WooCommerce (FlashSales,
  // Deals, Promo, boutiques sponsorisées, marché par pays, épicerie) même
  // pour une navigation client-side vers /?v=product|vendor|country, qui
  // possède déjà toutes ses données en mémoire côté client. Signalé le
  // 2026-07-23 : "Voir tout" sur une section pays chargeait lentement —
  // cette navigation forçait Next.js à refaire tout ce travail serveur pour
  // rien, avant même d'appliquer le changement de vue purement client. On
  // ne construit donc cet arbre que pour un chargement direct de l'accueil.
  const isHomeNavigation = !params.v
  // undefined si l'URL n'a pas de ?lang= explicite (visite normale — le
  // client doit alors se fier à localStorage, pas retomber sur 'fr' à
  // chaque rendu). N'est défini que quand on arrive via un lien direct
  // (?lang=en partagé) ou via notre propre navigation de bascule de langue
  // (cf. MiadMarketClient.tsx, handleLanguageChange).
  const explicitLang: 'fr' | 'en' | undefined = params.lang === 'en' ? 'en' : params.lang === 'fr' ? 'fr' : undefined
  const lang: 'fr' | 'en' = explicitLang || 'fr'

  // Navigation client-side (produit / boutique / pays) : `handleProductClick`
  // & co. font router.push('/?v=product&slug=X'), ce qui re-exécute ce
  // Server Component (il consomme searchParams). S'il RE-`await`
  // getInitialData() ici, le <Suspense> parent retombe sur <HomeShell/> et
  // TOUTE la page semble se recharger (skeleton plein écran) alors que
  // MiadMarketClient, jamais démonté, a déjà toutes ses données en mémoire
  // (catégories via SWR, produit via son fetch de secours). Signalé le
  // 2026-08-29 : "on clique un produit, la page se recharge en entier".
  // Donc pour une navigation `?v=...` : rendu SYNCHRONE, aucun await, aucun
  // nouveau fetch serveur. getInitialData() n'est fait QUE pour un
  // chargement direct de l'accueil (isHomeNavigation) ou d'un lien profond.
  if (!isHomeNavigation) {
    const headersList = await headers()
    const raw = headersList.get('x-vercel-ip-country') || headersList.get('cf-ipcountry') || ''
    return (
      <MiadMarketClient
        initialProducts={[]}
        initialCategories={[]}
        initialStores={[]}
        initialUserCountryCode={raw.toUpperCase()}
        forcedView={(params.v === 'vendor' ? 'store' : params.v) as any}
        forcedProductSlug={params.v === 'product' ? params.slug : undefined}
        forcedVendorSlug={params.v === 'vendor' ? params.slug : undefined}
        shippingRates={SHIPPING_FALLBACK}
        stripeReturn={params.payment_success === '1' ? { orderId: Number(params.order_id) || 0, paymentIntentId: params.payment_intent } : undefined}
        sharedCartId={params.cart}
        homeSections={undefined}
        initialLang={explicitLang}
      />
    )
  }

  const data = await getInitialData(isHomeNavigation)

  return (
    <MiadMarketClient
      initialProducts={[]}
      initialCategories={data.categories}
      initialStores={[]}
      initialUserCountryCode={data.userCountryCode}
      forcedView={undefined}
      forcedProductSlug={undefined}
      forcedVendorSlug={undefined}
      shippingRates={data.shippingRates}
      stripeReturn={params.payment_success === '1' ? { orderId: Number(params.order_id) || 0, paymentIntentId: params.payment_intent } : undefined}
      sharedCartId={params.cart}
      homeSections={<HomeSections lang={lang} />}
      initialLang={explicitLang}
    />
  )
}

export default function Page({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(ORGANIZATION_JSON_LD) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(WEBSITE_JSON_LD) }} />
      <CatalogCacheProvider>
        <Suspense fallback={<HomeShell />}>
          <HomeData searchParams={searchParams} />
        </Suspense>
      </CatalogCacheProvider>
    </>
  )
}

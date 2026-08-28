import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

function buildCSP(nonce: string): string {
  const dev = process.env.NODE_ENV === 'development'

  const directives = [
    "default-src 'self'",

    // ── Scripts ────────────────────────────────────────────────────────────────
    // Ni 'strict-dynamic' ni nonce ici : sous next-on-pages (build Cloudflare Pages),
    // Next.js ne propage pas le nonce vers ses propres scripts internes (hydratation,
    // RSC), donc tout script-src avec un nonce bloque le framework lui-même en plus
    // de PayDunya/Cloudflare beacon. 'unsafe-inline' + liste de domaines est la
    // seule combinaison fiable sur cet adaptateur (le nonce reste émis pour les
    // navigateurs/outils qui le lisent, mais n'est plus requis).
    `script-src 'self' 'unsafe-inline'` +
      (dev ? " 'unsafe-eval'" : '') +
      " https://js.stripe.com https://m.stripe.com https://m.stripe.network" +
      " https://www.gstatic.com" +
      " https://apis.google.com https://accounts.google.com" +
      " https://app.paydunya.com https://sandbox.paydunya.com" +
      " https://static.cloudflareinsights.com",

    // ── Styles ─────────────────────────────────────────────────────────────────
    "style-src 'self' 'unsafe-inline'",

    // ── Images ─────────────────────────────────────────────────────────────────
    "img-src 'self' data: blob: https:" +
      " https://pub-5830f37957e94da4a6855da37b632a3a.r2.dev" +
      " https://secure.gravatar.com https://flagcdn.com",

    // ── Polices ────────────────────────────────────────────────────────────────
    "font-src 'self' data:",

    // ── Connexions API ─────────────────────────────────────────────────────────
    "connect-src 'self'" +
      " https://api.miadmarket.com https://miadmarket.com https://*.miadmarket.com" +
      " https://api.stripe.com https://q.stripe.com https://m.stripe.network" +
      " https://identitytoolkit.googleapis.com https://securetoken.googleapis.com" +
      " https://fcm.googleapis.com https://firebaseinstallations.googleapis.com" +
      " https://fcmregistrations.googleapis.com https://firebase.googleapis.com" +
      " https://firebasestorage.googleapis.com wss://*.firebaseio.com" +
      " https://authentification-miad.firebaseapp.com" +
      " https://pub-5830f37957e94da4a6855da37b632a3a.r2.dev" +
      " https://flagcdn.com" +
      " https://app.paydunya.com https://sandbox.paydunya.com" +
      " https://js.stripe.com https://m.stripe.network https://m.stripe.com" +
      " https://apis.google.com https://accounts.google.com https://www.googleapis.com" +
      " https://vitals.vercel-insights.com" +
      // Sentry (suivi des erreurs) — l'endpoint d'ingestion du projet. Sans
      // cette entrée, la CSP bloque silencieusement tous les envois et
      // aucune erreur n'arrive dans Sentry.
      " https://*.ingest.us.sentry.io https://*.ingest.sentry.io",

    // ── iFrames ────────────────────────────────────────────────────────────────
    "frame-src https://js.stripe.com https://hooks.stripe.com" +
      " https://authentification-miad.firebaseapp.com" +
      " https://accounts.google.com",

    // ── Service Workers ────────────────────────────────────────────────────────
    "worker-src 'self' blob:",

    // ── Sécurité générale ──────────────────────────────────────────────────────
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://miadmarket.com",
  ]

  return directives.join('; ')
}

const BLOCKED_WP_PATTERNS = [
  /\/wp-admin\/install\.php/i,
  /\/wp-admin\/upgrade\.php/i,
  /\/xmlrpc\.php/i,
  /\.env(\..+)?$/i,
  /\.git\//i,
  /wp-config\.php/i,
]

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  
  // 1. Sécurité Edge : Blocage immédiat des requêtes suspectes vers WordPress
  if (BLOCKED_WP_PATTERNS.some((p) => p.test(pathname))) {
    return new NextResponse(null, { status: 403 })
  }

  // Récupération de la vraie IP transmise par Cloudflare à l'entrée
  const clientIP = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || ''

  // Préparation des headers de requête modifiés
  const requestHeaders = new Headers(request.headers)
  
  // Renvoyer explicitement l'IP vers le serveur backend lors des rewrites / fetches
  if (clientIP) {
    requestHeaders.set('X-Forwarded-For', clientIP)
    requestHeaders.set('X-Real-IP', clientIP)
    requestHeaders.set('True-Client-IP', clientIP)
  }

  // 2. Proxying WooCommerce Legacy Callbacks (wc-api) vers SiteGround avec IP préservée
  if (pathname.includes('wc-api')) {
    return NextResponse.rewrite(
      new URL(pathname + request.nextUrl.search, 'https://api.miadmarket.com'),
      {
        request: {
          headers: requestHeaders,
        },
      }
    )
  }

  // 3. Génération du Nonce compatible Edge (sans dépendance exclusive à Node.js Buffer)
  const rawUuid = crypto.randomUUID()
  const nonce = btoa(rawUuid).replace(/=/g, '') // Base64 standard Edge
  
  // Passer le nonce au layout
  requestHeaders.set('x-nonce', nonce)

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })

  // 4. Application de la politique CSP globale
  const csp = buildCSP(nonce)
  response.headers.set('Content-Security-Policy', csp)

  // 5. Cache Edge Cloudflare — uniquement pages publiques en GET, jamais sur
  // les routes admin/dashboard/API ni sur une requête authentifiée (token
  // Bearer présent). Les routes API en lecture seule gèrent leur propre
  // Cache-Control (voir app/api/products, categories, stores...), donc on
  // ne touche pas à /api/* ici pour ne pas créer de double en-tête.
  const NO_CACHE_PREFIXES = ['/wp-admin', '/wp-json', '/wp-content', '/wp-includes', '/wp-login.php', '/admin-ajax.php', '/api/', '/dashboard', '/merchant-feed', '/sitemap.xml', '/robots.txt']
  const isExcludedFromCache = NO_CACHE_PREFIXES.some((p) => pathname.startsWith(p))
  const isAuthenticatedRequest = Boolean(request.headers.get('authorization'))

  if (request.method === 'GET' && !isExcludedFromCache && !isAuthenticatedRequest) {
    // Le site sert produits/boutiques via /?v=product&slug=X (jamais /product/[slug]
    // ni /vendor/[slug] — voir handleProductClick/handleVendorClick dans
    // MiadMarketClient.tsx), donc c'est le paramètre "v" qu'il faut vérifier ici,
    // pas le pathname. L'ancienne condition sur le pathname ne matchait jamais et
    // faisait retomber toutes les fiches produit/boutique sur le cache long (1h).
    const viewParam = request.nextUrl.searchParams.get('v')
    const isDynamicSSRPage = pathname.startsWith('/product/') || pathname.startsWith('/vendor/') || viewParam === 'product' || viewParam === 'vendor'
    if (isDynamicSSRPage) {
      response.headers.set('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300')
    } else {
      response.headers.set('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400')
      response.headers.set('CDN-Cache-Control', 'max-age=3600')
    }
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|logo/|icons/|manifest\\.json|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)',
  ],
}
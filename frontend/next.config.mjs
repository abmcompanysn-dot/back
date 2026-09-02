/** @type {import('next').NextConfig} */

// Sentry FRONTEND désactivé le 2026-08-29.
//
// @sentry/nextjs (withSentryConfig + instrumentation.ts) est incompatible
// avec @cloudflare/next-on-pages v1.13.16 : l'étape de bundling des edge
// functions échoue avec « ERROR: A duplicated identifier has been detected
// in the same function file, aborting ». `next build` réussit, mais le
// déploiement Cloudflare Pages non — 16+ builds en Failure d'affilée
// depuis le commit d'intégration Sentry (a917ddb), bloquant TOUS les
// autres correctifs.
//
// Le suivi d'erreurs BACKEND Go (via internal/kit) n'est pas concerné et
// reste actif. Pour réactiver Sentry frontend il faudra soit migrer vers
// @opennextjs/cloudflare, soit un workaround next-on-pages validé —
// jusque-là ce fichier NE réimporte PAS @sentry/nextjs et n'enveloppe
// PAS la config.
// import { withSentryConfig } from '@sentry/nextjs';

// CSP est géré dynamiquement par middleware.ts (nonce par requête)
// On garde ici uniquement les autres en-têtes de sécurité
const securityHeaders = [
  { key: 'X-Frame-Options',           value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options',    value: 'nosniff' },
  { key: 'Referrer-Policy',           value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy',        value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
]

const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  async headers() {
    return [
      { source: '/(.*)', headers: securityHeaders },
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,DELETE,PATCH,POST,PUT' },
          { key: 'Access-Control-Allow-Headers', value: 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization' },
        ],
      },
    ]
  },
  async redirects() {
    return [
      // /contact et variantes → Help Center
      { source: '/contact', destination: '/helpcenter', permanent: true },
      { source: '/contact/:path*', destination: '/helpcenter', permanent: true },
      // Locale /fr/* → équivalent sans préfixe
      { source: '/fr', destination: '/', permanent: true },
      { source: '/fr/:path*', destination: '/:path*', permanent: true },
      // Autres locales potentielles indexées par Google
      { source: '/en/:path*', destination: '/:path*', permanent: true },
    ]
  },
  allowedDevOrigins: ['http://localhost:3000', 'http://localhost:3001'],
  async rewrites() {
    return [
      { source: '/wp-admin/:path*', destination: 'https://api.miadmarket.com/wp-admin/:path*' },
      { source: '/wp-json/:path*', destination: 'https://api.miadmarket.com/wp-json/:path*' },
      { source: '/wp-content/:path*', destination: 'https://api.miadmarket.com/wp-content/:path*' },
      { source: '/wp-includes/:path*', destination: 'https://api.miadmarket.com/wp-includes/:path*' },
      { source: '/wp-login.php', destination: 'https://api.miadmarket.com/wp-login.php' },
      { source: '/admin-ajax.php', destination: 'https://api.miadmarket.com/wp-admin/admin-ajax.php' },
      // /(.*)wc-api(.*) géré dans middleware.ts (regex non exprimable proprement ici)
      // Un dossier de route nommé "merchant-feed.xml" ne fonctionne pas sur
      // Cloudflare Pages (next-on-pages traite le "." comme une extension de
      // fichier statique) — la route reelle est /merchant-feed, exposee a
      // Google Merchant Center sous l'URL .xml attendue via cette reecriture.
      { source: '/merchant-feed.xml', destination: '/merchant-feed' },
      // Flux Facebook / Instagram Catalogue — même contrainte "." que
      // ci-dessus, mêmes raisons.
      { source: '/facebook-feed.xml', destination: '/facebook-feed' },
    ]
  },
  images: {
    // Cloudflare Pages ne supporte pas l'API d'optimisation d'image de Next/Vercel —
    // CF_PAGES=1 est défini automatiquement par Cloudflare Pages au build, donc cette
    // ligne ne désactive l'optimisation que là-bas. Reste active sur Vercel.
    unoptimized: process.env.CF_PAGES === '1',
    remotePatterns: [
      // Cloudflare R2 CDN — images vendeurs et produits
      {
        protocol: 'https',
        hostname: 'pub-5830f37957e94da4a6855da37b632a3a.r2.dev',
        pathname: '/**',
      },
      // API WooCommerce / WordPress
      {
        protocol: 'https',
        hostname: 'miadmarket.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.miadmarket.com',
        pathname: '/**',
      },
      // Gravatar (logos vendeurs Dokan)
      {
        protocol: 'https',
        hostname: 'secure.gravatar.com',
        pathname: '/**',
      },
      // Drapeaux pays
      {
        protocol: 'https',
        hostname: 'flagcdn.com',
        pathname: '/**',
      },
      // Fallback : toute autre source HTTPS (produits multi-origines)
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
};

// --- Sentry frontend : DÉSACTIVÉ (voir le bloc en tête de fichier) ---------
// Anciennement : export default withSentryConfig(nextConfig, { … })
export default nextConfig;

// Config Sentry — runtime Node (Server Components, route handlers /api/*,
// server actions). Le DSN est lu depuis l'environnement, jamais codé en dur :
// NEXT_PUBLIC_SENTRY_DSN doit être défini dans les variables Cloudflare Pages.
import * as Sentry from '@sentry/nextjs'

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn,
  // Pas de perf tracing pour l'instant (coût/quota) — uniquement les erreurs.
  tracesSampleRate: 0,
  // Environnement visible dans Sentry (prod vs preview Cloudflare Pages).
  environment: process.env.NEXT_PUBLIC_SENTRY_ENV || process.env.NODE_ENV,
  // N'envoie rien si le DSN n'est pas configuré (build local, oubli d'env).
  enabled: Boolean(dsn),
})

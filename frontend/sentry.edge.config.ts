// Config Sentry — runtime Edge (middleware.ts + routes déclarées edge).
// Cloudflare Pages exécute une bonne partie de Next sur ce runtime.
import * as Sentry from '@sentry/nextjs'

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn,
  tracesSampleRate: 0,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENV || process.env.NODE_ENV,
  enabled: Boolean(dsn),
})

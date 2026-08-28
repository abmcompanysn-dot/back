// Config Sentry — navigateur des visiteurs du site (@sentry/nextjs charge
// ce fichier automatiquement, remplace l'ancien sentry.client.config.ts).
// C'est ce qui capture les erreurs JS que tes utilisateurs voient vraiment.
import * as Sentry from '@sentry/nextjs'

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_SENTRY_ENV || process.env.NODE_ENV,

  // Erreurs uniquement, pas de tracing perf (quota / vie privée).
  tracesSampleRate: 0,

  integrations: [
    // Remonte les console.log / warn / error du navigateur dans Sentry —
    // pratique pour voir le contexte laissé par le code (ex. le
    // "[MIAD] Global error:" de app/global-error.tsx) autour d'un crash.
    Sentry.consoleLoggingIntegration({ levels: ['log', 'warn', 'error'] }),

    // Rejoue les ~10 s précédant un crash (masque le texte et les médias
    // par défaut — aucune donnée sensible visible). 0 % des sessions
    // normales enregistrées, 100 % de celles qui plantent.
    Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
  ],
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,

  // Bruit connu à ne pas remonter (extensions navigateur, réseau coupé…).
  ignoreErrors: [
    'Non-Error promise rejection captured',
    'ResizeObserver loop limit exceeded',
    'ResizeObserver loop completed with undelivered notifications',
    /^Network request failed$/,
    'Failed to fetch',
    'Load failed',
  ],
})

// Requis par @sentry/nextjs pour instrumenter les transitions de route
// de l'App Router (sinon warning au build).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart

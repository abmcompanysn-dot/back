// Point d'entrée d'instrumentation Next.js (App Router).
// Charge la config Sentry côté serveur Node ET côté edge runtime selon
// l'environnement d'exécution. La config client vit dans
// instrumentation-client.ts (chargé automatiquement par @sentry/nextjs).
import * as Sentry from '@sentry/nextjs'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}

// Capture les erreurs des Server Components / route handlers / server actions
// (nouveau hook Next 15 — sans ça, seules les erreurs client remontaient).
export const onRequestError = Sentry.captureRequestError

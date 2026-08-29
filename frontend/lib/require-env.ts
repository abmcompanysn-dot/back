// Lit une variable d'environnement obligatoire et echoue immediatement (au
// lieu de retomber sur une valeur par defaut) si elle n'est pas configuree.
// Retourne explicitement `string` (pas `string | undefined`) pour que les
// fonctions qui l'utilisent plus loin (closures) gardent le bon type sans
// dependre du retrecissement de flux de TypeScript, qui ne traverse pas les
// fermetures.
//
// EXCEPTION build (2026-08-29) : ces constantes sont évaluées au niveau
// module (import de lib/miad-server-auth.ts). Pendant `next build`, Next
// exécute chaque route API pour « collecter les page data » — or les
// DATABASE_URL_*/*_SVC_URL ne sont injectées qu'au runtime edge sur
// Cloudflare Pages, jamais dans l'environnement de build. Un throw ici
// faisait donc échouer TOUT le build (« Failed to collect page data for
// /api/admin/dhl/rate » puis 16 déploiements Cloudflare en Failure
// d'affilée). On renvoie une valeur sentinelle inoffensive pendant la
// phase de build ; le vrai contrôle a lieu au premier appel runtime, où
// process.env est correctement peuplé.
const IS_BUILD_PHASE =
  process.env.NEXT_PHASE === 'phase-production-build' ||
  process.env.NEXT_PHASE === 'phase-development-build'

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    if (IS_BUILD_PHASE) {
      // Placeholder jamais utilisé pour un vrai appel : à l'exécution edge,
      // process.env[name] est défini et cette branche n'est pas prise.
      return `__build_placeholder_${name}__`
    }
    throw new Error(`${name} manquant côté serveur`)
  }
  return value
}

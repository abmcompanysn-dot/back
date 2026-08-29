// Lit une variable d'environnement obligatoire côté serveur.
//
// Historique (2026-08-29) : cette fonction throwait au niveau module dès
// l'import de lib/miad-server-auth.ts. Deux étapes du pipeline Cloudflare
// Pages exécutent ces modules SANS que les *_SVC_URL / DATABASE_URL_* /
// JWT_SECRET soient présents (elles ne sont injectées qu'au runtime edge) :
//   1. `next build` → « Collecting page data » (NEXT_PHASE=phase-production-build)
//   2. `@cloudflare/next-on-pages` → conversion des bundles edge
// Un throw à l'un ou l'autre faisait échouer TOUT le déploiement — 16
// builds Cloudflare en Failure d'affilée, le site figé sur une version
// d'il y a des heures.
//
// On ne throw donc plus JAMAIS au moment de l'import. Si la variable
// manque :
//   - en dev local (npm run dev) → on le signale bruyamment dans la
//     console pour que ça se voie tout de suite ;
//   - partout ailleurs (build, edge) → on renvoie un placeholder inerte.
//     Au runtime edge, process.env[name] est réellement défini et cette
//     branche n'est jamais prise ; si jamais elle l'était, le premier
//     `fetch('__missing_env_.../...')` échouerait avec une erreur explicite
//     visible dans les logs — un « fail fast » suffisant sans casser le
//     build.
const IS_DEV =
  process.env.NODE_ENV === 'development' && process.env.NEXT_PHASE !== 'phase-production-build'

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (value) return value
  if (IS_DEV) {
    // eslint-disable-next-line no-console
    console.error(
      `[require-env] ${name} manquant — les appels serveur qui en dépendent échoueront. ` +
        `Ajoute-le à .env.local.`,
    )
  }
  return `__missing_env_${name}__`
}

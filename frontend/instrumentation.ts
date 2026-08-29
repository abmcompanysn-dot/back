// Sentry frontend DÉSACTIVÉ le 2026-08-29 — incompatibilité
// @sentry/nextjs × @cloudflare/next-on-pages v1.13 (« duplicated
// identifier », build Cloudflare Pages en échec). Voir next.config.mjs.
//
// register() reste exporté (Next l'appelle au démarrage) mais ne fait
// plus rien. Le suivi d'erreurs backend Go (internal/kit) n'est pas
// concerné. Restaurer depuis .sentry-disabled/ le jour où on repasse
// sur @opennextjs/cloudflare ou un next-on-pages compatible.
export async function register() {
  // no-op
}

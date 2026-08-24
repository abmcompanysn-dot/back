// Lit une variable d'environnement obligatoire et echoue immediatement (au
// lieu de retomber sur une valeur par defaut) si elle n'est pas configuree.
// Retourne explicitement `string` (pas `string | undefined`) pour que les
// fonctions qui l'utilisent plus loin (closures) gardent le bon type sans
// dependre du retrecissement de flux de TypeScript, qui ne traverse pas les
// fermetures.
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} manquant côté serveur`)
  return value
}

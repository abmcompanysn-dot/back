/**
 * Estimation "avant adresse connue" pour une livraison Sénégal -> Sénégal,
 * utilisée sur la fiche produit et dans le panier — endroits qui affichent
 * un aperçu du prix de livraison AVANT que le client ait rempli son adresse
 * précise (seul le pays de navigation est connu à ce stade, pas la ville).
 *
 * Miroir volontaire de la tranche "de secours" utilisée côté serveur
 * (woocommerce-snippets/miad-shipping-domestic.php, tranche médiane de la
 * grille par défaut : 100-200 km -> 5000 FCFA) — sans appel réseau ici pour
 * rester synchrone dans des composants qui ne font pas déjà de fetch async.
 * Le vrai calcul par distance ne se fait qu'au checkout, une fois la ville
 * du client connue ; ce nombre n'est qu'un ordre de grandeur cohérent avec
 * ce que le client verra ensuite, pas le montant final facturé.
 *
 * Si la grille tarifaire est modifiée depuis l'admin (DomesticShippingPanel),
 * cette estimation ne se met PAS à jour automatiquement — mettre à jour ici
 * aussi si la tranche médiane change significativement.
 */
export const SENEGAL_DOMESTIC_FALLBACK_FCFA = 5000
export const SENEGAL_DOMESTIC_FCFA_PER_USD = 600
export const SENEGAL_DOMESTIC_FALLBACK_USD =
  Math.round((SENEGAL_DOMESTIC_FALLBACK_FCFA / SENEGAL_DOMESTIC_FCFA_PER_USD) * 100) / 100

/** true seulement quand vendeur ET acheteur sont au Sénégal (le module de livraison nationale ne couvre que ce cas). */
export function isSenegalDomestic(vendorCountryCode: string, buyerCountryCode: string): boolean {
  return (vendorCountryCode || '').toLowerCase() === 'sn' && (buyerCountryCode || '').toLowerCase() === 'sn'
}

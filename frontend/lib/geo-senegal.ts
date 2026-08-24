/**
 * Villes utilisées pour la sélection d'adresse (vendeur + client) côté
 * livraison nationale Sénégal. Miroir de miad_domestic_city_coords() dans
 * woocommerce-snippets/miad-shipping-domestic.php — le calcul de distance
 * réel se fait côté WordPress, cette liste ne sert ici qu'à peupler les
 * champs de sélection de ville dans le formulaire vendeur/checkout.
 */
export const SENEGAL_CITIES = [
  'Dakar', 'Pikine', 'Guédiawaye', 'Rufisque', 'Thiès', 'Mbour', 'Kaolack',
  'Kaffrine', 'Fatick', 'Diourbel', 'Touba', 'Louga', 'Saint-Louis', 'Matam',
  'Tambacounda', 'Kédougou', 'Kolda', 'Sédhiou', 'Ziguinchor',
] as const

export type SenegalCity = (typeof SENEGAL_CITIES)[number]

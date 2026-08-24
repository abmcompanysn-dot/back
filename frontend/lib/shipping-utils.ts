/**
 * MIAD Market - Utilitaires de livraison centralisés
 */
import { Country } from './woocommerce';

// Mapping des pays vers les zones MIAD
export const COUNTRY_TO_ZONE: Record<string, string> = {
  'SN': 'AF', 'BJ': 'AF', 'CI': 'AF', 'TG': 'AF', 'CM': 'AF', 'NG': 'AF', 'GA': 'AF', 'CG': 'AF', 'CD': 'AF', 'ML': 'AF', 'NE': 'AF', 'BF': 'AF', 'GN': 'AF', 'GW': 'AF', 'MR': 'AF', 'GM': 'AF', 'SL': 'AF', 'LR': 'AF', 'CV': 'AF', 'ST': 'AF', 'GQ': 'AF', 'TD': 'AF', 'CF': 'AF', 'DZ': 'AF', 'MA': 'AF', 'TN': 'AF', 'LY': 'AF', 'EG': 'AF', 'SD': 'AF', 'KE': 'AF', 'TZ': 'AF', 'UG': 'AF', 'RW': 'AF', 'BI': 'AF', 'ET': 'AF', 'DJ': 'AF', 'SO': 'AF', 'MG': 'AF', 'SC': 'AF', 'MU': 'AF', 'KM': 'AF', 'ZA': 'AF', 'AO': 'AF', 'MZ': 'AF', 'ZM': 'AF', 'ZW': 'AF', 'NA': 'AF', 'BW': 'AF', 'LS': 'AF', 'SZ': 'AF', 'MW': 'AF', 'SS': 'AF', 'ER': 'AF', 'YT': 'AF', 'RE': 'AF',
  'FR': 'EU', 'BE': 'EU', 'DE': 'EU', 'NL': 'EU', 'IT': 'EU', 'ES': 'EU', 'GB': 'EU', 'PT': 'EU', 'CH': 'EU', 'AT': 'EU', 'IE': 'EU', 'DK': 'EU', 'SE': 'EU', 'NO': 'EU', 'FI': 'EU', 'GR': 'EU', 'PL': 'EU', 'CZ': 'EU', 'HU': 'EU', 'RO': 'EU', 'BG': 'EU', 'TR': 'EU', 'RU': 'EU', 'UA': 'EU', 'MC': 'EU', 'AD': 'EU', 'SM': 'EU', 'VA': 'EU', 'LU': 'EU', 'EE': 'EU', 'LV': 'EU', 'LT': 'EU', 'SK': 'EU', 'SI': 'EU', 'CY': 'EU', 'MT': 'EU', 'IS': 'EU', 'LI': 'EU', 'HR': 'EU', 'BA': 'EU', 'ME': 'EU', 'MK': 'EU', 'AL': 'EU', 'RS': 'EU', 'BY': 'EU', 'MD': 'EU',
  'CA': 'NA', 'US': 'NA', 'MX': 'NA', 'GT': 'NA', 'CR': 'NA', 'CU': 'NA', 'PR': 'NA', 'PA': 'NA', 'NI': 'NA', 'HN': 'NA', 'SV': 'NA', 'BZ': 'NA', 'BS': 'NA', 'JM': 'NA', 'HT': 'NA', 'DO': 'NA', 'KN': 'NA', 'AG': 'NA', 'DM': 'NA', 'LC': 'NA', 'VC': 'NA', 'GD': 'NA', 'BB': 'NA', 'TT': 'NA',
  'BR': 'SA', 'AR': 'SA', 'CL': 'SA', 'CO': 'SA', 'PE': 'SA', 'VE': 'SA', 'EC': 'SA', 'BO': 'SA', 'PY': 'SA', 'UY': 'SA', 'GY': 'SA', 'SR': 'SA', 'FK': 'SA',
  'CN': 'AS', 'JP': 'AS', 'IN': 'AS', 'KR': 'AS', 'AE': 'AS', 'SA': 'AS', 'ID': 'AS', 'MY': 'AS', 'TH': 'AS', 'VN': 'AS', 'PH': 'AS', 'IL': 'AS', 'PK': 'AS', 'BD': 'AS', 'HK': 'AS', 'TW': 'AS', 'SG': 'AS', 'KZ': 'AS', 'UZ': 'AS', 'TM': 'AS', 'KG': 'AS', 'TJ': 'AS', 'AF': 'AS', 'IR': 'AS', 'IQ': 'AS', 'SY': 'AS', 'JO': 'AS', 'LB': 'AS', 'PS': 'AS', 'YE': 'AS', 'OM': 'AS', 'QA': 'AS', 'KW': 'AS', 'BH': 'AS', 'GE': 'AS', 'AM': 'AS', 'AZ': 'AS',
  'AU': 'OC', 'NZ': 'OC', 'FJ': 'OC', 'PG': 'OC', 'SB': 'OC', 'VU': 'OC', 'WS': 'OC', 'TO': 'OC', 'KI': 'OC', 'TV': 'OC', 'NR': 'OC', 'MH': 'OC', 'FM': 'OC', 'PW': 'OC'
};

// Indicatifs téléphoniques internationaux par code pays (minuscule, comme ALL_WORLD_COUNTRIES)
export const COUNTRY_DIAL_CODES: Record<string, string> = {
  // Afrique
  sn: '+221', bj: '+229', ci: '+225', tg: '+228', cm: '+237', ng: '+234', ga: '+241', cg: '+242', cd: '+243',
  ml: '+223', ne: '+227', bf: '+226', gn: '+224', gw: '+245', mr: '+222', gm: '+220', sl: '+232', lr: '+231',
  cv: '+238', st: '+239', gq: '+240', td: '+235', cf: '+236', dz: '+213', ma: '+212', tn: '+216', ly: '+218',
  eg: '+20', sd: '+249', ke: '+254', tz: '+255', ug: '+256', rw: '+250', bi: '+257', et: '+251', dj: '+253',
  so: '+252', mg: '+261', sc: '+248', mu: '+230', km: '+269', za: '+27', ao: '+244', mz: '+258', zm: '+260',
  zw: '+263', na: '+264', bw: '+267', ls: '+266', sz: '+268', mw: '+265', ss: '+211', er: '+291', yt: '+262',
  re: '+262',
  // Europe
  fr: '+33', be: '+32', de: '+49', nl: '+31', it: '+39', es: '+34', gb: '+44', pt: '+351', ch: '+41', at: '+43',
  ie: '+353', dk: '+45', se: '+46', no: '+47', fi: '+358', gr: '+30', pl: '+48', tr: '+90', ru: '+7', lu: '+352',
  // Amérique du Nord
  ca: '+1', us: '+1', mx: '+52',
  // Amérique du Sud
  br: '+55', ar: '+54', co: '+57',
  // Asie
  cn: '+86', jp: '+81', in: '+91', ae: '+971', sa: '+966', sg: '+65', hk: '+852', kz: '+7', az: '+994',
  // Océanie
  au: '+61', nz: '+64',
}

/** Indicatif téléphonique (+221, +1...) pour un code pays donné. Défaut: +221 (Sénégal). */
export function getDialCode(countryCode: string): string {
  return COUNTRY_DIAL_CODES[(countryCode || 'sn').toLowerCase()] || '+221'
}

/** Retire l'indicatif déjà présent dans un numéro (ex: "+221771234567" → "771234567"), pour ré-affichage dans le champ local. */
export function stripDialCode(phone: string, countryCode: string): string {
  if (!phone) return ''
  const dial = getDialCode(countryCode)
  let p = phone.trim()
  if (p.startsWith(dial)) p = p.slice(dial.length)
  else if (p.startsWith('00' + dial.slice(1))) p = p.slice(dial.length + 1)
  return p.replace(/^0+/, '').trim()
}

/** Construit le numéro complet (indicatif + local) envoyé à WooCommerce. */
export function buildFullPhone(countryCode: string, localPhone: string): string {
  const local = (localPhone || '').trim()
  if (local.startsWith('+')) return local
  const dial = getDialCode(countryCode)
  return `${dial}${local.replace(/^0+/, '')}`
}

// Emoji drapeau calculé depuis le code ISO 3166-1 alpha-2 (2 Regional Indicator
// Symbols) — évite de saisir ~190 emoji à la main et garantit qu'un code
// ajouté à COUNTRY_TO_ZONE a toujours un drapeau correct.
function flagFromCode(code: string): string {
  return code.toUpperCase().replace(/./g, (c) =>
    String.fromCodePoint(0x1f1e6 - 65 + c.charCodeAt(0))
  )
}

// Nom français pour chaque code ISO présent dans COUNTRY_TO_ZONE — la liste
// affichée au client (ALL_WORLD_COUNTRIES, plus bas) est dérivée de ces deux
// tables pour garantir qu'aucun pays sélectionnable n'est absent du mapping
// de zone utilisé par calcShipping() (signalé le 2026-07-17 : liste
// incomplète et non triée alphabétiquement dans CountryDetectionBanner).
const COUNTRY_NAMES: Record<string, string> = {
  // Afrique
  SN: 'Sénégal', BJ: 'Bénin', CI: "Côte d'Ivoire", TG: 'Togo', CM: 'Cameroun', NG: 'Nigeria',
  GA: 'Gabon', CG: 'Congo', CD: 'RDC', ML: 'Mali', NE: 'Niger', BF: 'Burkina Faso', GN: 'Guinée',
  GW: 'Guinée-Bissau', MR: 'Mauritanie', GM: 'Gambie', SL: 'Sierra Leone', LR: 'Liberia',
  CV: 'Cap-Vert', ST: 'Sao Tomé-et-Principe', GQ: 'Guinée équatoriale', TD: 'Tchad',
  CF: 'Centrafrique', DZ: 'Algérie', MA: 'Maroc', TN: 'Tunisie', LY: 'Libye', EG: 'Égypte',
  SD: 'Soudan', KE: 'Kenya', TZ: 'Tanzanie', UG: 'Ouganda', RW: 'Rwanda', BI: 'Burundi',
  ET: 'Éthiopie', DJ: 'Djibouti', SO: 'Somalie', MG: 'Madagascar', SC: 'Seychelles',
  MU: 'Maurice', KM: 'Comores', ZA: 'Afrique du Sud', AO: 'Angola', MZ: 'Mozambique',
  ZM: 'Zambie', ZW: 'Zimbabwe', NA: 'Namibie', BW: 'Botswana', LS: 'Lesotho', SZ: 'Eswatini',
  MW: 'Malawi', SS: 'Soudan du Sud', ER: 'Érythrée', YT: 'Mayotte', RE: 'Réunion',
  // Europe
  FR: 'France', BE: 'Belgique', DE: 'Allemagne', NL: 'Pays-Bas', IT: 'Italie', ES: 'Espagne',
  GB: 'Royaume-Uni', PT: 'Portugal', CH: 'Suisse', AT: 'Autriche', IE: 'Irlande', DK: 'Danemark',
  SE: 'Suède', NO: 'Norvège', FI: 'Finlande', GR: 'Grèce', PL: 'Pologne', CZ: 'Tchéquie',
  HU: 'Hongrie', RO: 'Roumanie', BG: 'Bulgarie', TR: 'Turquie', RU: 'Russie', UA: 'Ukraine',
  MC: 'Monaco', AD: 'Andorre', SM: 'Saint-Marin', VA: 'Vatican', LU: 'Luxembourg',
  EE: 'Estonie', LV: 'Lettonie', LT: 'Lituanie', SK: 'Slovaquie', SI: 'Slovénie', CY: 'Chypre',
  MT: 'Malte', IS: 'Islande', LI: 'Liechtenstein', HR: 'Croatie', BA: 'Bosnie-Herzégovine',
  ME: 'Monténégro', MK: 'Macédoine du Nord', AL: 'Albanie', RS: 'Serbie', BY: 'Biélorussie',
  MD: 'Moldavie',
  // Amérique du Nord & Caraïbes
  CA: 'Canada', US: 'États-Unis', MX: 'Mexique', GT: 'Guatemala', CR: 'Costa Rica', CU: 'Cuba',
  PR: 'Porto Rico', PA: 'Panama', NI: 'Nicaragua', HN: 'Honduras', SV: 'Salvador', BZ: 'Belize',
  BS: 'Bahamas', JM: 'Jamaïque', HT: 'Haïti', DO: 'République dominicaine',
  KN: 'Saint-Christophe-et-Niévès', AG: 'Antigua-et-Barbuda', DM: 'Dominique',
  LC: 'Sainte-Lucie', VC: 'Saint-Vincent-et-les-Grenadines', GD: 'Grenade', BB: 'Barbade',
  TT: 'Trinité-et-Tobago',
  // Amérique du Sud
  BR: 'Brésil', AR: 'Argentine', CL: 'Chili', CO: 'Colombie', PE: 'Pérou', VE: 'Venezuela',
  EC: 'Équateur', BO: 'Bolivie', PY: 'Paraguay', UY: 'Uruguay', GY: 'Guyana', SR: 'Suriname',
  FK: 'Îles Malouines',
  // Asie & Moyen-Orient
  CN: 'Chine', JP: 'Japon', IN: 'Inde', KR: 'Corée du Sud', AE: 'Émirats arabes unis',
  SA: 'Arabie Saoudite', ID: 'Indonésie', MY: 'Malaisie', TH: 'Thaïlande', VN: 'Vietnam',
  PH: 'Philippines', IL: 'Israël', PK: 'Pakistan', BD: 'Bangladesh', HK: 'Hong Kong',
  TW: 'Taïwan', SG: 'Singapour', KZ: 'Kazakhstan', UZ: 'Ouzbékistan', TM: 'Turkménistan',
  KG: 'Kirghizistan', TJ: 'Tadjikistan', AF: 'Afghanistan', IR: 'Iran', IQ: 'Irak',
  SY: 'Syrie', JO: 'Jordanie', LB: 'Liban', PS: 'Palestine', YE: 'Yémen', OM: 'Oman',
  QA: 'Qatar', KW: 'Koweït', BH: 'Bahreïn', GE: 'Géorgie', AM: 'Arménie', AZ: 'Azerbaïdjan',
  // Océanie
  AU: 'Australie', NZ: 'Nouvelle-Zélande', FJ: 'Fidji', PG: 'Papouasie-Nouvelle-Guinée',
  SB: 'Îles Salomon', VU: 'Vanuatu', WS: 'Samoa', TO: 'Tonga', KI: 'Kiribati', TV: 'Tuvalu',
  NR: 'Nauru', MH: 'Îles Marshall', FM: 'Micronésie', PW: 'Palaos',
}

// Dérivée de COUNTRY_TO_ZONE + COUNTRY_NAMES, triée alphabétiquement — tout
// pays présent dans le mapping de zone est automatiquement sélectionnable
// (aucune liste séparée à maintenir à la main).
export const ALL_WORLD_COUNTRIES: Country[] = Object.entries(COUNTRY_TO_ZONE)
  .map(([code, region]) => ({
    code: code.toLowerCase(),
    name: COUNTRY_NAMES[code] || code,
    flag: flagFromCode(code),
    currency: '$',
    region,
  }))
  .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

/**
 * Retourne les frais de livraison pour une commande selon le pays et la méthode
 */
export function getShippingCost(
  countryCode: string,
  method: 'standard' | 'express',
  shippingRates: Record<string, any>
): number {
  const countryUpper = (countryCode || 'SN').toUpperCase();
  const countryRates = shippingRates[countryUpper];

  if (countryRates) {
    return method === 'express'
      ? Number(countryRates.express_price) || 0
      : Number(countryRates.standard_price) || 0;
  }

  return 0;
}

export function getCountryZone(countryCode: string): string | null {
  return COUNTRY_TO_ZONE[countryCode.toUpperCase()] || null;
}

// Fourchettes de tarif par zone (par kg, minimum hors Afrique = $25)
export const ZONE_SHIPPING_RATES: Record<string, { standardMin: number; standardMax: number; expressMin: number; expressMax: number; local: number }> = {
  AF: { standardMin: 12, standardMax: 22, expressMin: 30, expressMax: 55, local: 10 },
  EU: { standardMin: 25, standardMax: 45, expressMin: 45, expressMax: 70, local: 10 },
  NA: { standardMin: 25, standardMax: 50, expressMin: 50, expressMax: 75, local: 10 },
  SA: { standardMin: 25, standardMax: 50, expressMin: 55, expressMax: 80, local: 10},
  AS: { standardMin: 25, standardMax: 55, expressMin: 55, expressMax: 85, local: 10 },
  OC: { standardMin: 30, standardMax: 60, expressMin: 60, expressMax: 90, local: 10 },
}

/** Vrai si pays du produit == pays de livraison → livraison locale 3 $ */
export function isLocalDelivery(productCountryCode: string, userCountryCode: string): boolean {
  if (!productCountryCode || !userCountryCode) return false
  return productCountryCode.toLowerCase() === userCountryCode.toLowerCase()
}

/** Vrai si produit et client sont tous les deux en Afrique (zone AF) mais pays différents → 6 $ */
export function isSameZoneAfrica(productCountryCode: string, userCountryCode: string): boolean {
  if (!productCountryCode || !userCountryCode) return false
  if (isLocalDelivery(productCountryCode, userCountryCode)) return false
  return (
    COUNTRY_TO_ZONE[productCountryCode.toUpperCase()] === 'AF' &&
    COUNTRY_TO_ZONE[userCountryCode.toUpperCase()]    === 'AF'
  )
}

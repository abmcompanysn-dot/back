import { NextResponse } from 'next/server';

export const runtime = 'edge';

export const dynamic = 'force-dynamic';

/** Constantes du contrat DHL 2026 */
const DHL_CONSTANTS = {
  VOL_DIVISOR: 5000,      // Diviseur volumétrique standard
  RESIDENTIAL_FEE: 4.75,  // Surcharge résidentielle ($)
  LOCAL_FEE: 3            // Prix fixe livraison locale ($)
};

/** Grille tarifaire publique DHL (Zones E, G, H) */
const getPublicRate = (weight: number, zone: string) => {
  const grid: Record<number, Record<string, number>> = {
    // Tarifs de base en CAD (excluant la surcharge résidentielle de 4.75$)
    0.5: { E: 30.06, G: 35.90, H: 25.90 },
    1.0: { E: 37.30, G: 44.49, H: 31.30 },
    2.0: { E: 48.23, G: 57.50, H: 40.35 },
  };

  const keys = Object.keys(grid).map(Number).sort((a, b) => a - b);
  for (const maxW of keys) {
    if (weight <= maxW) return grid[maxW][zone];
  }
  // Fallback linéaire pour les gros colis
  return (weight / 2) * grid[2.0][zone];
};

/** Détermine la zone DHL selon le code pays */
const getShippingZone = (dest: string) => {
  const country = dest.toUpperCase();
  const euro = ['FR', 'BE', 'DE', 'NL', 'IT', 'ES', 'GB', 'CH', 'AT'];
  const afrique = ['SN', 'BJ', 'CI', 'TG', 'CM', 'GA', 'ML', 'BF', 'NE', 'GN'];

  if (euro.includes(country)) return 'E';
  if (country === 'CA' || country === 'US') return 'G';
  if (afrique.includes(country)) return 'H';
  
  return 'G'; // Zone par défaut (International)
};

/** Helper pour mapper un pays à son continent */
const getContinentFromCountry = (countryCode: string): string => {
  const code = countryCode.toUpperCase();
  const maps: Record<string, string[]> = {
    'AF': ['SN', 'BJ', 'CI', 'TG', 'CM', 'GA', 'ML', 'BF', 'NE', 'GN'],
    'EU': ['FR', 'BE', 'DE', 'NL', 'IT', 'ES', 'GB', 'CH', 'AT'],
    'NA': ['US', 'CA'],
    // ...
  };
  for (const [zone, countries] of Object.entries(maps)) {
    if (countries.includes(code)) return zone;
  }
  return 'AF';
};

/**
 * Calcule les frais pour un item spécifique (Produit + Quantité)
 */
const calculateItemShippingCosts = (item: any, destCountry: string) => {
  const { product, quantity } = item;
  const dest = destCountry.toUpperCase();
  const origin = (product.countryCode || product.vendor?.countryCode || 'SN').toUpperCase();
  
  // On calcule pour le poids total de cet item (Poids unitaire x Quantité)
  // pour appliquer correctement les paliers de poids (ex: 3 x 0.5kg = 1.5kg -> palier 2kg)
  let expressCost = 0;
  let standardCost = 0;

  // --- LIVRAISON EXPRESS (DHL-like logic) ---
  // 1. PRIORITÉ : Vérification des métadonnées (Prix fixe par pays ou zone continentale)
  const continent = getContinentFromCountry(dest);
  const countryKey = `_miad_ship_price_${dest}`;
  const zoneKey = `_miad_ship_price_zone_${continent}`;
  const defaultKey = `_miad_ship_price_`;
  
  const shipMeta = product.meta_data?.find((m: any) => m.key === countryKey) || 
                   product.meta_data?.find((m: any) => m.key === zoneKey) ||
                   product.meta_data?.find((m: any) => m.key === defaultKey);

  if (shipMeta && shipMeta.value) {
    expressCost = parseFloat(shipMeta.value);
  } else if (origin === dest) {
    // 2. FALLBACK : Moteur de calcul dynamique DHL
    // Si même pays : Tarif local fixe
    expressCost = DHL_CONSTANTS.LOCAL_FEE * quantity;
  } else {
    // 3. FALLBACK COMPLET : Calcul dynamique DHL
    const unitWeight = parseFloat(product.weight) || 0.5;
    const totalWeight = unitWeight * quantity;

    const l = parseFloat(product.dimensions?.length) || 15;
    const w = parseFloat(product.dimensions?.width) || 10;
    const h = parseFloat(product.dimensions?.height) || 5;

    const volWeight = ((l * w * h) / DHL_CONSTANTS.VOL_DIVISOR) * quantity;
    const chargableWeight = Math.ceil(Math.max(totalWeight, volWeight) * 2) / 2;

    const zone = getShippingZone(dest);
    const publicRate = getPublicRate(chargableWeight, zone);
    
    // Coût de base du palier + Surcharge Résidentielle
    expressCost = publicRate + DHL_CONSTANTS.RESIDENTIAL_FEE;
  }

  // Sécurité : Ne jamais renvoyer 0 si le produit a un prix
  if (expressCost <= 0) expressCost = 50.67;
  // --- LIVRAISON STANDARD (STRICTEMENT 40% de l'Express) ---
  standardCost = expressCost * 0.40;
  
  // On retourne le coût global pour cet item (le calcul de poids a déjà intégré la quantité)
  const finalExpress = expressCost;
  const finalStandard = standardCost;

  return { expressCost: finalExpress, standardCost: finalStandard };
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { cart, country } = body;

    if (!cart || !Array.isArray(cart) || !country) {
      return NextResponse.json({ cost: 15.00, error: "Données manquantes" }, { status: 400 });
    }

    let totalExpressCost = 0;
    let totalStandardCost = 0;

    // Aggregate costs for all items in the cart
    cart.forEach((item: any) => {
      const { expressCost, standardCost } = calculateItemShippingCosts(item, country);
      totalExpressCost += expressCost;
      totalStandardCost += standardCost;
    }, 0);

    return NextResponse.json({
      options: [
        {
          methodId: 'miad_express',
          provider: 'MIAD Express',
          cost: Math.round(totalExpressCost * 100) / 100,
          duration: '3-5 jours ouvrés',
          description: 'Livraison rapide et suivie MIAD Express.'
        },
        {
          methodId: 'miad_standard',
          provider: 'Livraison Standard',
          cost: Math.round((totalExpressCost * 0.40) * 100) / 100, // Enforce 40% ratio
          duration: '3-4 semaines', // Approximately 1 month
          description: 'Option économique, délai de livraison plus long.'
        }
      ],
      currency: '$' // Assuming USD for now, adjust as needed
    });

  } catch (error) {
    console.error("[Shipping API] Erreur:", error);
    return NextResponse.json({ 
      options: [
         {
          methodId: 'miad_express',
          provider: 'MIAD Express',
          cost: 50.67,
          duration: '3-5 jours ouvrés',
          description: 'Estimation de secours (Express).'
        },
        {
          methodId: 'miad_standard',
          provider: 'Livraison Standard',
          cost: 20.27,
          duration: '3-4 semaines',
          description: 'Estimation de secours (Standard 40%).'
        }
      ],
      currency: '$',
      error: "Erreur lors de l'estimation"
    }, { status: 500 });
  }
}

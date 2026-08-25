import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

export const runtime = 'edge';

/**
 * GAP BACKEND CONNU : cette route lisait auparavant une metadata WooCommerce
 * par produit (`_miad_ship_price_{COUNTRY}` / `_miad_ship_price_`) pour un
 * prix de livraison spécifique à ce produit. Aucun service Go n'expose
 * l'équivalent aujourd'hui — catalog-svc n'a pas de champ de prix de
 * livraison par produit (seulement `shipping_class`, une simple étiquette
 * texte, voir services/catalog-svc/main.go), et aucun endpoint shipping-svc
 * n'accepte de resoudre un prix par (product_id, country). shipping-svc
 * calcule uniquement par zone pays (GET /shipping-rates/quote) ou par
 * distance vendeur→acheteur pour le Sénégal (POST /shipping-domestic/calculate).
 *
 * Note : aucun appelant frontend actif n'a été trouvé pour /api/geo (grep
 * sur app/ et components/ ne remonte aucun `fetch('/api/geo'`) — la
 * détection pays reste migrée ci-dessous (c'est un simple lookup d'en-tête,
 * pas une dépendance WooCommerce), mais shippingPrice renvoie désormais 0
 * de façon permanente plutôt que de faire un appel WooCommerce mort. Si un
 * futur besoin de prix de livraison par produit apparaît, il faudra ajouter
 * ce champ à catalog-svc.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const productId = searchParams.get('productId');

  const headersList = await headers();
  const countryCode = (headersList.get('x-vercel-ip-country') || headersList.get('cf-ipcountry') || 'SN').toUpperCase();

  if (productId) {
    console.warn('[api/geo] shippingPrice par produit demandé mais aucun endpoint Go ne fournit cette donnée — renvoie 0.');
  }

  return NextResponse.json({
    countryCode: countryCode.toLowerCase(),
    shippingPrice: 0,
  });
}

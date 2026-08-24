import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://www.miadmarket.com').replace(/\/$/, '');
const WOO_KEY = process.env.WOO_CONSUMER_KEY;
const WOO_SECRET = process.env.WOO_CONSUMER_SECRET;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const productId = searchParams.get('productId');
  
  const headersList = await headers();
  const countryCode = (headersList.get('x-vercel-ip-country') || headersList.get('cf-ipcountry') || 'SN').toUpperCase();
  
  let shippingPrice = 0;

  // Si un ID produit est passé, on va chercher son prix de livraison spécifique dans ses métadonnées
  if (productId && WOO_KEY && WOO_SECRET) {
    try {
      const res = await fetch(`${WOO_URL}/wp-json/wc/v3/products/${productId}?consumer_key=${WOO_KEY}&consumer_secret=${WOO_SECRET}`);
      const product = await res.json();
      
      const countryKey = `_miad_ship_price_${countryCode}`;
      const defaultKey = `_miad_ship_price_`; // Fallback par défaut
      
      const meta = product.meta_data?.find((m: any) => m.key === countryKey) || 
                   product.meta_data?.find((m: any) => m.key === defaultKey);
      
      shippingPrice = meta ? parseFloat(meta.value) : 0;
    } catch (e) {
      console.error("Erreur récupération prix livraison produit", e);
    }
  }

  return NextResponse.json({ 
    countryCode: countryCode.toLowerCase(),
    shippingPrice
  });
}

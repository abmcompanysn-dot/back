import { NextResponse } from 'next/server'

export const runtime = 'edge';

export const dynamic = 'force-dynamic'; 
import { WooCategory } from '@/lib/woocommerce';
import { decodeHtmlEntities } from '@/lib/utils';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://www.miadmarket.com').replace(/\/$/, '');
const WOO_KEY = process.env.WOO_CONSUMER_KEY
const WOO_SECRET = process.env.WOO_CONSUMER_SECRET
import { requireEnv } from '@/lib/require-env'
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const lang = searchParams.get('lang')
  const parentId = searchParams.get('parent')

  try {
    if (!WOO_KEY || !WOO_SECRET) throw new Error("API Keys missing");
    
    const auth = Buffer.from(`${WOO_KEY}:${WOO_SECRET}`).toString('base64');

    const apiUrl = new URL(`${WOO_URL}/wp-json/wc/v3/products/categories`);
    apiUrl.searchParams.append('per_page', '100');
    apiUrl.searchParams.append('hide_empty', 'true');
    if (lang) apiUrl.searchParams.append('lang', lang);
    if (parentId) apiUrl.searchParams.append('parent', parentId);

    const response = await fetch(apiUrl.toString(), {
      headers: {
        'Authorization': `Basic ${auth}`,
        'User-Agent': 'MIAD-Headless-Client',
        'X-Headless-Secret': INTERNAL_SECRET,
        'Accept': 'application/json',
      },
      next: { revalidate: 3600 } // Cache plus long (1h) pour les catégories qui changent peu
    });

    // Détection du blocage de sécurité WordPress (Anti-Bot SiteGround)
    if (response.status === 202) {
      console.error("[API Categories] Blocage de sécurité (Challenge 202) sur WordPress.");
      return NextResponse.json({ categories: [], error: "Security challenge required" }, { status: 502 });
    }

    const text = await response.text();

    // Vérification de sécurité : WordPress ne doit pas renvoyer de HTML (WAF Block)
    if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
      console.error(`[API Categories] Blocage Pare-feu détecté (Status: ${response.status})`);
      return NextResponse.json({ categories: [] }, { status: 200 });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error("[API Categories] Réponse serveur invalide (JSON attendu)");
      return NextResponse.json({ categories: [] }, { status: 200 });
    }

    if (!response.ok) {
      throw new Error(data.message || `Erreur API WooCommerce: ${response.status}`);
    }
    
    // Transformation des données pour MIAD Market
    const transformedCategories: WooCategory[] = data.map((c: any) => ({
      id: c.id.toString(),
      name: decodeHtmlEntities(c.name || ''),
      slug: c.slug,
      image: c.image?.src || '/category-placeholder.png',
      productCount: c.count || 0,
      // Métadonnées supplémentaires utiles pour le frontend
      parent: (c.parent || 0).toString(),
      isRoot: !c.parent || c.parent === 0,
      description: decodeHtmlEntities(c.description || ''),
      lang: (lang || 'fr') as 'fr' | 'en'
    }))

    // Tri : On met les catégories les plus populaires (avec le plus de produits) en premier
    const sortedCategories = transformedCategories.sort((a, b) => b.productCount - a.productCount)

    return NextResponse.json(
      { categories: sortedCategories },
      {
        headers: { 
          // Cache frais 5 min, mais servable via le cache Vercel jusqu'à 1h (stale-while-revalidate)
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' 
        }
      }
    )
  } catch (error) {
    console.error("[Route API Categories] Erreur critique:", error);
    return NextResponse.json({ categories: [] }, { status: 200 });
  }
}

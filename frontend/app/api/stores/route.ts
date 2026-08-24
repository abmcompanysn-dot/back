import { NextResponse } from 'next/server'
import { catalogCacheGet, catalogCacheSet } from '@/lib/catalog-cache'

export const runtime = 'edge';

export const dynamic = 'force-dynamic';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com/').replace(/\/$/, '');
const WOO_CK = process.env.WOO_CONSUMER_KEY;
const WOO_CS = process.env.WOO_CONSUMER_SECRET;
import { requireEnv } from '@/lib/require-env'
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')
const MIAD_PRODUCTS_API = process.env.MIAD_PRODUCTS_API || `${WOO_URL}/wp-json/miad-products/v1`

// Dokan ne reflète jamais l'URL CDN pour gravatar/banner (incident du
// 2026-07-04, reconfirmé le 2026-07-14 — voir CLAUDE.md). Plutôt que
// d'attendre que Dokan se corrige, on lit un override manuel posé depuis
// WP Admin ("Images Vendeurs") qui prend le pas sur la valeur Dokan.
async function getVendorImageOverrides(): Promise<Record<string, { logo?: string; banner?: string }>> {
  try {
    const res = await fetch(`${MIAD_PRODUCTS_API}/vendor-image-overrides`, {
      headers: { 'Accept': 'application/json' },
      next: { revalidate: 300 },
    })
    if (!res.ok) return {}
    const data: any = await res.json().catch(() => ({}))
    return data.overrides || {}
  } catch {
    return {}
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const perPage = searchParams.get('per_page') || '100'
  const kvKey = `stores:per_page=${perPage}`

  try {
    if (!WOO_CK || !WOO_CS) throw new Error("API Keys missing");

    // Next.js Best Practice: Using URL parameters for auth is more robust on SiteGround/Apache 
    // than headers, which are often stripped.
    const apiUrl = new URL(`${WOO_URL}/wp-json/dokan/v1/stores`);
    apiUrl.searchParams.append('per_page', perPage);
    apiUrl.searchParams.append('consumer_key', WOO_CK);
    apiUrl.searchParams.append('consumer_secret', WOO_CS);

    const response = await fetch(apiUrl.toString(), {
      headers: {
        'User-Agent': 'MIAD-Headless-Client',
        'X-Headless-Secret': INTERNAL_SECRET,
        'Accept': 'application/json',
      },
      next: { revalidate: 3600 }, 
    });

    const contentType = response.headers.get('content-type') || '';
    const bodyText = await response.text();

    if (!response.ok || !contentType.includes('application/json')) {
      throw new Error(`WooCommerce non-JSON response (status ${response.status}): ${bodyText.slice(0, 200)}`);
    }

    const rawData = JSON.parse(bodyText);
    // Sécurité : Dokan peut renvoyer un tableau directement ou un objet avec une clé 'stores'
    const data = Array.isArray(rawData) ? rawData : (rawData.stores || []);
    const overrides = await getVendorImageOverrides()

    const stores = data.flatMap((s: any) => {
      // Comptes vendeur jamais finalisés (inscription incomplète, aucun nom de
      // boutique renseigné) — ne doivent pas apparaître comme "boutiques" sur
      // le site public (montraient "Vendeur" + avatar mystère par défaut).
      if (!s.store_name || s.store_name.trim() === '') return []
      const override = overrides[String(s.id)]
      return [{
        id: s.id?.toString() || null,
        name: s.store_name,
        slug: s.shop_url?.split('/').filter(Boolean).pop() || '',
        logo: override?.logo || s.gravatar || '',
        banner: override?.banner || s.banner || '',
        country: s.address?.country || '',
        countryCode: s.address?.country || '',
        rating: parseFloat(s.rating?.rating || '0'),
        verified: !!s.enabled,
        productCount: s.products_count || 0
      }]
    });
    
    await catalogCacheSet(kvKey, { stores })

    return NextResponse.json({ stores }, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=31536000'
      }
    });

  } catch (error: any) {
    console.error("[Route API Stores] Erreur:", error);

    // WordPress/Dokan inaccessible : on tente de servir la dernière liste de boutiques
    // connue depuis le cache de secours KV plutôt que de renvoyer un tableau vide.
    const fallback = await catalogCacheGet<{ stores: any[] }>(kvKey)
    if (fallback) {
      return NextResponse.json(fallback.data, {
        headers: {
          'Cache-Control': 'public, s-maxage=60',
          'X-Miad-Catalog-Source': 'kv-fallback',
          'X-Miad-Catalog-Saved-At': new Date(fallback.savedAt).toISOString(),
        }
      })
    }

    return NextResponse.json({ stores: [], error: "Service indisponible" }, { status: 500 });
  }
}

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { catalogCacheGet, catalogCacheSet } from '@/lib/catalog-cache'
import { getCloudflareBindings, embedOne } from '@/lib/cloudflare-ai'
import { fetchWooProductsByIds } from '@/lib/woo-catalog'
import { CATALOG_SVC_URL, VENDOR_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Helper pour mapper un pays à son continent (Zone MIAD) */
const getContinentFromCountry = (countryCode: string): string => {
  const code = countryCode.toUpperCase();
  const maps: Record<string, string[]> = {
    'AF': ['SN', 'BJ', 'CI', 'TG', 'CM', 'GA', 'ML', 'BF', 'NE', 'GN', 'MA', 'DZ', 'TN'],
    'EU': ['FR', 'BE', 'DE', 'NL', 'IT', 'ES', 'GB', 'CH', 'AT', 'PT', 'LU'],
    'NA': ['US', 'CA', 'MX'],
    'SA': ['BR', 'AR', 'CO', 'CL'],
    'AS': ['CN', 'JP', 'KR', 'IN', 'AE', 'SA', 'QA'],
    'OC': ['AU', 'NZ']
  };
  for (const [zone, countries] of Object.entries(maps)) {
    if (countries.includes(code)) return zone;
  }
  return 'AF'; // Par défaut
};

/**
 * Récupère TOUS les IDs produits correspondant aux filtres (lang/catégorie/
 * recherche), pas juste une page — nécessaire pour un tri aléatoire stable
 * (voir seededShuffle ci-dessous) : catalog-svc ne propose pas de tri
 * aléatoire avec graine, donc on doit mélanger nous-mêmes le jeu complet.
 * page_size=100 (plafond catalog-svc) par page, jusqu'à épuisement.
 */
async function fetchAllProductIds(opts: {
  lang: string | null; categoryId: string | null; vendorId: string | null; search: string | null; cacheStrategy: number;
}): Promise<number[]> {
  const buildUrl = (page: number) => {
    const url = new URL(`${CATALOG_SVC_URL}/products`);
    url.searchParams.set('page_size', '100');
    url.searchParams.set('page', String(page));
    if (opts.categoryId) url.searchParams.set('category_id', opts.categoryId);
    if (opts.vendorId) url.searchParams.set('vendor_id', opts.vendorId);
    if (opts.search) url.searchParams.set('q', opts.search);
    if (opts.lang) url.searchParams.set('lang', opts.lang);
    return url.toString();
  };

  const MAX_PAGES = 30;
  const ids: number[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(buildUrl(page), { next: { revalidate: opts.cacheStrategy, tags: ['products', `product-ids-p${page}`] } });
    if (!res.ok) break;
    const data: any = await res.json().catch(() => ({}));
    const batch: Array<{ id: number }> = data.items || [];
    ids.push(...batch.map(p => p.id));
    if (!data.has_more || batch.length === 0) break;
  }
  return ids;
}

/**
 * declusterByVendor — sépare les produits d'une même boutique pour qu'au
 * plus MAX_CONSECUTIVE (2) se suivent d'affilée. Durci le 2026-08-26 :
 * la version précédente ne comparait qu'à l'élément immédiatement
 * précédent (i-1), donc un swap mal placé pouvait laisser passer un motif
 * A A B A A (jamais deux identiques strictement collés, mais le même
 * vendeur revient sans cesse) — pas ce que "aucun vendeur ne peut avoir
 * plus de 1-2 produits côte à côte" demande. Compare maintenant contre les
 * MAX_CONSECUTIVE derniers éléments déjà placés dans `out`, pas contre
 * `arr` d'origine (sinon un swap qui vient d'être fait n'est jamais revu).
 * `optionalHead` (ajouté pour InfiniteProductFeed.tsx) permet de tenir
 * compte des derniers produits de la page PRÉCÉDENTE déjà affichés — sans
 * ça, le motif recommençait à chaque frontière de page puisque chaque
 * lot de 20 était décluster indépendamment (le cache CDN de cette route
 * empêche de connaître l'état d'une autre page côté serveur, donc ce
 * contexte doit être fourni par l'appelant).
 */
const MAX_CONSECUTIVE = 2;
function declusterByVendor<T>(arr: T[], optionalHead: T[] = []): T[] {
  const out = [...arr];
  const vendorId = (p: T) => (p as any)?.vendor?.id as string | null | undefined;
  const history = [...optionalHead];
  for (let i = 0; i < out.length; i++) {
    const v = vendorId(out[i]);
    if (v) {
      const recentSameVendor = history.slice(-MAX_CONSECUTIVE).filter((p) => vendorId(p) === v).length;
      if (recentSameVendor >= MAX_CONSECUTIVE) {
        const swapIdx = out.findIndex((p, idx) => {
          if (idx <= i) return false;
          const pv = vendorId(p);
          if (pv === v) return false;
          // Le candidat lui-même ne doit pas créer une nouvelle série trop
          // longue une fois déplacé ici — vérifié contre le même historique.
          const candidateRecent = history.slice(-MAX_CONSECUTIVE).filter((p2) => vendorId(p2) === pv).length;
          return candidateRecent < MAX_CONSECUTIVE;
        });
        if (swapIdx !== -1) {
          [out[i], out[swapIdx]] = [out[swapIdx], out[i]];
        }
      }
    }
    history.push(out[i]);
  }
  return out;
}

function seededShuffle<T>(arr: T[], seed: string): T[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  let s = h >>> 0;
  const rand = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// getShippingPrice lisait un meta_data WooCommerce (_miad_ship_price_zone_*)
// que catalog-svc n'a pas encore (point ouvert du plan de migration Phase B,
// jamais tranché) — retombe sur la valeur par défaut historique plutôt que
// de planter, en attendant qu'un vrai champ shipping_price_by_zone existe
// côté Go (voir shipping-svc pour la logique de zones déjà en place).
const DEFAULT_SHIPPING_PRICE = 50.67;

export async function GET(req: Request) {
  const headerList = await headers();
  const detectedCountry = headerList.get('x-vercel-ip-country') || headerList.get('cf-ipcountry') || 'SN';

  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category')
  const vendor = searchParams.get('vendor')
  const search = searchParams.get('search')
  const id = searchParams.get('id')
  const slug = searchParams.get('slug')
  const includeVariations = searchParams.get('variations') === 'true'
  const refresh = searchParams.get('refresh') === 'true'
  const random = searchParams.get('random') === 'true'
  const seed = searchParams.get('seed') || ''
  // ids= — récupérer un jeu précis de produits déjà connus (wishlist,
  // panier) EN PASSANT PAR CETTE ROUTE plutôt que catalog-svc directement
  // (voir lib/woo-catalog.ts fetchWooProductsByIds) : catalog-svc ne
  // renvoie que vendor_id brut, l'enrichissement en vrai objet vendor
  // (nom, logo — voir mapProduct plus bas) ne se fait QUE dans ce
  // handler. Un appel direct à catalog-svc laisse vendor absent, ce qui
  // fait planter tout composant qui lit product.vendor.name (bug de
  // production trouvé le 2026-08-26 sur CartPage.tsx après connexion).
  const idsParam = searchParams.get('ids')
  const explicitIds = idsParam ? idsParam.split(',').map((s) => s.trim()).filter(Boolean) : null

  let perPage = parseInt(searchParams.get('per_page') || '100');
  if (perPage > 100) perPage = 100;

  const page = searchParams.get('page') || '1';

  const lang = searchParams.get('lang')
  const userCountry = searchParams.get('userCountry');
  const continent = getContinentFromCountry(userCountry || detectedCountry);
  const zone = searchParams.get('zone') || continent;

  const cacheStrategy = refresh ? 0 : 3600;

  const kvKey = `products:${[...searchParams.entries()].filter(([k]) => k !== 'refresh').sort().map(([k, v]) => `${k}=${v}`).join('&')}`

  try {
    // Catégorie : catalog-svc filtre nativement par ID de terme (category_id).
    // Les appelants envoient un slug — on le résout en ID une fois via
    // GET /categories (déjà mis en cache 1h côté fetchInitialCategories,
    // mais on refait l'appel ici pour rester autonome de ce module).
    let categoryId: string | null = null;
    if (!id && category) {
      if (/^\d+$/.test(category)) {
        categoryId = category;
      } else {
        const catRes = await fetch(`${CATALOG_SVC_URL}/categories?lang=${lang || 'fr'}`, {
          next: { revalidate: 3600, tags: ['categories'] },
        });
        const catData = catRes.ok ? await catRes.json().catch(() => ({})) : {};
        const match = (catData.items || catData.categories || []).find((c: any) => c.slug === category);
        categoryId = match ? String(match.id) : null;
      }
    }

    // Vendeur : catalog-svc filtre nativement par vendor_id, plus besoin du
    // détour vendor-product-ids (spécifique à Dokan, cassé côté WooCommerce).
    let vendorTotalCount = 0;
    if (!id && vendor) {
      const countRes = await fetch(
        `${CATALOG_SVC_URL}/products?vendor_id=${vendor}&page_size=1&lang=${lang || 'fr'}`,
        { next: { revalidate: cacheStrategy, tags: ['products', `vendor-${vendor}`] } },
      );
      const countData = countRes.ok ? await countRes.json().catch(() => ({})) : {};
      vendorTotalCount = countData.total || 0;
      if (vendorTotalCount === 0) {
        return NextResponse.json({ products: [], total: 0, pages: 1 });
      }
    }

    // Tri aléatoire stable : uniquement sur le flux global filtré, si le
    // client a fourni une graine de session.
    let randomPageIds: number[] | null = null;
    let randomTotalCount = 0;
    if (!id && !vendor && random && seed) {
      const allIds = await fetchAllProductIds({ lang, categoryId, vendorId: null, search, cacheStrategy });
      randomTotalCount = allIds.length;
      const shuffled = seededShuffle(allIds, seed);
      const startIdx = (parseInt(page) - 1) * perPage;
      randomPageIds = shuffled.slice(startIdx, startIdx + perPage);

      if (randomPageIds.length === 0) {
        return NextResponse.json({ products: [], total: randomTotalCount, pages: Math.max(1, Math.ceil(randomTotalCount / perPage)) });
      }
    }

    if (explicitIds && explicitIds.length === 0) {
      return NextResponse.json({ products: [], total: 0, pages: 1 });
    }

    let apiUrl: URL;
    if (id) {
      apiUrl = new URL(`${CATALOG_SVC_URL}/products/${id}`);
      if (lang) apiUrl.searchParams.set('lang', lang);
    } else {
      apiUrl = new URL(`${CATALOG_SVC_URL}/products`);
      apiUrl.searchParams.set('page_size', explicitIds ? String(explicitIds.length) : perPage.toString());
      apiUrl.searchParams.set('page', (randomPageIds || explicitIds) ? '1' : page);
      if (slug) apiUrl.searchParams.set('slug', slug);
      if (categoryId) apiUrl.searchParams.set('category_id', categoryId);
      if (vendor) apiUrl.searchParams.set('vendor_id', vendor);
      if (search) apiUrl.searchParams.set('q', search);
      if (lang) apiUrl.searchParams.set('lang', lang);
      if (randomPageIds) apiUrl.searchParams.set('include', randomPageIds.join(','));
      else if (explicitIds) apiUrl.searchParams.set('include', explicitIds.join(','));
    }

    const response = await fetch(apiUrl.toString(), {
      next: { revalidate: cacheStrategy, tags: ['products', `products-${lang || 'fr'}`] },
    });

    const totalProducts = randomPageIds
      ? String(randomTotalCount)
      : vendor
      ? String(vendorTotalCount)
      : null; // pris depuis le body ci-dessous sinon (catalog-svc renvoie "total" dans le JSON, pas un header)
    const text = await response.text();

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Réponse serveur invalide (JSON attendu mais illisible).");
    }

    if (!response.ok) {
      if (response.status >= 500) {
        return NextResponse.json({ products: [], error: 'Serveur indisponible' }, { status: 503 });
      }
      throw new Error(data?.error?.message || `Erreur catalog-svc: ${response.status}`);
    }

    const rawProducts = id ? [data] : (data.items || []);
    const finalTotal = totalProducts ? parseInt(totalProducts) : (data.total ?? rawProducts.length);
    const finalPages = totalProducts
      ? Math.max(1, Math.ceil(parseInt(totalProducts) / perPage))
      : (data.total_pages || 1);

    // Variations : catalog-svc les inclut déjà pour un produit unique
    // (GET /products/{id}) mais pas dans une liste — batch séparé pour les
    // produits variables d'une page de résultats.
    let variationsMap: Record<number, any[]> = {};
    if (includeVariations && !id) {
      const variableIds = rawProducts.filter((p: any) => p.type === 'variable').map((p: any) => p.id);
      if (variableIds.length > 0) {
        const varRes = await fetch(`${CATALOG_SVC_URL}/products/variations?ids=${variableIds.join(',')}`, {
          next: { revalidate: cacheStrategy, tags: ['products'] },
        });
        if (varRes.ok) {
          const varData = await varRes.json().catch(() => ({}));
          variationsMap = varData.variations || {};
        }
      }
    } else if (includeVariations && id && data.variations) {
      variationsMap[data.id] = data.variations;
    }

    // Infos boutique : catalog-svc ne renvoie que vendor_id (pas d'objet
    // store imbriqué comme WooCommerce/Dokan) — un seul appel groupé à
    // vendor-svc pour enrichir tous les produits de la page.
    const vendorIds = Array.from(new Set(rawProducts.map((p: any) => p.vendor_id).filter(Boolean)));
    const vendorsById: Record<string, any> = {};
    if (vendorIds.length > 0) {
      const storesRes = await fetch(`${VENDOR_SVC_URL}/stores?page_size=100`, {
        next: { revalidate: 3600, tags: ['stores'] },
      });
      if (storesRes.ok) {
        const storesData = await storesRes.json().catch(() => ({}));
        for (const s of (storesData.items || storesData.stores || [])) {
          vendorsById[String(s.id)] = s;
        }
      }
    }

    const mapProduct = (p: any) => {
      const store = vendorsById[String(p.vendor_id)];
      return {
        id: p.id || null,
        name: p.name || '',
        slug: p.slug || '',
        sku: p.sku || '',
        description: p.description || '',
        price: parseFloat(p.price || p.price_usd || '0'),
        regularPrice: parseFloat(p.regular_price || p.price || p.price_usd || '0'),
        salePrice: p.on_sale && p.sale_price ? parseFloat(p.sale_price) : undefined,
        onSale: !!p.on_sale,
        image: p.image || p.images?.[0]?.src || '/placeholder.svg',
        images: (p.images || []).map((img: any) => img.src || img),
        categories: p.category_id ? [{ name: '', slug: '' }] : [],
        category: 'Général',
        categorySlug: '',
        stock: p.stock ?? 0,
        inStock: (p.stock ?? 0) > 0 || p.status === 'active',
        manageStock: true,
        rating: 0,
        salesCount: 0,
        lang: (lang || p.lang || 'fr') as 'fr' | 'en',
        countryCode: store?.country || '',
        shippingPrice: DEFAULT_SHIPPING_PRICE,
        meta_data: [],
        attributes: [],
        defaultAttributes: [],
        vendor: store ? {
          id: String(p.vendor_id),
          name: store.store_name || store.name || 'Boutique',
          slug: store.slug || '',
          address: { country: store.country || '' },
          countryCode: store.country || '',
          rating: parseFloat(store.rating_avg || '0'),
          logo: store.gravatar || store.logo_url || '',
          banner: store.banner || store.banner_url || '',
          productCount: store.product_count || store.products_count || 0,
        } : (p.vendor_id ? { id: String(p.vendor_id), name: 'Boutique', slug: '' } : null),
        type: p.type || 'simple',
        variations: (variationsMap[p.id] || []).map((v: any) => ({
          id: v.id?.toString(),
          price: parseFloat(v.price || v.price_usd || '0'),
          regularPrice: parseFloat(v.price || v.price_usd || '0'),
          salePrice: undefined,
          sku: v.sku || '',
          inStock: !!v.in_stock,
          stock: v.stock || 0,
          image: v.image_url || p.image || '',
          attributes: Object.entries(v.attributes || {}).map(([name, option]) => ({ name, option })),
          shippingPrice: DEFAULT_SHIPPING_PRICE,
        })),
      };
    };

    let products = rawProducts.map(mapProduct);

    if (search && !id) {
      try {
        const bindings = await getCloudflareBindings()
        if (bindings) {
          const vector = await embedOne(bindings.ai, search)
          const result = await bindings.vectorize.query(vector, { topK: 30, returnMetadata: 'none' })
          const existingIds = new Set(products.map((p: any) => String(p.id)))
          const SEMANTIC_MIN_SCORE = 0.72
          const newIds = result.matches
            .filter(m => (m.score ?? 0) >= SEMANTIC_MIN_SCORE)
            .map(m => m.id)
            .filter(mid => !existingIds.has(String(mid)))
          if (newIds.length > 0) {
            const semanticRaw = await fetchWooProductsByIds(newIds, (lang as 'fr' | 'en') || 'fr')
            const seen = new Set(products.map((p: any) => String(p.id)))
            for (const raw of semanticRaw) {
              const mapped = mapProduct(raw)
              if (seen.has(String(mapped.id))) continue
              seen.add(String(mapped.id))
              products.push(mapped)
            }
          }
        }
      } catch (e) {
        console.error('[API Products] Recherche sémantique (complément) échouée:', e)
      }
    }

    if (random && seed) {
      products = declusterByVendor(products);
    } else if (!id && !slug) {
      // Décluster par défaut sur toute liste paginée normale (pas
      // seulement le mode aléatoire) — demandé le 2026-08-26 : plusieurs
      // produits d'une même boutique se suivaient dans la grille de
      // l'accueil (InfiniteProductFeed.tsx, qui n'envoie jamais
      // random/seed) car le decluster ne s'appliquait qu'au mode
      // aléatoire. declusterByVendor ne fait que des échanges locaux
      // (swap avec le prochain produit d'une AUTRE boutique) — l'ordre
      // global (tri catalog-svc, pertinence recherche sémantique, etc.)
      // n'est pas perdu, seuls les doublons consécutifs de boutique sont
      // séparés.
      products = declusterByVendor(products);
    }

    const responseData = {
      products,
      total: Math.max(finalTotal, products.length),
      pages: finalPages,
    };

    await catalogCacheSet(kvKey, responseData)

    return NextResponse.json(responseData, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=31536000'
      }
    });

  } catch (error: any) {
    const fallback = await catalogCacheGet<{ products: any[]; total: number; pages: number }>(kvKey)
    if (fallback) {
      return NextResponse.json(fallback.data, {
        headers: {
          'Cache-Control': 'public, s-maxage=60',
          'X-Miad-Catalog-Source': 'kv-fallback',
          'X-Miad-Catalog-Saved-At': new Date(fallback.savedAt).toISOString(),
        }
      })
    }

    return NextResponse.json(
      { error: "Le serveur est saturé, conservation des données locales." },
      { status: error.status === 401 ? 401 : 503 }
    );
  }
}

// POST /api/products — création d'un produit par un vendeur connecté.
// Faille corrigée le 2026-08-26 : cette route forwardait le body brut à
// catalog-svc SANS vérifier le JWT, et surtout sans jamais ignorer un
// vendor_id fourni par l'appelant — n'importe qui pouvait créer un produit
// pour n'importe quel vendeur sans être connecté (trouvé en lisant
// Dashboard.tsx : handleSubmitProduct appelle bien cette route avec un
// header Authorization, qui était jusqu'ici silencieusement ignoré).
// Même pattern d'auth que GET /api/vendor/products : fetchWpUser résout
// vendor_id depuis le JWT, jamais depuis le body.
export async function POST(req: Request) {
  try {
    const auth = req.headers.get('Authorization')
    if (!auth?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
    }
    const user = await fetchWpUser(auth.slice(7))
    if (!user?.vendor_id) return NextResponse.json({ error: 'Accès réservé aux vendeurs' }, { status: 403 })

    const body = await req.json()
    const res = await fetch(`${CATALOG_SVC_URL}/vendor/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, vendor_id: user.vendor_id }),
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ error: data?.error?.message || 'Erreur catalog-svc' }, { status: res.status })
    return NextResponse.json(data, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

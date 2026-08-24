import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { catalogCacheGet, catalogCacheSet } from '@/lib/catalog-cache'
import { getCloudflareBindings, embedOne } from '@/lib/cloudflare-ai'
import { fetchWooProductsByIds } from '@/lib/woo-catalog'

export const runtime = 'edge';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Increased maxDuration to 60 seconds

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com/').replace(/\/$/, '');
const WOO_CK = process.env.WOO_CONSUMER_KEY;
const WOO_CS = process.env.WOO_CONSUMER_SECRET;
import { requireEnv } from '@/lib/require-env'
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')
// Requiert MIAD_PRODUCTS_SECRET configuré comme secret Cloudflare Pages
// (wrangler pages secret put) — jusqu'ici cette variable n'existait que dans
// .env.local pour les scripts locaux (scripts/miad.mjs), jamais côté site
// déployé. Sans elle, l'appel à /vendor-product-ids échoue en 401 et
// retombe silencieusement sur "0 produits" pour toutes les boutiques.
const MIAD_PRODUCTS_API = process.env.MIAD_PRODUCTS_API || `${WOO_URL}/wp-json/miad-products/v1`
const MIAD_PRODUCTS_SECRET = process.env.MIAD_PRODUCTS_SECRET || ''

/** Helper pour extraire le code pays de manière sécurisée */
const getCountryCode = (store: any) => {
  if (!store || !store.address || typeof store.address !== 'object' || Array.isArray(store.address)) return '';
  return store.address.country || '';
};

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
 * (voir seededShuffle ci-dessous) : WooCommerce ne propose pas de
 * `orderby=rand` avec une graine, donc un `orderby=rand` classique
 * re-mélange à chaque page et casse toute stabilité au retour arrière.
 * `_fields=id` garde chaque requête légère (pas les objets produits complets).
 */
async function fetchAllProductIds(opts: {
  wooUrl: string; auth: string; lang: string | null; categoryId: string | null; search: string | null; cacheStrategy: number;
}): Promise<number[]> {
  const buildUrl = (page: number) => {
    const url = new URL(`${opts.wooUrl}/wp-json/wc/v3/products`);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    url.searchParams.set('status', 'publish');
    url.searchParams.set('_fields', 'id');
    if (opts.categoryId) url.searchParams.set('category', opts.categoryId);
    if (opts.search) url.searchParams.set('search', opts.search);
    if (opts.lang) url.searchParams.set('lang', opts.lang);
    return url.toString();
  };
  const headersFor = (tag: string) => ({
    headers: {
      'Authorization': `Basic ${opts.auth}`,
      'User-Agent': 'MIAD-Headless-Client',
      'X-Headless-Secret': INTERNAL_SECRET,
      'Accept': 'application/json',
    },
    next: { revalidate: opts.cacheStrategy, tags: ['products', tag] },
  });

  // Plafond large (3000 produits) au-delà du catalogue actuel — évite un
  // nombre de requêtes illimité si le catalogue grossit fortement.
  const MAX_PAGES = 30;
  const first = await fetch(buildUrl(1), headersFor('product-ids-p1'));
  if (!first.ok) return [];
  const firstBatch: Array<{ id: number }> = await first.json().catch(() => []);
  const ids: number[] = Array.isArray(firstBatch) ? firstBatch.map(p => p.id) : [];
  const totalPages = Math.min(parseInt(first.headers.get('x-wp-totalpages') || '1'), MAX_PAGES);

  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) => i + 2).map(async page => {
        const res = await fetch(buildUrl(page), headersFor(`product-ids-p${page}`));
        if (!res.ok) return [] as number[];
        const batch: Array<{ id: number }> = await res.json().catch(() => []);
        return Array.isArray(batch) ? batch.map(p => p.id) : [];
      })
    );
    for (const batch of rest) ids.push(...batch);
  }
  return ids;
}

/**
 * Mélange déterministe (Fisher-Yates + PRNG mulberry32 dérivé de la graine
 * texte) : la même graine reproduit toujours le même ordre — c'est ce qui
 * permet au client de garder le même ordre "aléatoire" entre la page
 * d'accueil et un retour arrière depuis une fiche produit (la graine est
 * générée une fois par session côté client, voir MiadMarketClient.tsx).
 */
// Ecarte les produits consecutifs d'une meme boutique dans le flux aleatoire
// de l'accueil (signale le 2026-08-21 : plusieurs produits du meme vendeur
// se suivaient, un vendeur avec beaucoup de produits pouvait "monopoliser"
// visuellement plusieurs cartes d'affilee). Passe gloutonne deterministe :
// si deux voisins partagent le meme vendeur, on echange le second avec le
// prochain produit d'un AUTRE vendeur plus loin dans le tableau — l'ordre
// reste stable pour une meme graine (seededShuffle), seule la contrainte
// d'adjacence est corrigee.
function declusterByVendor<T>(arr: T[]): T[] {
  const out = [...arr];
  const vendorId = (p: T) => (p as any)?.vendor?.id as string | null | undefined;
  for (let i = 1; i < out.length; i++) {
    const prevVendor = vendorId(out[i - 1]);
    if (!prevVendor || vendorId(out[i]) !== prevVendor) continue;
    const swapIdx = out.findIndex((p, idx) => idx > i && vendorId(p) !== prevVendor);
    if (swapIdx !== -1) {
      [out[i], out[swapIdx]] = [out[swapIdx], out[i]];
    }
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

/** Helper pour extraire le prix de livraison selon la zone */
const getShippingPrice = (metaData: Array<any>, zone: string) => {
  if (!metaData || !Array.isArray(metaData)) return 0;
  
  // Tentative 1: Clé spécifique à la zone (ex: _miad_ship_price_zone_AF)
  const zoneKey = `_miad_ship_price_zone_${zone}`;
  const zoneMeta = metaData.find(m => m.key === zoneKey);
  if (zoneMeta && zoneMeta.value && zoneMeta.value !== "") return parseFloat(zoneMeta.value);

  // Tentative 2: Clé par défaut (_miad_ship_price_zone_)
  const defaultMeta = metaData.find(m => m.key === '_miad_ship_price_zone_');
  if (defaultMeta && defaultMeta.value && defaultMeta.value !== "") return parseFloat(defaultMeta.value);

  return 50.67; // Fallback MIAD : Sécurité anti-gratuité (Valeur mise à jour)
};

export async function GET(req: Request) {
  // Détection automatique du pays via Vercel Edge
  const headerList = await headers();
  const detectedCountry = headerList.get('x-vercel-ip-country') || headerList.get('cf-ipcountry') || 'SN';

  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category')
  const vendor = searchParams.get('vendor')
  const search = searchParams.get('search')
  const id = searchParams.get('id') // Support pour un produit unique par ID
  const slug = searchParams.get('slug') // Support pour un produit unique par slug
  const includeVariations = searchParams.get('variations') === 'true'
  const refresh = searchParams.get('refresh') === 'true' // Bypass cache
  const orderby = searchParams.get('orderby') // ex: 'popularity', 'date', 'rating'
  const random = searchParams.get('random') === 'true' // affichage aléatoire stable (flux accueil)
  const seed   = searchParams.get('seed') || ''         // graine de session — même graine = même ordre

  // WooCommerce REST API permet un maximum de 100 articles par page
  let perPage = parseInt(searchParams.get('per_page') || '100');
  if (perPage > 100) perPage = 100;

  const page     = searchParams.get('page') || '1';

  const lang     = searchParams.get('lang')
  const userCountry = searchParams.get('userCountry'); // Get user's detected country
  const continent = getContinentFromCountry(userCountry || detectedCountry);
  const zone     = searchParams.get('zone') || continent;

  const cacheStrategy = refresh ? 0 : 3600; // Si refresh=true, on force revalidate: 0

  // Clé de secours KV : une entrée par combinaison de filtres effectivement demandée
  // (mêmes searchParams que la requête, hors le drapeau refresh qui ne change pas les données).
  const kvKey = `products:${[...searchParams.entries()].filter(([k]) => k !== 'refresh').sort().map(([k, v]) => `${k}=${v}`).join('&')}`

  try {
    if (!WOO_CK || !WOO_CS) throw new Error("API Keys missing");

    const auth = Buffer.from(`${WOO_CK}:${WOO_CS}`).toString('base64');
    
    let apiPath = `${WOO_URL}/wp-json/wc/v3/products`;
    if (id) {
      apiPath += `/${id}`;
    }

    // Filtre par vendeur : ni wc/v3/products?author=X ni l'endpoint dédié
    // Dokan (/wp-json/dokan/v1/stores/{id}/products) ne filtrent réellement
    // par vendeur sur ce site — constaté le 2026-07-10, l'endpoint Dokan
    // renvoyait toujours les produits du vendeur 95 quel que soit le {id}
    // demandé, faisant apparaître les autres boutiques avec des produits
    // qui ne leur appartiennent pas (ou une liste tronquée après filtrage
    // client). On récupère donc d'abord les IDs du vendeur via une requête
    // SQL directe (plugin miad-products-api.php), puis on filtre le wc/v3
    // standard avec include=id1,id2,... (paramètre documenté et fiable).
    let vendorPageIds: number[] | null = null;
    let vendorTotalCount = 0;
    if (!id && vendor) {
      const idsRes = await fetch(`${MIAD_PRODUCTS_API}/vendor-product-ids?vendorId=${vendor}`, {
        headers: { 'x-miad-products-secret': MIAD_PRODUCTS_SECRET, 'Accept': 'application/json' },
        next: { revalidate: cacheStrategy, tags: ['products', `vendor-${vendor}`] },
      });
      const idsData: any = idsRes.ok ? await idsRes.json().catch(() => ({})) : {};
      const allVendorIds: number[] = idsData.ids || [];
      vendorTotalCount = allVendorIds.length;
      const startIdx = (parseInt(page) - 1) * perPage;
      vendorPageIds = allVendorIds.slice(startIdx, startIdx + perPage);

      if (vendorPageIds.length === 0) {
        return NextResponse.json({ products: [], total: vendorTotalCount, pages: Math.max(1, Math.ceil(vendorTotalCount / perPage)) });
      }
    }

    // Le paramètre `category` de wc/v3/products attend un ID de terme, pas un
    // slug — or tous les appelants côté frontend (CategoryPage, bannières
    // homepage) envoient un slug. Ça filtrait silencieusement sur un ID
    // invalide et renvoyait une liste vide (constaté le 2026-07-11 : bannière
    // catégorie → "aucun produit"). On résout donc le slug en ID ici.
    let categoryId: string | null = null;
    if (!id && category) {
      if (/^\d+$/.test(category)) {
        categoryId = category;
      } else {
        const catLookupUrl = new URL(`${WOO_URL}/wp-json/wc/v3/products/categories`);
        catLookupUrl.searchParams.append('slug', category);
        if (lang) catLookupUrl.searchParams.append('lang', lang);
        const catRes = await fetch(catLookupUrl.toString(), {
          headers: {
            'Authorization': `Basic ${auth}`,
            'X-Headless-Secret': INTERNAL_SECRET,
            'User-Agent': 'MIAD-Headless-Client',
            'Accept': 'application/json',
          },
          next: { revalidate: 3600, tags: ['categories'] },
        });
        const catData = catRes.ok ? await catRes.json().catch(() => []) : [];
        categoryId = Array.isArray(catData) && catData[0]?.id ? String(catData[0].id) : null;
      }
    }

    // Tri aléatoire stable : uniquement sur le flux global (pas de vendor/id/slug
    // déjà filtré) et seulement si le client a fourni une graine de session.
    // Même principe que vendorPageIds ci-dessus (fetch des IDs, puis include=),
    // mais sur l'ensemble du catalogue filtré (catégorie/recherche/langue).
    let randomPageIds: number[] | null = null;
    let randomTotalCount = 0;
    if (!id && !vendor && random && seed) {
      const allIds = await fetchAllProductIds({ wooUrl: WOO_URL, auth, lang, categoryId, search, cacheStrategy });
      randomTotalCount = allIds.length;
      const shuffled = seededShuffle(allIds, seed);
      const startIdx = (parseInt(page) - 1) * perPage;
      randomPageIds = shuffled.slice(startIdx, startIdx + perPage);

      if (randomPageIds.length === 0) {
        return NextResponse.json({ products: [], total: randomTotalCount, pages: Math.max(1, Math.ceil(randomTotalCount / perPage)) });
      }
    }

    const apiUrl = new URL(apiPath);

    if (!id) {
      apiUrl.searchParams.append('per_page', perPage.toString());
      apiUrl.searchParams.append('page', (vendorPageIds || randomPageIds) ? '1' : page); // include= est déjà la bonne tranche, page=1 sur ce sous-ensemble
      apiUrl.searchParams.append('status', 'publish');
      if (slug) apiUrl.searchParams.append('slug', slug);
      if (categoryId) apiUrl.searchParams.append('category', categoryId);
      if (search) apiUrl.searchParams.append('search', search);
      if (orderby) apiUrl.searchParams.append('orderby', orderby);
      if (vendorPageIds) {
        apiUrl.searchParams.append('include', vendorPageIds.join(','));
      } else if (randomPageIds) {
        apiUrl.searchParams.append('include', randomPageIds.join(','));
        // orderby=include : sans ça WooCommerce retombe sur son tri par défaut
        // (date) et ignore l'ordre mélangé qu'on vient de calculer.
        apiUrl.searchParams.append('orderby', 'include');
      }
    }

    // Transmission de la langue à WooCommerce (indispensable pour filtrer les versions FR/EN)
    if (lang) apiUrl.searchParams.append('lang', lang);

    const response = await fetch(apiUrl.toString(), {
      headers: {
        'Authorization': `Basic ${auth}`,
        'User-Agent': 'MIAD-Headless-Client',
        'X-Headless-Secret': INTERNAL_SECRET,
        'Accept': 'application/json',
      },
      next: { revalidate: cacheStrategy, tags: ['products', `products-${lang || 'fr'}`] },
    });

    // Récupération des headers de pagination de WordPress pour le frontend —
    // sauf en mode vendeur, où on connaît déjà le vrai total via vendor-product-ids
    // (X-WP-Total sur une requête include= ne reflète que ce sous-ensemble).
    const totalProducts = vendorPageIds
      ? String(vendorTotalCount)
      : randomPageIds
      ? String(randomTotalCount)
      : response.headers.get('x-wp-total');
    const totalPages = vendorPageIds
      ? String(Math.max(1, Math.ceil(vendorTotalCount / perPage)))
      : randomPageIds
      ? String(Math.max(1, Math.ceil(randomTotalCount / perPage)))
      : response.headers.get('x-wp-totalpages');

    // Si le statut est 202, c'est un blocage anti-bot SiteGround/Cloudflare
    if (response.status === 202) {
      console.error("[API Products] Blocage de sécurité (Challenge 202) détecté sur WordPress.");
      return NextResponse.json({
        error: `Le pare-feu WordPress (SiteGround Anti-Bot) bloque la connexion. Statut: ${response.status}` 
      }, { status: 502 });
    }

    const text = await response.text();

    // Vérification si la réponse est du HTML (signe d'un blocage WAF ou erreur serveur)
    if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html') || text.includes('sgcaptcha')) {
      return NextResponse.json({
        error: `Le serveur WordPress a bloqué la requête ou est en erreur. Statut: ${response.status}` 
      }, { status: 502 });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error("Réponse serveur invalide (JSON attendu mais illisible).");
    }

    if (!response.ok) {
      // Log la réponse complète pour les erreurs 5xx afin de faciliter le diagnostic côté WordPress
      if (response.status >= 500 && response.status < 600) {
        return NextResponse.json({ products: [], error: 'Serveur indisponible' }, { status: 503 }); 
      }
      throw new Error(data.message || `Erreur API WooCommerce: ${response.status}`);
    }

    // Si on a un ID, data est un objet. Sinon c'est un tableau.
    const rawProducts = Array.isArray(data) ? data : [data];

    // Si on a besoin des variations pour un produit variable (single fetch par ID ou slug)
    let variationsMap: Record<number, any[]> = {};
    if (includeVariations) {
      const fetchVariations = async (productId: number | string) => {
        // Pas de filtre 'lang' ici : les variations n'ont pas de traduction propre
        // (seul le produit parent en a) — WPML renvoie une liste vide si on le transmet.
        const varUrl = new URL(`${WOO_URL}/wp-json/wc/v3/products/${productId}/variations`);
        varUrl.searchParams.append('per_page', '100');
        const varRes = await fetch(varUrl.toString(), {
          headers: {
            'Authorization': `Basic ${auth}`,
            'X-Headless-Secret': INTERNAL_SECRET,
            'User-Agent': 'MIAD-Headless-Client',
            'Accept': 'application/json',
          },
          next: { revalidate: cacheStrategy, tags: ['products', `product-${productId}`] }
        });
        return varRes.ok ? await varRes.json() : [];
      };

      const variableProducts = rawProducts.filter((p: any) => p.type === 'variable');
      await Promise.all(variableProducts.map(async (p: any) => {
        let variations = await fetchVariations(p.id);

        // WPML ne duplique pas toujours les variations lors de la traduction d'un
        // produit : la traduction peut avoir 0 variante alors que l'original (ou
        // une autre langue) en a. On retombe alors sur la première traduction
        // sœur qui en a réellement, plutôt que d'afficher un produit sans tailles.
        if (variations.length === 0 && p.translations && typeof p.translations === 'object') {
          for (const altId of Object.values(p.translations) as (string | number)[]) {
            if (String(altId) === String(p.id)) continue;
            const altVariations = await fetchVariations(altId);
            if (altVariations.length > 0) {
              variations = altVariations;
              break;
            }
          }
        }

        variationsMap[p.id] = variations;
      }));
    }

    // Dokan ne reflète jamais l'URL CDN pour gravatar/banner (incident du
    // 2026-07-04, reconfirmé le 2026-07-14 — voir CLAUDE.md). Override manuel
    // posé depuis WP Admin ("Images Vendeurs"), même mécanisme que
    // app/api/stores/route.ts.
    let vendorImageOverrides: Record<string, { logo?: string; banner?: string }> = {}
    try {
      const ovRes = await fetch(`${MIAD_PRODUCTS_API}/vendor-image-overrides`, {
        headers: { 'Accept': 'application/json' },
        next: { revalidate: 300 },
      })
      if (ovRes.ok) {
        const ovData: any = await ovRes.json().catch(() => ({}))
        vendorImageOverrides = ovData.overrides || {}
      }
    } catch {}

    const mapProduct = (p: any) => ({
      id: p.id || null,
      name: p.name || '',
      slug: p.slug || '',
      sku: p.sku || '',
      description: p.description || '',
      price: parseFloat(p.price || "0"),
      regularPrice: parseFloat(p.regular_price || p.price || "0"),
      salePrice: p.sale_price ? parseFloat(p.sale_price) : undefined,
      onSale: p.on_sale,
      image: p.images?.[0]?.src || '/placeholder.svg',
      images: p.images?.map((img: any) => img.src) || [],
      categories: p.categories?.map((cat: any) => ({ name: cat.name || '', slug: cat.slug || '' })) || [],
      category: p.categories?.[0]?.name || 'Général',
      categorySlug: p.categories?.[0]?.slug || '',
      stock: p.stock_quantity ?? 0,
      inStock: p.stock_status === 'instock',
      manageStock: p.manage_stock,
      rating: parseFloat(p.average_rating || '0'),
      salesCount: p.rating_count || 0,
      lang: (lang || 'fr') as 'fr' | 'en',
      countryCode: getCountryCode(p.store),
      shippingPrice: getShippingPrice(p.meta_data || [], zone),
      meta_data: p.meta_data || [],
      attributes: p.attributes?.map((attr: any) => ({
        name: attr.name || '',
        label: attr.name || '',
        options: attr.options || [],
        variation: !!attr.variation,
        visible: !!attr.visible
      })) || [],
      defaultAttributes: p.default_attributes?.map((def: any) => ({
        name: def.name || '',
        option: def.option || ''
      })) || [],
      vendor: p.store ? {
        id: p.store.id?.toString() || null,
        name: p.store.shop_name || p.store.store_name || p.store.name || 'Boutique',
        slug: p.store.shop_url?.split('/').filter(Boolean).pop() || '',
        address: p.store.address || {},
        countryCode: getCountryCode(p.store),
        rating: parseFloat(p.store.rating || '0'),
        logo: vendorImageOverrides[String(p.store.id)]?.logo || p.store.avatar || p.store.gravatar || '',
        banner: vendorImageOverrides[String(p.store.id)]?.banner || p.store.banner || '',
        productCount: p.store.product_count || 0 // Ajout du nombre de produits du vendeur
      } : null,
      type: p.type,
      variations: variationsMap[p.id]?.map((v: any) => ({
        id: v.id.toString(),
        price: parseFloat(v.price || "0"),
        regularPrice: parseFloat(v.regular_price || v.price || "0"),
        salePrice: v.sale_price ? parseFloat(v.sale_price) : undefined,
        sku: v.sku,
        inStock: v.stock_status === 'instock',
        stock: v.stock_quantity || 0,
        image: v.image?.src || (Array.isArray(p.images) && p.images[0]?.src) || '',
        attributes: v.attributes?.map((a: any) => ({
          name: a.name || '',
          option: a.option || ''
        })) || [],
        shippingPrice: getShippingPrice(v.meta_data || p.meta_data || [], zone)
      })) || p.variations || []
    });

    let products = rawProducts.map(mapProduct);

    // Recherche mot-clé WooCommerce en complément par la recherche sémantique :
    // "search" ne trouve que les produits dont le nom/description contient
    // littéralement le terme tapé — chercher "chaussure" ratait "Mocassins en
    // cuir" ou "Babouches artisanales", qui ne contiennent jamais ce mot mais
    // sont bien des chaussures (signalé le 2026-07-31). En complément (pas en
    // remplacement, pour garder les correspondances exactes en tête de liste),
    // on interroge Vectorize et on ajoute les produits trouvés par le sens qui
    // manquaient à la recherche mot-clé. Best-effort : si les bindings
    // Cloudflare AI ne sont pas disponibles (dev local) ou que l'appel échoue,
    // on garde simplement les résultats mot-clé, comme avant.
    if (search && !id) {
      try {
        const bindings = await getCloudflareBindings()
        if (bindings) {
          const vector = await embedOne(bindings.ai, search)
          const result = await bindings.vectorize.query(vector, { topK: 30, returnMetadata: 'none' })
          const existingIds = new Set(products.map((p: any) => String(p.id)))
          // Filtre par score minimal — signale le 2026-08-21 : sans seuil, les
          // 30 "meilleurs" voisins vectoriels incluaient des produits sans
          // rapport (ex: recherche "sac" faisait remonter des poudres
          // d'epices, un chapelet, un Coran...) simplement parce qu'ils
          // etaient les moins mauvais parmi topK, pas parce qu'ils etaient
          // vraiment pertinents. 0.72 laisse passer les vrais synonymes
          // (chaussure -> mocassin/babouche) tout en coupant le bruit.
          const SEMANTIC_MIN_SCORE = 0.72
          const newIds = result.matches
            .filter(m => (m.score ?? 0) >= SEMANTIC_MIN_SCORE)
            .map(m => m.id)
            .filter(mid => !existingIds.has(String(mid)))
          if (newIds.length > 0) {
            const semanticRaw = await fetchWooProductsByIds(newIds, (lang as 'fr' | 'en') || 'fr')
            // Re-dédoublonnage sur le résultat final (pas seulement sur newIds) :
            // WPML peut renvoyer la traduction sœur d'un ID demandé plutôt que le
            // filtrer, donc un match sémantique sur la version EN d'un produit
            // déjà présent en FR peut ressortir avec le MÊME id FR après ce fetch
            // — constaté en prod le 2026-07-31 (produits "BABOUCHES CUIR" dupliqués).
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
    }

    const responseData = {
      products: products,
      total: totalProducts ? Math.max(parseInt(totalProducts), products.length) : products.length,
      pages: totalPages ? parseInt(totalPages) : 1
    };

    // Écriture du cache de secours : si WordPress tombe juste après, cette combinaison
    // de filtres pourra quand même être servie depuis KV (voir le catch ci-dessous).
    await catalogCacheSet(kvKey, responseData)

    return NextResponse.json(responseData, {
      headers: {
        // Cache CDN 5 min (au lieu de 10s) pour eviter de marteler WooCommerce a chaque visite ;
        // stale-while-revalidate garde le cache jusqu'a 1 an si le backend tombe
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=31536000'
      }
    });

  } catch (error: any) {
    // WordPress est inaccessible : on tente de servir la dernière version connue de
    // cette même combinaison de filtres depuis le cache de secours KV avant d'abandonner.
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

    // IMPORTANT: On ne renvoie PAS de tableau vide ici pour ne pas purger le cache du client
    // On renvoie un code 503 sans tableau 'products' pour que SWR garde les données actuelles
    return NextResponse.json(
      { error: "Le serveur est saturé, conservation des données locales." },
      { status: error.status === 401 ? 401 : 503 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json()

    // Action admin : réassigner l'auteur (vendeur) de plusieurs produits
    if (body.action === 'set_author') {
      const { ids, author, secret } = body
      if (secret !== INTERNAL_SECRET) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
      if (!WOO_CK || !WOO_CS) return NextResponse.json({ error: 'API Keys missing' }, { status: 500 })
      if (!Array.isArray(ids) || !ids.length || !author) return NextResponse.json({ error: 'ids[] et author requis' }, { status: 400 })
      const auth = Buffer.from(`${WOO_CK}:${WOO_CS}`).toString('base64')
      const res = await fetch(`${WOO_URL}/wp-json/wc/v3/products/batch`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'User-Agent': 'MIAD-Headless-Client' },
        body: JSON.stringify({ update: ids.map((id: number) => ({ id, author })) }),
      })
      const data = await res.json()
      if (!res.ok) return NextResponse.json({ error: data.message || 'Erreur WooCommerce batch' }, { status: res.status })
      return NextResponse.json({ success: true, updated: data.update?.length ?? 0 })
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
    }

    // Récupérer le userId du vendeur connecté via son token JWT
    const meRes = await fetch(`${WOO_URL}/wp-json/wp/v2/users/me`, {
      headers: { Authorization: authHeader, 'User-Agent': 'MIAD-Headless-Client' },
      cache: 'no-store',
    })
    if (!meRes.ok) return NextResponse.json({ error: 'Session invalide' }, { status: 401 })
    const me = await meRes.json()
    const vendorUserId: number = me.id

    const basicAuth = 'Basic ' + Buffer.from(`${WOO_CK}:${WOO_CS}`).toString('base64')

    const productType = body.type || 'simple'
    const regularPrice = body.regularPrice || body.price || '0'
    const salePrice = body.salePrice || ''

    const productData: Record<string, any> = {
      name:           body.name,
      type:           productType,
      status:         'publish',
      author:         vendorUserId,          // ← associer le produit au vendeur
      regular_price:  String(regularPrice),
      sale_price:     String(salePrice),
      description:    body.description || '',
      manage_stock:   true,
      stock_quantity: parseInt(body.stock) || 0,
    }

    // Images
    const images = []
    if (body.mainImageId)  images.push({ id: body.mainImageId })
    else if (body.mainImage) images.push({ src: body.mainImage })
    for (const id of (body.galleryImageIds || [])) images.push({ id })
    if (images.length > 0) productData.images = images

    // Catégorie
    if (body.category) productData.categories = [{ slug: body.category }]

    // Attributs
    if (Array.isArray(body.attributes) && body.attributes.length > 0) {
      productData.attributes = body.attributes.map((a: any, i: number) => ({
        name:      a.name,
        position:  i,
        visible:   true,
        variation: productType === 'variable',
        options:   typeof a.options === 'string'
          ? a.options.split(',').flatMap((o: string) => {
              const trimmed = o.trim()
              return trimmed ? [trimmed] : []
            })
          : (a.options || []),
      }))
    }

    const res = await fetch(`${WOO_URL}/wp-json/wc/v3/products`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth,
        'Content-Type': 'application/json',
        'User-Agent': 'MIAD-Headless-Client',
      },
      body: JSON.stringify(productData),
    })

    const data = await res.json()
    if (!res.ok) return NextResponse.json({ error: data.message || 'Erreur WooCommerce' }, { status: res.status })
    return NextResponse.json(data, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// PATCH /api/products — réassigner l'auteur (vendeur) de plusieurs produits en une fois
// Body: { ids: number[], author: number, secret: string }
export async function PATCH(req: Request) {
  try {
    if (!WOO_CK || !WOO_CS) return NextResponse.json({ error: 'API Keys missing' }, { status: 500 })
    const body = await req.json()
    const { ids, author, secret } = body
    if (secret !== INTERNAL_SECRET) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
    if (!Array.isArray(ids) || !ids.length || !author) return NextResponse.json({ error: 'ids[] et author requis' }, { status: 400 })
    const auth = Buffer.from(`${WOO_CK}:${WOO_CS}`).toString('base64')
    const batchUrl = `${WOO_URL}/wp-json/wc/v3/products/batch`
    const res = await fetch(batchUrl, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'User-Agent': 'MIAD-Headless-Client' },
      body: JSON.stringify({ update: ids.map((id: number) => ({ id, author })) }),
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ error: data.message || 'Erreur WooCommerce' }, { status: res.status })
    return NextResponse.json({ success: true, updated: data.update?.length ?? 0 })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

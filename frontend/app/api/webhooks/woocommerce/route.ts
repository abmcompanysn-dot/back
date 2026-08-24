import { NextResponse } from 'next/server';
import { revalidatePath, revalidateTag } from 'next/cache';

export const runtime = 'edge';

/**
 * Webhook de Synchronisation MIAD v3
 * Gère la synchronisation multi-sites des produits, variations et métadonnées de livraison.
 */

// On utilise le secret interne défini dans ton application (Header.tsx / login route)
import { requireEnv } from '@/lib/require-env'
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

export async function POST(req: Request) {
  try {
    // Vérification de sécurité avec le secret partagé
    const incomingSecret = req.headers.get('X-Headless-Secret') || 
                           req.headers.get('X-MIAD-Secret') || 
                           req.headers.get('x-wc-webhook-secret');

    if (incomingSecret !== INTERNAL_SECRET) {
      console.error('[Sync] Accès refusé : Secret incorrect');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const data = await req.json();
    const topic = req.headers.get('x-wc-webhook-topic') || data.action || 'product.updated';
    const productId = data.id;
    const lang = data.lang || 'fr'; // On récupère la langue

    console.log(`[Sync Miad] Reçu : ${topic} [${lang.toUpperCase()}] pour l'ID ${productId} (${data.name})`);

    switch (topic) {
      case 'product.created':
      case 'product.updated':
        const productSyncData = {
          wooId: data.id,
          name: data.name,
          slug: data.slug,
          description: data.description || '',
          shortDescription: data.short_desc || '',
          price: parseFloat(data.price || "0"),
          regularPrice: parseFloat(data.regular_price || "0"),
          sku: data.sku,
          type: data.type,
          lang: lang,
          image: data.image || (data.images && data.images[0]?.src) || '',
          gallery: data.gallery || [],
          inStock: data.stock_status === 'instock' || data.stock_status === 'onbackorder',
          stockQty: data.stock_qty || 0,
          vendorId: data.vendor_id?.toString() || data.store?.id?.toString() || null,
          categories: data.categories?.map((c: any) => c.slug) || [],
          attributes: data.attributes || [],
          vendor: data.vendor_id ? { id: data.vendor_id } : null,
          // Extraction des 3 tarifs de livraison depuis les meta_data de WooCommerce
          shippingMeta: {
            standard: data.meta_data?.find((m: any) => m.key === '_shipping_standard_price')?.value || "0",
            express: data.meta_data?.find((m: any) => m.key === '_shipping_express_price')?.value || "0",
            dhl: data.meta_data?.find((m: any) => m.key === '_shipping_dhl_price')?.value || "0"
          }
        };

        console.log(`[Sync] Mise à jour du produit : ${productSyncData.name} (ID: ${productId})`);

        // TRAITEMENT DES VARIATIONS
        if (data.variations && Array.isArray(data.variations)) {
          console.log(`[Sync] Traitement de ${data.variations.length} variations pour ce produit.`);
          
          data.variations.forEach((v: any) => {
            // Ici tu extrais les détails de chaque option (ex: Taille: XL, Couleur: Rouge)
            const variationData = {
              wooId: v.id,
              sku: v.sku,
              price: parseFloat(v.price || "0"),
              stock: v.stock_status === 'instock' || v.stock_status === 'onbackorder',
              attributes: v.attributes || {}
            };
            
            // Log pour debug (sera visible uniquement dans tes logs Vercel)
            console.log(`  -> Sync Variation ${variationData.sku} | Prix: ${variationData.price}`);
          });
        }

        // ICI : Mise à jour de ta base de données locale (Prisma/autre)
        // await prisma.product.upsert({ where: { wooId: productId }, data: productSyncData });

        // FORCE LA MISE À JOUR DU CACHE NEXT.JS
        // revalidateTag() n'a jamais pris de 2e argument "profil" — accepté en
        // silence par d'anciens typings Next.js (no-op), rejeté en erreur de
        // type stricte depuis la mise à jour vers Next 15.5.21 (2026-08-17,
        // corrigeait 3 CVE haute sévérité). Le vrai scoping par langue passe
        // par le contenu du tag lui-même (`products-${lang}`, tel que posé
        // par app/api/products/route.ts:183) — jamais revalidé jusqu'ici,
        // corrigé au passage.
        revalidatePath('/', 'layout');
        revalidateTag('products');
        revalidateTag(`products-${lang || 'fr'}`);
        if (productId) {
          revalidateTag(`product-${productId}`);
        }
        
        console.log(`[Sync] Cache purgé pour le produit ${productId}`);

        break;

      case 'product.deleted':
        console.log(`[Sync] Suppression du produit ID : ${productId}`);
        // await prisma.product.delete({ where: { wooId: productId } });
        revalidatePath('/', 'layout');
        break;

      default:
        console.log(`[Sync] Action non gérée : ${topic}`);
    }

    // On répond toujours 200 à WooCommerce
    return NextResponse.json({ 
      success: true,
      message: 'Sync successful',
      id: productId
    }, { status: 200 });

  } catch (error: any) {
    console.error('[Sync Exception]', error.message);
    return NextResponse.json({ error: 'Sync Failed' }, { status: 500 });
  }
}

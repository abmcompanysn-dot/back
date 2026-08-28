import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fetchProductBySlug } from '@/lib/woo-server'
import { ProductDetailWrapper } from '@/components/miad/ProductDetailWrapper'
import { formatPrice } from '@/lib/woocommerce'
import { COUNTRY_TO_ZONE, ZONE_SHIPPING_RATES } from '@/lib/shipping-utils'

export const runtime = 'edge';

interface ProductPageProps {
  params: Promise<{ slug: string }>
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://miadmarket.ca'

// Regroupe COUNTRY_TO_ZONE (lib/shipping-utils.ts) par zone, pour le JSON-LD
// "shippingDetails" — un OfferShippingDetails par zone MIAD réelle plutôt
// que des chiffres inventés, avec le tarif standard le plus bas de la
// fourchette de la zone (ZONE_SHIPPING_RATES) en "à partir de".
const ZONE_COUNTRIES = Object.entries(COUNTRY_TO_ZONE).reduce<Record<string, string[]>>((acc, [code, zone]) => {
  (acc[zone] ||= []).push(code)
  return acc
}, {})

// Délais transporteur estimés par zone (jours ouvrés) — cohérents avec les
// fourchettes déjà affichées sur la fiche produit (cf. ProductDetail.tsx :
// livraison locale ~3-7j, zone Afrique/international jusqu'à ~15j).
const ZONE_TRANSIT_DAYS: Record<string, { min: number; max: number }> = {
  AF: { min: 5, max: 15 },
  EU: { min: 7, max: 18 },
  NA: { min: 7, max: 18 },
  SA: { min: 10, max: 20 },
  AS: { min: 10, max: 20 },
  OC: { min: 12, max: 22 },
}

export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  const { slug } = await params
  const product = await fetchProductBySlug(slug)

  if (!product) return { title: 'Produit non trouvé - MIAD Market' }

  const productUrl = `${SITE_URL}/product/${product.slug || slug}`

  const mainImage = product.images?.[0] || product.image
  const hasRealImage = mainImage?.startsWith('http')
  const ogImage = hasRealImage ? mainImage : `${SITE_URL}/api/og`

  const productDescription = product.description
    ?.replace(/<[^>]*>/g, '')
    .trim()
    .substring(0, 120)

  const callToAction = `Découvrez ${product.name} sur MIAD Market — la marketplace africaine qui réunit les meilleurs produits du continent. Commandez maintenant !`

  const description = productDescription
    ? `${formatPrice(product.price)} ${product.currency || '$'} — ${productDescription}`.substring(0, 155)
    : callToAction.substring(0, 155)

  const ogDescription = hasRealImage ? description : callToAction.substring(0, 155)

  return {
    title: `${product.name} | MIAD Market`,
    description,
    openGraph: {
      title: product.name,
      description: ogDescription,
      images: [{ url: ogImage, width: 1200, height: 630, alt: product.name }],
      type: 'website',
      url: productUrl,
      siteName: 'MIAD Market',
    },
    twitter: {
      card: hasRealImage ? 'summary_large_image' : 'summary',
      title: `${product.name} | MIAD Market`,
      description: ogDescription,
      images: [ogImage],
    },
    alternates: { canonical: productUrl },
  }
}

export default async function ProductSlugPage({ params }: ProductPageProps) {
  const { slug } = await params
  const product = await fetchProductBySlug(slug)

  if (!product) notFound()

  const productUrl = `${SITE_URL}/product/${product.slug || slug}`
  const mainImage = product.images?.[0] || product.image

  // Politique de retour réelle du site (Garantie MIAD Protection — voir
  // ProductDetail.tsx "Garantie de remboursement de 7 jours si l'article
  // n'est pas conforme à la description"), requise par Google depuis la mise
  // à jour des données structurées "Merchant listing" (sinon avertissement
  // "hasMerchantReturnPolicy manquant" dans Search Console/Rich Results Test).
  const hasMerchantReturnPolicy = {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: Object.keys(COUNTRY_TO_ZONE),
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: 7,
    returnMethod: 'https://schema.org/ReturnByMail',
    returnFees: 'https://schema.org/FreeReturn',
  }

  // Frais/délais de livraison réels par zone MIAD (lib/shipping-utils.ts) —
  // même avertissement Google que ci-dessus pour "shippingDetails manquant".
  // Un OfferShippingDetails par zone (tarif standard le plus bas de la
  // fourchette, en "à partir de") plutôt qu'une valeur unique inventée.
  const shippingDetails = Object.entries(ZONE_COUNTRIES).map(([zone, countryCodes]) => ({
    '@type': 'OfferShippingDetails',
    shippingRate: {
      '@type': 'MonetaryAmount',
      value: ZONE_SHIPPING_RATES[zone].standardMin,
      currency: 'USD',
    },
    shippingDestination: {
      '@type': 'DefinedRegion',
      addressCountry: countryCodes,
    },
    deliveryTime: {
      '@type': 'ShippingDeliveryTime',
      handlingTime: { '@type': 'QuantitativeValue', minValue: 1, maxValue: 3, unitCode: 'DAY' },
      transitTime: {
        '@type': 'QuantitativeValue',
        minValue: ZONE_TRANSIT_DAYS[zone].min,
        maxValue: ZONE_TRANSIT_DAYS[zone].max,
        unitCode: 'DAY',
      },
    },
  }))

  // Rich snippets Google (prix, disponibilité, note) — sans ça, le produit
  // s'affiche en résultat de recherche basique sans étoiles ni prix visible.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    url: productUrl,
    image: mainImage?.startsWith('http') ? [mainImage] : undefined,
    description: product.description?.replace(/<[^>]*>/g, '').trim().substring(0, 300),
    // Ni GTIN ni MPN disponibles (produits artisanaux/vendeurs multiples,
    // pas de code-barres) — la marque satisfait l'exigence Google d'un
    // "identifiant global" à défaut d'un GTIN (avertissement "Aucun
    // identifiant global fourni"). Boutique du vendeur = la marque la plus
    // fidèle ici, pas "MIAD Market" (qui est la marketplace, pas le fabricant).
    brand: {
      '@type': 'Brand',
      name: product.vendor?.name || 'MIAD Market',
    },
    offers: {
      '@type': 'Offer',
      url: productUrl,
      priceCurrency: product.currency || 'USD',
      price: product.price,
      availability: product.inStock
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      hasMerchantReturnPolicy,
      shippingDetails,
    },
    ...(product.rating && product.rating > 0 && {
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: product.rating.toFixed(1),
        bestRating: '5',
        worstRating: '1',
      },
    }),
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <ProductDetailWrapper product={product} />
    </>
  )
}

import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fetchStores, fetchVendorBySlug, fetchProductsByVendor } from '@/lib/woo-server'
import { VendorStoreWrapper } from '@/components/miad/VendorStoreWrapper'

export const runtime = 'edge';

interface VendorPageProps {
  params: Promise<{ slug: string }>
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://miadmarket.ca'

const findVendor = (stores: any[], slug: string) =>
  stores.find((s) =>
    s.slug === slug ||
    String(s.id) === String(slug) ||
    (s.slug || '').toLowerCase() === slug.toLowerCase()
  )

export async function generateMetadata({ params }: VendorPageProps): Promise<Metadata> {
  const [{ slug }, stores] = await Promise.all([params, fetchStores()])
  // Secours : boutique hors des 100 premières (déjà chargées par
  // fetchStores) — sans ça, une URL /vendor/X pourtant valide affichait un
  // faux "Boutique introuvable" (bug trouvé le 2026-08-28).
  const vendor = findVendor(stores, slug) || (await fetchVendorBySlug(slug))

  if (!vendor) return { title: 'Boutique introuvable - MIAD Market' }

  const vendorUrl = `${SITE_URL}/vendor/${vendor.slug || slug}`
  const countryPart = vendor.country ? ` — ${vendor.country}` : ''
  const description = `Boutique officielle ${vendor.name}${countryPart} sur MIAD Market. Produits africains authentiques, livraison internationale. Achetez en toute confiance.`
  const ogImage = vendor.banner || vendor.logo || `${SITE_URL}/api/og`

  return {
    title: `${vendor.name} | Boutique africaine sur MIAD Market`,
    description,
    keywords: [
      vendor.name,
      'boutique africaine',
      'MIAD Market',
      'produits africains',
      'marché africain en ligne',
      vendor.country || '',
    ].filter(Boolean),
    robots: { index: true, follow: true },
    openGraph: {
      title: `${vendor.name} — Boutique MIAD Market`,
      description,
      images: ogImage
        ? [{ url: ogImage, width: 1200, height: 630, alt: `Boutique ${vendor.name} sur MIAD Market` }]
        : [],
      type: 'website',
      url: vendorUrl,
      siteName: 'MIAD Market',
      locale: 'fr_FR',
    },
    twitter: {
      card: 'summary_large_image',
      title: `${vendor.name} | MIAD Market`,
      description,
      images: ogImage ? [ogImage] : [],
    },
    alternates: {
      canonical: vendorUrl,
      languages: {
        fr: vendorUrl,
        en: `${vendorUrl}?lang=en`,
        'x-default': vendorUrl,
      },
    },
  }
}

export default async function VendorSlugPage({ params }: VendorPageProps) {
  const [{ slug }, stores] = await Promise.all([params, fetchStores()])
  const vendor = findVendor(stores, slug) || (await fetchVendorBySlug(slug))

  if (!vendor) notFound()

  const { products, total, totalPages } = await fetchProductsByVendor(vendor.id)

  const vendorUrl = `${SITE_URL}/vendor/${vendor.slug || slug}`
  const reviewCount = Number(vendor.reviewsCount || vendor.productCount || 0)

  const storeLd: Record<string, unknown> = {
    '@type': 'Store',
    '@id': `${vendorUrl}#store`,
    name: vendor.name,
    url: vendorUrl,
    image: vendor.banner || vendor.logo || undefined,
    description: `Boutique officielle ${vendor.name} sur MIAD Market. Produits africains authentiques avec livraison internationale.`,
    ...(vendor.country && {
      address: { '@type': 'PostalAddress', addressCountry: vendor.country },
    }),
    // aggregateRating uniquement avec un nombre d'avis réel (sinon rejeté).
    ...(vendor.rating > 0 && reviewCount > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: Number(vendor.rating).toFixed(1),
            reviewCount,
            bestRating: '5',
            worstRating: '1',
          },
        }
      : {}),
    parentOrganization: { '@type': 'Organization', name: 'MIAD Market', url: SITE_URL },
  }

  const breadcrumbLd = {
    '@type': 'BreadcrumbList',
    '@id': `${vendorUrl}#breadcrumb`,
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Accueil', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'Boutiques', item: `${SITE_URL}/?v=stores` },
      { '@type': 'ListItem', position: 3, name: vendor.name, item: vendorUrl },
    ],
  }

  const itemListLd =
    products.length > 0
      ? {
          '@type': 'ItemList',
          '@id': `${vendorUrl}#products`,
          numberOfItems: products.length,
          itemListElement: products.slice(0, 48).map((p: any, i: number) => ({
            '@type': 'ListItem',
            position: i + 1,
            url: `${SITE_URL}/product/${p.slug}`,
            name: p.name,
          })),
        }
      : null

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [storeLd, breadcrumbLd, ...(itemListLd ? [itemListLd] : [])],
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <VendorStoreWrapper
        vendor={vendor}
        products={products}
        total={total}
        totalPages={totalPages}
      />
    </>
  )
}

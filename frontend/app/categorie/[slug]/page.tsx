import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fetchCategoryWithProducts } from '@/lib/woo-server'
import { CategoryStoreWrapper } from '@/components/miad/CategoryStoreWrapper'

export const runtime = 'edge'

interface CategoryPageProps {
  params: Promise<{ slug: string }>
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://miadmarket.ca'

function langUrls(slug: string) {
  const path = `/categorie/${slug}`
  return {
    canonical: `${SITE_URL}${path}`,
    languages: {
      fr: `${SITE_URL}${path}`,
      en: `${SITE_URL}${path}?lang=en`,
      'x-default': `${SITE_URL}${path}`,
    },
  }
}

export async function generateMetadata({ params }: CategoryPageProps): Promise<Metadata> {
  const { slug } = await params
  const data = await fetchCategoryWithProducts(slug, 1)
  if (!data) return { title: 'Catégorie introuvable | MIAD Market' }

  const { category, total } = data
  // Pas de suffixe " | MIAD Market" ici : le template du layout
  // (`%s | MIAD Market`) l'ajoute déjà.
  const title = `${category.name} — ${total} produits d'Afrique`
  const description =
    category.description?.replace(/<[^>]*>/g, '').trim().slice(0, 155) ||
    `Achetez ${category.name.toLowerCase()} sur MIAD Market : ${total} produits d'artisans et vendeurs vérifiés d'Afrique. Paiement Wave, Orange Money, carte. Livraison MIAD Express.`

  return {
    title,
    description,
    alternates: langUrls(category.slug),
    openGraph: {
      title,
      description,
      url: `${SITE_URL}/categorie/${category.slug}`,
      siteName: 'MIAD Market',
      locale: 'fr_FR',
      type: 'website',
      images: [{ url: `${SITE_URL}/api/og`, width: 1200, height: 630, alt: category.name }],
    },
    twitter: { card: 'summary_large_image', title, description, images: [`${SITE_URL}/api/og`] },
    robots: { index: true, follow: true },
  }
}

export default async function CategorieSlugPage({ params }: CategoryPageProps) {
  const { slug } = await params
  const data = await fetchCategoryWithProducts(slug, 48)
  if (!data) notFound()

  const { category, products, total } = data
  const url = `${SITE_URL}/categorie/${category.slug}`

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': `${url}#page`,
        url,
        name: `${category.name} — MIAD Market`,
        description:
          category.description?.replace(/<[^>]*>/g, '').trim().slice(0, 300) ||
          `Sélection de ${category.name.toLowerCase()} sur MIAD Market, la marketplace panafricaine.`,
        isPartOf: { '@type': 'WebSite', name: 'MIAD Market', url: SITE_URL },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Accueil', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: category.name, item: url },
        ],
      },
      {
        '@type': 'ItemList',
        '@id': `${url}#products`,
        numberOfItems: products.length,
        itemListElement: products.slice(0, 48).map((p: any, i: number) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: `${SITE_URL}/product/${p.slug}`,
          name: p.name,
        })),
      },
    ],
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <CategoryStoreWrapper
        categoryName={category.name}
        categorySlug={category.slug}
        description={category.description?.replace(/<[^>]*>/g, '').trim()}
        products={products}
        total={total}
      />
    </>
  )
}

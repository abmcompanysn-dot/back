// catalog-feed — logique partagée entre le flux Google Merchant Center
// (/merchant-feed.xml) et le flux Facebook Catalogue (/facebook-feed.xml).
// Les deux plateformes acceptent le même format RSS 2.0 + namespace `g:`.
// Différences gérées par le paramètre `platform` de buildFeed().

import { CATALOG_SVC_URL, VENDOR_SVC_URL, SHIPPING_SVC_URL } from '@/lib/miad-server-auth'
import { feedImage } from '@/lib/feed-image'
import { taxonomyFor } from '@/lib/product-taxonomy'

const BASE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://miadmarket.ca').replace(/\/$/, '')

interface CatalogProduct {
  id: number
  slug: string
  name: string
  subtitle?: string
  description: string
  sku: string
  barcode?: string
  price: string
  regular_price: string
  sale_price: string
  status: string
  stock: number
  vendor_id: number
  images: { src: string }[]
  category_name?: string
  category_slug?: string
  translation_of_id?: number | null
  type?: string
  tags?: string[]
  specifications?: { k: string; v: string }[]
}

// Extrait une valeur des specifications par mots-clés de clé (insensible
// casse/accents). Ex. specValue(p, ['coloris', 'couleur']).
function specValue(p: CatalogProduct, keys: string[]): string {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  for (const spec of p.specifications || []) {
    if (keys.some((k) => norm(spec.k).includes(k))) return spec.v
  }
  return ''
}

// Image "produit" propre pour g:image_link : Google veut PNG/JPG/WEBP en
// image principale (AVIF accepté seulement en additional_image_link). On
// choisit donc la 1re image non-AVIF ; à défaut, la 1re tout court.
function primaryImage(images: { src: string }[]): string {
  const nonAvif = images.find((i) => i.src && !/\.avif(\?|$)/i.test(i.src))
  return (nonAvif || images[0])?.src || ''
}

function escapeXml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

async function fetchAllProducts(): Promise<CatalogProduct[]> {
  const PER_PAGE = 100
  const MAX_PAGES = 50
  const all: CatalogProduct[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${CATALOG_SVC_URL}/products?page=${page}&page_size=${PER_PAGE}&lang=fr`, { next: { revalidate: 3600 } })
    if (!res.ok) break
    const data: any = await res.json().catch(() => ({}))
    const batch: CatalogProduct[] = data.items || []
    all.push(...batch)
    if (!data.has_more || batch.length < PER_PAGE) break
  }
  return all
}

async function fetchVendorNames(ids: number[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  if (ids.length === 0) return map
  const res = await fetch(`${VENDOR_SVC_URL}/stores?page_size=100`, { next: { revalidate: 3600 } })
  if (res.ok) {
    const d: any = await res.json().catch(() => ({}))
    for (const s of d.items || d.stores || []) map[String(s.id)] = s.store_name || s.name || 'Boutique'
  }
  return map
}

// Livraison affichée dans le flux : tarif standard Afrique de la config
// unifiée (shipping-svc /shipping/config) — plus de valeur en dur. Repli
// 12 USD si injoignable.
async function fetchShippingStandardAF(): Promise<number> {
  try {
    const r = await fetch(`${SHIPPING_SVC_URL}/shipping/config`, { next: { revalidate: 3600, tags: ['shipping-config'] } })
    if (r.ok) {
      const c = await r.json()
      const v = c?.zones?.AF?.standard
      if (typeof v === 'number' && v > 0) return v
    }
  } catch { /* repli */ }
  return 12
}

type Platform = 'google' | 'facebook'

function buildItem(
  p: CatalogProduct,
  vendorNames: Record<string, string>,
  shippingAF: number,
  platform: Platform
): string {
  if (!p.slug) return ''
  const main = primaryImage(p.images || [])
  if (!main) return ''

  const price = parseFloat(p.price || p.regular_price || '0')
  if (!price) return ''

  const title = escapeXml(p.name)
  // Description : la vraie si elle existe, sinon sous-titre, sinon un
  // fallback lisible (nom + catégorie) plutôt que juste le nom répété —
  // Google pénalise une description = titre.
  const realDesc = stripHtml(p.description || '')
  const fallbackDesc = [p.name, p.category_name].filter(Boolean).join(' — ')
  const rawDesc = realDesc || stripHtml(p.subtitle || '') || fallbackDesc
  const description = escapeXml(rawDesc.slice(0, platform === 'facebook' ? 9999 : 5000))
  const link = `${BASE}/product/${p.slug}`
  const imageLink = escapeXml(feedImage(main, 800))
  const additionalImages = (p.images || [])
    .filter((img) => img.src && img.src !== main)
    .slice(0, 10)
    .map((img) => `      <g:additional_image_link>${escapeXml(feedImage(img.src, 800))}</g:additional_image_link>`)
    .join('\n')

  const onSale =
    p.sale_price && parseFloat(p.sale_price) > 0 && parseFloat(p.sale_price) < parseFloat(p.regular_price || '0')
  const listPrice = onSale ? parseFloat(p.regular_price) : price
  const availability = p.stock > 0 ? 'in stock' : 'out of stock'
  const brand = escapeXml(vendorNames[String(p.vendor_id)] || 'MIAD Market')

  const taxo = taxonomyFor(p.category_slug || p.category_name)
  const productType = escapeXml(p.category_name || '')
  const isApparel = /vetement|mode|chaussure|sac|accessoire/i.test(
    (p.category_slug || p.category_name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  )

  // Attributs produit — Google les attend sur les vêtements/accessoires.
  const color = specValue(p, ['coloris', 'couleur', 'color'])
  const size = specValue(p, ['taille', 'pointure', 'size'])
  const material = specValue(p, ['matiere', 'matériau', 'composition', 'tissu'])
  const apparelAttrs = isApparel
    ? [
        `      <g:age_group>adult</g:age_group>`,
        `      <g:gender>unisex</g:gender>`,
        color ? `      <g:color>${escapeXml(color)}</g:color>` : '',
        size ? `      <g:size>${escapeXml(size)}</g:size>` : '',
        material ? `      <g:material>${escapeXml(material)}</g:material>` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : ''

  // Regroupe une traduction/variante avec son parent (Google & FB veulent
  // un item_group_id commun pour les variantes d'un même produit).
  const groupId = p.translation_of_id ? String(p.translation_of_id) : String(p.id)

  const identifiers = p.sku
    ? `      <g:mpn>${escapeXml(p.sku)}</g:mpn>\n      <g:identifier_exists>yes</g:identifier_exists>`
    : `      <g:identifier_exists>no</g:identifier_exists>`
  const gtin = p.barcode ? `      <g:gtin>${escapeXml(p.barcode)}</g:gtin>` : ''

  return `
    <item>
      <g:id>${p.id}</g:id>
      <g:item_group_id>${groupId}</g:item_group_id>
      <title>${title}</title>
      <description>${description}</description>
      <link>${link}</link>
      <g:image_link>${imageLink}</g:image_link>
${additionalImages}
      <g:condition>new</g:condition>
      <g:availability>${availability}</g:availability>
      <g:price>${listPrice.toFixed(2)} USD</g:price>
      ${onSale ? `<g:sale_price>${price.toFixed(2)} USD</g:sale_price>` : ''}
      <g:brand>${brand}</g:brand>
      <g:google_product_category>${taxo.googleId}</g:google_product_category>
      ${platform === 'facebook' ? `<g:fb_product_category>${escapeXml(taxo.fbPath)}</g:fb_product_category>` : ''}
      ${productType ? `<g:product_type>${productType}</g:product_type>` : ''}
${apparelAttrs}
${gtin}
${identifiers}
      <g:shipping>
        <g:country>SN</g:country>
        <g:service>MIAD Standard</g:service>
        <g:price>${shippingAF.toFixed(2)} USD</g:price>
      </g:shipping>
    </item>`
}

export async function buildFeed(platform: Platform): Promise<string> {
  const [products, shippingAF] = await Promise.all([fetchAllProducts(), fetchShippingStandardAF()])
  const vendorIds = Array.from(new Set(products.map((p) => p.vendor_id).filter(Boolean)))
  const vendorNames = await fetchVendorNames(vendorIds)

  const items = products
    .flatMap((p) => {
      const it = buildItem(p, vendorNames, shippingAF, platform)
      return it ? [it] : []
    })
    .join('\n')

  const feedTitle =
    platform === 'facebook' ? 'MIAD Market — Catalogue Facebook' : 'MIAD Market — Catalogue produits'
  const feedDesc =
    platform === 'facebook'
      ? 'Flux produits MIAD Market pour Facebook / Instagram Catalogue'
      : 'Flux produits MIAD Market pour Google Merchant Center'

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${feedTitle}</title>
    <link>${BASE}</link>
    <description>${feedDesc}</description>
${items}
  </channel>
</rss>`
}

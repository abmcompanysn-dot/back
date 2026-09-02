import { NextResponse } from 'next/server'
import { buildFeed } from '@/lib/catalog-feed'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

// Flux Facebook / Instagram Catalogue — même format RSS 2.0 + namespace g:
// que Google (Meta l'accepte), avec en plus g:fb_product_category.
// Exposé aussi en /facebook-feed.xml (rewrite dans next.config.mjs).
// À coller dans Commerce Manager → Catalogue → Sources de données →
// Flux de données → URL planifiée.
export async function GET() {
  const xml = await buildFeed('facebook')
  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    },
  })
}

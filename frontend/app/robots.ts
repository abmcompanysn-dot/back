import { MetadataRoute } from 'next'

const BASE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.miadmarket.com').replace(/\/$/, '')

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/Login',
          '/reset-password',
          '/?view=clientDashboard',
          '/?view=vendorDashboard',
          '/espace-representant',
        ],
      },
      {
        userAgent: 'Googlebot',
        allow: '/',
        disallow: [
          '/api/',
          '/Login',
          '/reset-password',
          '/?view=clientDashboard',
          '/?view=vendorDashboard',
          '/espace-representant',
        ],
      },
      {
        userAgent: 'Bingbot',
        allow: '/',
        disallow: [
          '/api/',
          '/Login',
          '/reset-password',
          '/?view=clientDashboard',
          '/?view=vendorDashboard',
          '/espace-representant',
        ],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
    host:    BASE,
  }
}

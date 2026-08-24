import { NextResponse } from 'next/server'
import { headers } from 'next/headers'

export const runtime = 'edge';

export async function GET() {
  const headersList = await headers()

  // Vercel Edge injecte x-vercel-ip-country, Cloudflare injecte cf-ipcountry
  const raw =
    headersList.get('x-vercel-ip-country') ||
    headersList.get('cf-ipcountry') ||
    'SN'

  const countryCode = raw.toUpperCase()

  return NextResponse.json(
    { countryCode },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  )
}

import { NextRequest, NextResponse } from 'next/server'
import { fetchProductsByVendor } from '@/lib/woo-server'

export const runtime = 'edge';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const page = parseInt(req.nextUrl.searchParams.get('page') || '2', 10)
  const perPage = parseInt(req.nextUrl.searchParams.get('per_page') || '100', 10)

  const result = await fetchProductsByVendor(id, page, perPage)
  return NextResponse.json(result)
}

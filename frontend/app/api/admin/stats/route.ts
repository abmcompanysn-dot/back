import { NextResponse } from 'next/server';

export const runtime = 'edge';

export async function GET() {
  return NextResponse.json({ message: "GraphQL support removed. Use REST API instead." }, { status: 410 });
}

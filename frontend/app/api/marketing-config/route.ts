import { NextResponse } from 'next/server'
import { ADMIN_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge'
export const revalidate = 300

// Config marketing publique (Pixel Meta id, GA id) — relais vers
// admin-svc /marketing-config, éditable en back-office (page Marketing).
// Ne contient QUE des identifiants publics ; le token CAPI reste côté
// serveur (voir /api/meta/capi).
export async function GET() {
  try {
    const res = await fetch(`${ADMIN_SVC_URL}/admin/api/marketing-config`, {
      next: { revalidate: 300, tags: ['marketing-config'] },
    })
    if (!res.ok) return NextResponse.json({}, { status: 200 })
    const data = await res.json()
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    })
  } catch {
    return NextResponse.json({}, { status: 200 })
  }
}

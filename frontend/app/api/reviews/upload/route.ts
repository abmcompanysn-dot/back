import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { CATALOG_SVC_URL, fetchWpUser } from '@/lib/miad-server-auth'

export const runtime = 'edge'

// POST /api/reviews/upload  (multipart, champ "file")
// Upload d'UNE photo jointe à un avis -> URL MinIO publique.
// Réservé aux clients connectés (l'avis lui-même exige un achat vérifié).
export async function POST(req: Request) {
  const h = await headers()
  const user = await fetchWpUser(h.get('authorization') || h.get('cookie') || '')
  if (!user?.sub) {
    return NextResponse.json({ success: false, message: 'Connexion requise.' }, { status: 401 })
  }

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ success: false, message: "Champ 'file' manquant." }, { status: 400 })
  }
  if (file.size > 15 * 1024 * 1024) {
    return NextResponse.json({ success: false, message: 'Image trop lourde (15 Mo max).' }, { status: 400 })
  }
  if (!file.type.startsWith('image/')) {
    return NextResponse.json({ success: false, message: 'Seules les images sont acceptées.' }, { status: 400 })
  }

  const fd = new FormData()
  fd.append('file', file, file.name || 'photo.jpg')

  try {
    const res = await fetch(`${CATALOG_SVC_URL}/reviews/upload`, { method: 'POST', body: fd })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.url) {
      return NextResponse.json(
        { success: false, message: data?.error?.message || "Échec de l'upload." },
        { status: res.status || 502 }
      )
    }
    return NextResponse.json({ success: true, url: data.url })
  } catch {
    return NextResponse.json({ success: false, message: 'Serveur injoignable.' }, { status: 500 })
  }
}

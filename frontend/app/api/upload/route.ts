import { NextResponse } from 'next/server';
import { PhotonImage, SamplingFilter, resize } from '@cf-wasm/photon/edge-light';

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://www.miadmarket.com').replace(/\/$/, '');
import { requireEnv } from '@/lib/require-env'
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 80;

// Les headers HTTP doivent être ISO-8859-1 ; on retire les caractères non-Latin1 (ex: apostrophe typographique U+2019)
function sanitizeFilename(name: string): string {
  return name.replace(/[^\x00-\xFF]/g, '_');
}

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });

    const formData = await req.formData();
    const file = formData.get('file') as File;
    if (!file) return NextResponse.json({ error: "Aucun fichier" }, { status: 400 });

    const originalBytes = new Uint8Array(await file.arrayBuffer());

    // Redimensionne et compresse l'image avant l'envoi à WordPress pour accélérer le chargement des pages
    let bytes: Uint8Array = originalBytes;
    let contentType = file.type;
    let filename = sanitizeFilename(file.name);

    if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') {
      const input = PhotonImage.new_from_byteslice(originalBytes);
      const width = input.get_width();
      const height = input.get_height();
      const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));

      const resized = scale < 1
        ? resize(input, Math.round(width * scale), Math.round(height * scale), SamplingFilter.Lanczos3)
        : input;

      // PNG conservé tel quel pour préserver la transparence (logos) ; tout le reste en JPEG compressé
      if (file.type === 'image/png') {
        bytes = resized.get_bytes();
        contentType = 'image/png';
        filename = filename.replace(/\.[^.]+$/, '') + '.png';
      } else {
        bytes = resized.get_bytes_jpeg(JPEG_QUALITY);
        contentType = 'image/jpeg';
        filename = filename.replace(/\.[^.]+$/, '') + '.jpg';
      }

      resized.free();
      if (resized !== input) input.free();
    }

    // Appel à l'API Media de WordPress
    const wpRes = await fetch(`${WOO_URL}/wp-json/wp/v2/media`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'X-Headless-Secret': INTERNAL_SECRET,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type': contentType
      },
      body: bytes
    });

    const data = await wpRes.json();
    if (!wpRes.ok) throw new Error(data.message || "Erreur WordPress Media");

    return NextResponse.json({
      id: data.id,
      url: data.source_url,
      success: true
    });

  } catch (error: any) {
    console.error("[Upload API] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

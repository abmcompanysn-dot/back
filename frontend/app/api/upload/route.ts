import { NextResponse } from 'next/server';
import { PhotonImage, SamplingFilter, resize } from '@cf-wasm/photon/edge-light';
import { ADMIN_SVC_URL } from '@/lib/miad-server-auth'

export const runtime = 'edge';

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 80;

// Les headers HTTP doivent être ISO-8859-1 ; on retire les caractères non-Latin1 (ex: apostrophe typographique U+2019)
function sanitizeFilename(name: string): string {
  return name.replace(/[^\x00-\xFF]/g, '_');
}

// admin-svc (POST /media/upload, requireAdminOrVendor) attend un multipart
// form-data avec un champ "file" (+ "prefix" optionnel parmi
// products/vendors/categories, défaut "products") et renvoie { url }
// (upload direct vers MinIO — pas d'id de média comme sous WordPress, la
// médiathèque admin-svc s'appuie sur l'URL). L'authentification est un JWT
// Bearer vérifié en interne par admin-svc (admin OU vendeur avec vendor_id
// dans ses claims) — plus besoin du secret interne WordPress ici.
export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });

    const formData = await req.formData();
    const file = formData.get('file') as File;
    if (!file) return NextResponse.json({ error: "Aucun fichier" }, { status: 400 });

    const originalBytes = new Uint8Array(await file.arrayBuffer());

    // Redimensionne et compresse l'image avant l'envoi pour accélérer le chargement des pages
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

    const uploadForm = new FormData();
    uploadForm.append('file', new Blob([bytes], { type: contentType }), filename);
    const prefix = formData.get('prefix');
    if (typeof prefix === 'string' && prefix) uploadForm.append('prefix', prefix);

    const svcRes = await fetch(`${ADMIN_SVC_URL}/media/upload`, {
      method: 'POST',
      headers: { Authorization: authHeader },
      body: uploadForm,
    });

    const data = await svcRes.json().catch(() => ({}));
    if (!svcRes.ok) throw new Error(data.message || data.error || "Erreur d'upload");

    return NextResponse.json({
      id: data.id ?? 0,
      url: data.url,
      success: true
    });

  } catch (error: any) {
    console.error("[Upload API] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// feed-image — URL d'image pour les flux catalogue (Google Merchant
// Center, Facebook Catalogue).
//
// Google exige ≥ 250×250 (non-vêtements) / 100×100 (vêtements) et
// recommande ≥ 800×800. Facebook exige ≥ 500×500 pour un catalogue
// publicitaire. Les images du catalogue MIAD (MinIO) sont servies telles
// quelles — la plupart dépassent 500×500.
//
// Redimensionnement 800×800 carré OPTIONNEL via Cloudflare Images
// (`/cdn-cgi/image/...`) : activé seulement si
// NEXT_PUBLIC_CF_IMAGE_RESIZING === '1'. Sinon on renvoie l'URL
// d'origine (le préfixe /cdn-cgi/image/ renvoie 404 tant qu'Image
// Resizing n'est pas activé sur la zone Cloudflare → Google/Facebook
// verraient "image manquante", constaté le 2026-09-02).
//
// Pour activer : Cloudflare → miadmarket.ca → Speed → Optimization →
// Image Resizing (ON), puis poser NEXT_PUBLIC_CF_IMAGE_RESIZING=1 dans
// les variables Cloudflare Pages et redéployer.

const SITE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://miadmarket.ca').replace(/\/$/, '')
const RESIZING_ON = process.env.NEXT_PUBLIC_CF_IMAGE_RESIZING === '1'

/**
 * feedImage(src, 800) → URL 800×800 carrée via Cloudflare Images si le
 * redimensionnement est activé, sinon l'URL d'origine intacte. Renvoie ''
 * pour un src vide, et le src tel quel pour un data: URI.
 */
export function feedImage(src: string | undefined | null, size = 800): string {
  if (!src) return ''
  if (src.startsWith('data:')) return src
  if (!RESIZING_ON) return src
  const opts = `width=${size},height=${size},fit=pad,background=white,format=auto,quality=85`
  return `${SITE}/cdn-cgi/image/${opts}/${src}`
}

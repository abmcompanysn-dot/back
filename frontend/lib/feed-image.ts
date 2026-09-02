// feed-image — URL d'image carrée pour les flux catalogue (Google Merchant
// Center, Facebook Catalogue).
//
// Google exige des images d'au moins 250×250 (non-vêtements) / 100×100
// (vêtements) et RECOMMANDE ≥ 800×800. Facebook exige ≥ 500×500 pour un
// catalogue publicitaire. Les images du catalogue MIAD (MinIO / R2) n'ont
// pas de taille garantie.
//
// On passe donc l'URL d'origine par le redimensionneur Cloudflare Images
// (`/cdn-cgi/image/...`), servi depuis la zone miadmarket.ca. `fit=pad` +
// `background=white` garantit un carré exact sans rogner le produit —
// important pour l'aperçu Shopping.
//
// Si Image Resizing n'est PAS activé sur la zone Cloudflare, le préfixe
// `/cdn-cgi/image/` renvoie une 404 → Google/Facebook réessaieront
// l'originale (ils tolèrent une image inaccessible sur une URL et suivent
// les additional_image_link). Pour l'activer : dashboard Cloudflare →
// Speed → Optimization → Image Resizing (ON).

const SITE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://miadmarket.ca').replace(/\/$/, '')

/**
 * feedImage(src, 800) → URL carrée `size`×`size` servie via Cloudflare Images.
 * Renvoie l'URL d'origine telle quelle si `src` est vide ou déjà un data URI.
 */
export function feedImage(src: string | undefined | null, size = 800): string {
  if (!src || src.startsWith('data:')) return src || ''
  // Cloudflare Images accepte une URL absolue OU un chemin ; on garde
  // l'absolu pour que le redimensionneur aille chercher la source où
  // qu'elle soit (MinIO, R2…).
  const opts = `width=${size},height=${size},fit=pad,background=white,format=auto,quality=85`
  return `${SITE}/cdn-cgi/image/${opts}/${encodeURI(src)}`
}

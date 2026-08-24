#!/usr/bin/env node
/**
 * Régénère et téléverse sur Cloudflare R2 les miniatures de produits manquantes,
 * pour plusieurs tailles à la fois (100x100, 150x150, 300x300).
 *
 * Contexte : la synchronisation initiale vers R2 n'a copié que les images
 * originales, jamais les dérivées de taille générées par WordPress (ex:
 * "-100x100.avif"). Gmail ne supporte de toute façon pas l'AVIF dans le corps
 * des emails. Ce script :
 *   1. Liste les produits WooCommerce et leurs images.
 *   2. Pour chaque image et chaque taille configurée, vérifie si la dérivée
 *      existe déjà sur R2.
 *   3. Si absente : télécharge l'original (déjà sur R2), le redimensionne en
 *      JPEG via sharp, et l'envoie sur R2 AU MÊME chemin/extension que
 *      WordPress attend (ex: toujours "-300x300.avif"), mais avec un header
 *      Content-Type: image/jpeg correct — les navigateurs et Gmail se basent
 *      sur ce header, pas sur l'extension du fichier. Aucune modification
 *      WordPress nécessaire.
 *
 * Variables d'environnement requises (.env.local) :
 *   NEXT_PUBLIC_WOO_URL, WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET  (déjà existantes)
 *   NEXT_PUBLIC_R2_URL                                          (déjà existante, ex: cdn.miadmarket.com)
 *   R2_DST_ACCOUNT_ID, R2_DST_ACCESS_KEY_ID, R2_DST_SECRET_ACCESS_KEY, R2_DST_BUCKET
 *     (identifiants du nouveau bucket "miadr2" — utilisés en priorité s'ils existent ;
 *      sinon repli sur R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET)
 *
 * Usage :
 *   node scripts/r2-resync-thumbnails.mjs            (exécute pour de vrai, toutes les tailles)
 *   node scripts/r2-resync-thumbnails.mjs --dry-run   (liste sans rien envoyer)
 *   MIAD_THUMB_SIZES=100x100,150x150,300x300,640x640 node scripts/r2-resync-thumbnails.mjs
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// ── Chargement de .env.local sans dépendance supplémentaire ────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com').replace(/\/$/, '');
const WOO_CK  = process.env.WOO_CONSUMER_KEY;
const WOO_CS  = process.env.WOO_CONSUMER_SECRET;
const R2_PUBLIC = (process.env.NEXT_PUBLIC_R2_URL || 'https://cdn.miadmarket.com').replace(/\/$/, '');
// Anciens domaines R2 encore présents sur des images existantes (avant bascule complète vers R2_PUBLIC)
const LEGACY_R2_BASES = (process.env.MIAD_LEGACY_R2_BASES || 'https://pub-5830f37957e94da4a6855da37b632a3a.r2.dev')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

function r2BaseFor(url) {
  if (url.startsWith(R2_PUBLIC)) return R2_PUBLIC;
  return LEGACY_R2_BASES.find((base) => url.startsWith(base)) || null;
}

// Priorité au nouveau bucket (R2_DST_*) ; repli sur l'ancien (R2_*) si absent.
const R2_ACCOUNT_ID = process.env.R2_DST_ACCOUNT_ID || process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY = process.env.R2_DST_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY = process.env.R2_DST_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET      = process.env.R2_DST_BUCKET || process.env.R2_BUCKET;

const THUMB_SIZES = (process.env.MIAD_THUMB_SIZES || '100x100,150x150,300x300')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [w, h] = s.split('x').map(Number);
    return { w, h };
  });

const DRY_RUN = process.argv.includes('--dry-run');

if (!WOO_CK || !WOO_CS) {
  console.error('❌ WOO_CONSUMER_KEY / WOO_CONSUMER_SECRET manquants dans .env.local');
  process.exit(1);
}
if (!DRY_RUN && (!R2_ACCOUNT_ID || !R2_ACCESS_KEY || !R2_SECRET_KEY || !R2_BUCKET)) {
  console.error('❌ Identifiants R2 manquants dans .env.local (R2_DST_* ou R2_*)');
  console.error('   (Cloudflare Dashboard > R2 > Manage API Tokens > Create API Token, permission "Object Read & Write")');
  process.exit(1);
}

const s3 = DRY_RUN ? null : new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
});

/** Convertit n'importe quelle URL R2 (ancien ou nouveau domaine) en URL sur le nouveau domaine */
function normalizeToNewBase(url) {
  const base = r2BaseFor(url);
  if (!base) return null;
  return R2_PUBLIC + url.slice(base.length);
}

function thumbUrlFor(originalUrl, w, h) {
  const ext = originalUrl.slice(originalUrl.lastIndexOf('.'));
  const base = originalUrl.slice(0, originalUrl.lastIndexOf('.'));
  return `${base}-${w}x${h}${ext}`;
}

function r2KeyFromUrl(url) {
  if (!url.startsWith(R2_PUBLIC)) return null;
  return decodeURIComponent(url.slice(R2_PUBLIC.length + 1));
}

async function headExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchAllProductImages() {
  const images = new Set();
  let page = 1;
  while (true) {
    const params = new URLSearchParams({
      per_page: '100',
      page: String(page),
      status: 'publish',
      consumer_key: WOO_CK,
      consumer_secret: WOO_CS,
    });
    const res = await fetch(`${WOO_URL}/wp-json/wc/v3/products?${params}`, {
      headers: { 'User-Agent': 'MIAD-Headless-Client' },
    });
    if (!res.ok) break;
    const products = await res.json();
    if (!Array.isArray(products) || products.length === 0) break;

    for (const p of products) {
      for (const img of p.images || []) {
        if (!img.src) continue;
        const normalized = normalizeToNewBase(img.src);
        if (normalized) images.add(normalized);
      }
    }
    if (products.length < 100) break;
    page++;
  }
  return [...images];
}

async function processOne(originalUrl, w, h) {
  const thumbUrl = thumbUrlFor(originalUrl, w, h);
  const exists = await headExists(thumbUrl);
  if (exists) return { status: 'skip', originalUrl, thumbUrl };

  if (DRY_RUN) return { status: 'would-fix', originalUrl, thumbUrl };

  const origRes = await fetch(originalUrl);
  if (!origRes.ok) return { status: 'error', originalUrl, thumbUrl, error: `original introuvable (${origRes.status})` };
  const origBuffer = Buffer.from(await origRes.arrayBuffer());

  let jpegBuffer;
  try {
    jpegBuffer = await sharp(origBuffer).resize(w, h, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
  } catch (e) {
    return { status: 'error', originalUrl, thumbUrl, error: `décodage échoué : ${e.message}` };
  }

  const key = r2KeyFromUrl(thumbUrl);
  if (!key) return { status: 'error', originalUrl, thumbUrl, error: 'clé R2 introuvable' };

  try {
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: jpegBuffer,
      ContentType: 'image/jpeg',
    }));
  } catch (e) {
    return { status: 'error', originalUrl, thumbUrl, error: `upload R2 échoué : ${e.message}` };
  }

  return { status: 'fixed', originalUrl, thumbUrl };
}

async function main() {
  console.log(`🔍 Récupération des images produits (${WOO_URL})…`);
  const images = await fetchAllProductImages();
  console.log(`📦 ${images.length} image(s) produit unique(s) trouvée(s) sur R2.`);
  console.log(`📐 Tailles ciblées : ${THUMB_SIZES.map((s) => `${s.w}x${s.h}`).join(', ')}\n`);

  let fixed = 0, skipped = 0, errors = 0;

  for (const url of images) {
    for (const { w, h } of THUMB_SIZES) {
      const r = await processOne(url, w, h);
      if (r.status === 'skip') {
        skipped++;
      } else if (r.status === 'fixed') {
        fixed++;
        console.log(`✅ ${r.thumbUrl}`);
      } else if (r.status === 'would-fix') {
        fixed++;
        console.log(`🔸 [dry-run] manquant : ${r.thumbUrl}`);
      } else {
        errors++;
        console.log(`❌ ${r.thumbUrl} — ${r.error}`);
      }
    }
  }

  console.log(`\n${DRY_RUN ? '(dry-run) ' : ''}Terminé : ${fixed} corrigée(s)/manquante(s), ${skipped} déjà ok, ${errors} échec(s).`);
}

main().catch((e) => {
  console.error('💥 Erreur fatale :', e);
  process.exit(1);
});

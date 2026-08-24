#!/usr/bin/env node
/**
 * Liste directement le bucket R2 (nouveau bucket "miadr2") et génère les
 * dérivées de taille manquantes (100x100, 150x150, 300x300 par défaut) pour
 * chaque image originale, en JPEG (compatible Gmail), avec le même chemin/
 * extension que WordPress attend (ex: "tegande-0-1-150x150.avif" mais avec
 * Content-Type: image/jpeg réel).
 *
 * Contrairement à scripts/r2-resync-thumbnails.mjs (qui part de la liste des
 * produits WooCommerce), ce script part de l'inventaire réel du bucket — il
 * traite donc aussi les images qui ne sont plus correctement référencées par
 * l'API (ex: pendant que miad-r2-images.php est en cours de déploiement).
 *
 * Variables d'environnement requises (.env.local) :
 *   R2_DST_ACCOUNT_ID, R2_DST_ACCESS_KEY_ID, R2_DST_SECRET_ACCESS_KEY, R2_DST_BUCKET
 *   NEXT_PUBLIC_R2_URL (ex: https://cdn.miadmarket.com)
 *
 * Usage :
 *   node scripts/r2-generate-derivatives.mjs            (exécute pour de vrai)
 *   node scripts/r2-generate-derivatives.mjs --dry-run   (liste sans rien envoyer)
 *   MIAD_THUMB_SIZES=100x100,150x150,300x300 node scripts/r2-generate-derivatives.mjs
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Variable manquante dans .env.local : ${name}`);
    process.exit(1);
  }
  return v;
}

const DRY_RUN = process.argv.includes('--dry-run');

const ACCOUNT_ID = need('R2_DST_ACCOUNT_ID');
const ACCESS_KEY = need('R2_DST_ACCESS_KEY_ID');
const SECRET_KEY = need('R2_DST_SECRET_ACCESS_KEY');
const BUCKET     = need('R2_DST_BUCKET');
const R2_PUBLIC  = (process.env.NEXT_PUBLIC_R2_URL || 'https://cdn.miadmarket.com').replace(/\/$/, '');

const THUMB_SIZES = (process.env.MIAD_THUMB_SIZES || '100x100,150x150,300x300')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const [w, h] = s.split('x').map(Number); return { w, h }; });

const IMAGE_EXT = /\.(jpe?g|png|webp|avif|gif)$/i;
const DERIVATIVE_SUFFIX = /-\d+x\d+(?=\.[a-zA-Z0-9]+$)/;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

async function* listOriginalImageKeys() {
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }));
    for (const obj of res.Contents || []) {
      if (!IMAGE_EXT.test(obj.Key)) continue;
      if (DERIVATIVE_SUFFIX.test(obj.Key)) continue; // on ne génère pas de dérivée à partir d'une dérivée
      yield obj.Key;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
}

function keyToBase(key) {
  const ext = key.slice(key.lastIndexOf('.'));
  return { base: key.slice(0, -ext.length), ext };
}

async function existsOnR2(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function generateOne(originalKey, w, h) {
  const { base, ext } = keyToBase(originalKey);
  const thumbKey = `${base}-${w}x${h}${ext}`;

  if (await existsOnR2(thumbKey)) return { status: 'skip', thumbKey };
  if (DRY_RUN) return { status: 'would-fix', thumbKey };

  const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: originalKey }));
  const origBuffer = Buffer.from(await got.Body.transformToByteArray());

  let jpegBuffer;
  try {
    jpegBuffer = await sharp(origBuffer).resize(w, h, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
  } catch (e) {
    return { status: 'error', thumbKey, error: `décodage échoué : ${e.message}` };
  }

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: thumbKey,
    Body: jpegBuffer,
    ContentType: 'image/jpeg',
  }));

  return { status: 'fixed', thumbKey };
}

async function main() {
  console.log(`🔍 Inventaire du bucket "${BUCKET}"…`);
  console.log(`📐 Tailles ciblées : ${THUMB_SIZES.map((s) => `${s.w}x${s.h}`).join(', ')}\n`);

  let total = 0, fixed = 0, skipped = 0, errors = 0;

  for await (const originalKey of listOriginalImageKeys()) {
    total++;
    for (const { w, h } of THUMB_SIZES) {
      const r = await generateOne(originalKey, w, h);
      if (r.status === 'skip') skipped++;
      else if (r.status === 'fixed') { fixed++; console.log(`✅ ${R2_PUBLIC}/${r.thumbKey}`); }
      else if (r.status === 'would-fix') { fixed++; console.log(`🔸 [dry-run] manquant : ${R2_PUBLIC}/${r.thumbKey}`); }
      else { errors++; console.log(`❌ ${r.thumbKey} — ${r.error}`); }
    }
    if (total % 50 === 0) console.log(`… ${total} original(aux) traité(s)`);
  }

  console.log(`\n${DRY_RUN ? '(dry-run) ' : ''}Terminé : ${total} original(aux) scanné(s), ${fixed} dérivée(s) corrigée(s)/manquante(s), ${skipped} déjà ok, ${errors} échec(s).`);
}

main().catch((e) => {
  console.error('💥 Erreur fatale :', e);
  process.exit(1);
});

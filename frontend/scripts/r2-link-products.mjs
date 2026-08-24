#!/usr/bin/env node
/**
 * Traite côté ordinateur local (pas sur le serveur WordPress) la liaison des
 * images produits manquantes vers R2 :
 *   1. Demande à WordPress (endpoint REST custom) la liste des images
 *      produits pas encore liées à R2 (_miad_r2_url absent).
 *   2. Pour chacune : vérifie si elle existe déjà sur R2 (HEAD) ; si non,
 *      télécharge l'original depuis le serveur local et l'uploade sur R2.
 *   3. Appelle WordPress pour enregistrer le lien final (_miad_r2_url) —
 *      WordPress n'a fait ni téléchargement ni upload, juste l'écriture en base.
 *
 * Variables d'environnement requises (.env.local) :
 *   MIAD_LINK_API     ex: https://api.miadmarket.com/wp-json/miad-r2/v1
 *   MIAD_LINK_SECRET  la clé affichée sur la page Médias > MIAD R2
 *   R2_DST_ACCOUNT_ID, R2_DST_ACCESS_KEY_ID, R2_DST_SECRET_ACCESS_KEY, R2_DST_BUCKET
 *   NEXT_PUBLIC_R2_URL  ex: https://cdn.miadmarket.com
 *
 * Usage :
 *   node scripts/r2-link-products.mjs            (exécute pour de vrai)
 *   node scripts/r2-link-products.mjs --dry-run   (liste sans rien envoyer)
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
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

const DRY_RUN = process.argv.includes('--dry-run');

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Variable manquante dans .env.local : ${name}`);
    process.exit(1);
  }
  return v;
}

const LINK_API    = need('MIAD_LINK_API').replace(/\/$/, '');
const LINK_SECRET = need('MIAD_LINK_SECRET');
const R2_PUBLIC    = (process.env.NEXT_PUBLIC_R2_URL || 'https://cdn.miadmarket.com').replace(/\/$/, '');

const ACCOUNT_ID = need('R2_DST_ACCOUNT_ID');
const ACCESS_KEY = need('R2_DST_ACCESS_KEY_ID');
const SECRET_KEY = need('R2_DST_SECRET_ACCESS_KEY');
const BUCKET     = need('R2_DST_BUCKET');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

async function fetchPending(limit = 50) {
  const res = await fetch(`${LINK_API}/pending?limit=${limit}`, {
    headers: { 'X-Miad-R2-Secret': LINK_SECRET },
  });
  if (!res.ok) throw new Error(`GET /pending a échoué (${res.status}) : ${await res.text()}`);
  return res.json();
}

async function linkInWordPress(attachmentId, r2Url) {
  const res = await fetch(`${LINK_API}/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Miad-R2-Secret': LINK_SECRET },
    body: JSON.stringify({ attachment_id: attachmentId, r2_url: r2Url }),
  });
  if (!res.ok) throw new Error(`POST /link a échoué (${res.status}) : ${await res.text()}`);
  return res.json();
}

async function existsOnR2(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Coupures réseau locales (DNS, connexion perdue) — pas des erreurs définitives sur l'image */
function isNetworkError(e) {
  const msg = String(e && e.message || e);
  return msg.includes('fetch failed') || msg.includes('ENOTFOUND') || msg.includes('ECONNRESET')
    || msg.includes('ETIMEDOUT') || msg.includes('EAI_AGAIN') || (e && e.cause && isNetworkError(e.cause));
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Relance jusqu'à `retries` fois en cas de coupure réseau, avec un court délai entre essais */
async function withNetworkRetry(fn, retries = 5, delayMs = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isNetworkError(e) || attempt === retries) throw e;
      console.log(`⌛ Coupure réseau détectée, nouvelle tentative dans ${delayMs / 1000}s… (${attempt}/${retries})`);
      await sleep(delayMs);
    }
  }
}

async function processOne(item) {
  const { attachment_id, relative_path, local_url } = item;
  const r2Url = `${R2_PUBLIC}/${relative_path}`;

  if (await existsOnR2(relative_path)) {
    if (!DRY_RUN) await linkInWordPress(attachment_id, r2Url);
    return { status: 'linked', attachment_id, r2Url };
  }

  if (DRY_RUN) return { status: 'would-upload', attachment_id, r2Url };

  const origRes = await fetch(local_url);
  if (!origRes.ok) return { status: 'error', attachment_id, error: `original introuvable (${origRes.status})` };
  const buffer = Buffer.from(await origRes.arrayBuffer());
  const contentType = origRes.headers.get('content-type') || 'application/octet-stream';

  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: relative_path, Body: buffer, ContentType: contentType }));
  await linkInWordPress(attachment_id, r2Url);
  return { status: 'uploaded', attachment_id, r2Url };
}

async function main() {
  console.log(`🔍 Récupération des images en attente depuis ${LINK_API}…\n`);

  let totalLinked = 0, totalUploaded = 0, totalErrors = 0, round = 0;

  // Les images en échec restent "en attente" côté WordPress indéfiniment
  // (aucun lien n'est jamais enregistré) — sans ça, la boucle reviendrait
  // dessus à chaque tour et ne s'arrêterait jamais. Seules les vraies erreurs
  // (image introuvable nulle part) sont retenues ici — les coupures réseau
  // sont automatiquement réessayées et ne comptent jamais comme échec définitif.
  const failedIds = new Set();

  while (true) {
    round++;
    const allItems = await withNetworkRetry(() => fetchPending(50));
    const items = allItems.filter((item) => !failedIds.has(item.attachment_id));
    if (items.length === 0) break;

    console.log(`📦 Lot ${round} : ${items.length} image(s)`);

    for (const item of items) {
      try {
        const r = await withNetworkRetry(() => processOne(item));
        if (r.status === 'linked') { totalLinked++; console.log(`🔗 #${r.attachment_id} déjà sur R2 → lié : ${r.r2Url}`); }
        else if (r.status === 'uploaded') { totalUploaded++; console.log(`✅ #${r.attachment_id} uploadé → ${r.r2Url}`); }
        else if (r.status === 'would-upload') { totalUploaded++; console.log(`🔸 [dry-run] #${r.attachment_id} serait uploadé → ${r.r2Url}`); }
        else { totalErrors++; failedIds.add(item.attachment_id); console.log(`❌ #${r.attachment_id} — ${r.error}`); }
      } catch (e) {
        totalErrors++;
        failedIds.add(item.attachment_id);
        console.log(`❌ #${item.attachment_id} — ${e.message}`);
      }
    }

    if (DRY_RUN) break; // en dry-run, WordPress ne voit jamais le lien donc /pending renverrait toujours le même lot
  }

  if (failedIds.size > 0) {
    console.log(`\n⚠️  ${failedIds.size} image(s) introuvable(s) nulle part (ni local ni R2) — à corriger manuellement : ${[...failedIds].join(', ')}`);
  }

  console.log(`\n${DRY_RUN ? '(dry-run) ' : ''}Terminé : ${totalLinked} lié(s) directement, ${totalUploaded} uploadé(s), ${totalErrors} échec(s).`);
}

main().catch((e) => {
  console.error('💥 Erreur fatale :', e);
  process.exit(1);
});

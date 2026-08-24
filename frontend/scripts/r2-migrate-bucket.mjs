#!/usr/bin/env node
/**
 * Copie tout le contenu d'un bucket R2 (compte source) vers un autre bucket R2
 * (compte destination), en streamant directement objet par objet — pas de
 * téléchargement intermédiaire volumineux sur disque.
 *
 * Variables d'environnement requises (.env.local) :
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET           (source)
 *   R2_DST_ACCOUNT_ID, R2_DST_ACCESS_KEY_ID, R2_DST_SECRET_ACCESS_KEY, R2_DST_BUCKET (destination)
 *
 * Usage :
 *   node scripts/r2-migrate-bucket.mjs            (copie tout)
 *   node scripts/r2-migrate-bucket.mjs --dry-run   (liste sans copier)
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
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

const SRC_ACCOUNT = need('R2_ACCOUNT_ID');
const SRC_KEY      = need('R2_ACCESS_KEY_ID');
const SRC_SECRET   = need('R2_SECRET_ACCESS_KEY');
const SRC_BUCKET    = need('R2_BUCKET');

const DST_ACCOUNT = need('R2_DST_ACCOUNT_ID');
const DST_KEY      = need('R2_DST_ACCESS_KEY_ID');
const DST_SECRET   = need('R2_DST_SECRET_ACCESS_KEY');
const DST_BUCKET    = need('R2_DST_BUCKET');

// Timeout explicite — sans ça, une requête réseau qui ne répond jamais (handshake
// TLS bloqué, etc.) fait pendre le script indéfiniment sans erreur ni log.
const httpHandler = new NodeHttpHandler({
  connectionTimeout: 10_000,
  requestTimeout: 20_000,
});

const srcClient = new S3Client({
  region: 'auto',
  endpoint: `https://${SRC_ACCOUNT}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: SRC_KEY, secretAccessKey: SRC_SECRET },
  requestHandler: httpHandler,
  maxAttempts: 3,
});

const dstClient = new S3Client({
  region: 'auto',
  endpoint: `https://${DST_ACCOUNT}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: DST_KEY, secretAccessKey: DST_SECRET },
  requestHandler: httpHandler,
  maxAttempts: 3,
});

async function* listAllKeys() {
  let token;
  do {
    const res = await srcClient.send(new ListObjectsV2Command({
      Bucket: SRC_BUCKET,
      ContinuationToken: token,
    }));
    for (const obj of res.Contents || []) yield obj;
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
}

async function destExists(key) {
  try {
    await dstClient.send(new HeadObjectCommand({ Bucket: DST_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function copyOne(key) {
  if (await destExists(key)) return 'skip';
  const got = await srcClient.send(new GetObjectCommand({ Bucket: SRC_BUCKET, Key: key }));
  const body = await got.Body.transformToByteArray();
  await dstClient.send(new PutObjectCommand({
    Bucket: DST_BUCKET,
    Key: key,
    Body: body,
    ContentType: got.ContentType,
  }));
  return 'copied';
}

async function main() {
  console.log(`🔍 Listage du bucket source "${SRC_BUCKET}"…`);
  let total = 0, copied = 0, skipped = 0, errors = 0;

  for await (const obj of listAllKeys()) {
    total++;
    if (DRY_RUN) {
      console.log(`🔸 [dry-run] ${obj.Key} (${obj.Size} octets)`);
      continue;
    }
    try {
      const r = await copyOne(obj.Key);
      if (r === 'copied') { copied++; console.log(`✅ ${obj.Key}`); }
      else { skipped++; }
    } catch (e) {
      errors++;
      console.log(`❌ ${obj.Key} — ${e.message}`);
    }
    if (total % 50 === 0) console.log(`… ${total} traité(s)`);
  }

  console.log(`\n${DRY_RUN ? '(dry-run) ' : ''}Terminé : ${total} objet(s) au total, ${copied} copié(s), ${skipped} déjà présent(s), ${errors} échec(s).`);
}

main().catch((e) => {
  console.error('💥 Erreur fatale :', e);
  process.exit(1);
});

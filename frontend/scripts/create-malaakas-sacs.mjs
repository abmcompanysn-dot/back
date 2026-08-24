#!/usr/bin/env node
/**
 * Upload 10 photos sur R2 CDN puis crée 10 produits variables WooCommerce
 * pour la boutique MALAÄKA'S HOUSE (vendor 95).
 * Chaque produit = un motif différent, mêmes variations de quantité + prix.
 *
 * Prérequis : miad-products-api.php doit avoir le endpoint /create-variable déployé.
 */

import { readFileSync, existsSync } from 'fs'
import { createHmac, createHash } from 'crypto'
import { fileURLToPath } from 'url'
import path from 'path'

// ── Chargement .env.local ──────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.join(__dirname, '..', '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const MIAD_API    = (process.env.MIAD_PRODUCTS_API || 'https://api.miadmarket.com/wp-json/miad-products/v1').replace(/\/$/, '')
const MIAD_SECRET = process.env.MIAD_PRODUCTS_SECRET
// Workflow local : upload sur imagemiad (src) via credentials principaux
// WordPress télécharge depuis pub-*.r2.dev → miad_r2_sync_attachment → miadr2 (cdn.miadmarket.com)
const R2_ACCOUNT  = process.env.R2_ACCOUNT_ID
const R2_KEY      = process.env.R2_ACCESS_KEY_ID
const R2_SECRET   = process.env.R2_SECRET_ACCESS_KEY
const R2_BUCKET   = process.env.R2_BUCKET || 'imagemiad'
const CDN_URL     = 'https://pub-5830f37957e94da4a6855da37b632a3a.r2.dev'

if (!MIAD_SECRET) { console.error('❌ MIAD_PRODUCTS_SECRET manquant'); process.exit(1) }
if (!R2_ACCOUNT || !R2_KEY || !R2_SECRET) { console.error('❌ Clés R2 manquantes'); process.exit(1) }

// ── Produits à créer ───────────────────────────────────────────────────────
const VENDOR_ID = 95
const CATEGORY  = 'Sacs'

const DESCRIPTION = `<p>🛑🥰 <strong>ENSEMBLE SAC+POCHETTE VIP</strong> ❤️🤌🏾</p>
<p>🌸 <strong>20 000 frs / Ensemble</strong></p>
<p>🌺 <strong>17 500 frs en gros</strong> (à partir de 10 ensembles)</p>
<p>✨ Nous livrons à domicile dans toute la ville de Yaoundé et nous expédions partout ailleurs dans le monde 🌍</p>
<p>Sac à main artisanal avec pochette assortie — ornement perlé fait main, tissu africain wax/kente, anse en bois naturel.</p>`

const SHORT_DESC = 'Ensemble sac + pochette VIP artisanal, tissu africain wax/kente, ornement perlé, anse bois. Livraison Yaoundé + expédition mondiale.'

const VARIATIONS = [
  { label: '1 Ensemble',            price: 20000 },
  { label: 'Gros — 10+ ensembles',  price: 17500 },
]

const PHOTOS = [
  { file: 'C:/Users/Admin/Downloads/PHOTO-2026-07-01-10-03-47 (1).jpg', motif: 'Denim & Kente Soleil' },
  { file: 'C:/Users/Admin/Downloads/PHOTO-2026-07-01-10-03-46 (3).jpg', motif: 'Nuit Bogolan Géo' },
  { file: 'C:/Users/Admin/Downloads/PHOTO-2026-07-01-10-03-46 (2).jpg', motif: 'Rouge Wax Éclair' },
  { file: 'C:/Users/Admin/Downloads/PHOTO-2026-07-01-10-03-45 (2).jpg', motif: 'Bordeaux Kente Fleur' },
  { file: 'C:/Users/Admin/Downloads/PHOTO-2026-07-01-10-03-45 (1).jpg', motif: 'Chocolat Bogolan' },
  { file: 'C:/Users/Admin/Downloads/PHOTO-2026-07-01-10-03-47.jpg',     motif: 'Denim Splash Arc-en-ciel' },
  { file: 'C:/Users/Admin/Downloads/PHOTO-2026-07-01-10-03-46 (1).jpg', motif: 'Naturel Kente Mandala' },
  { file: 'C:/Users/Admin/Downloads/PHOTO-2026-07-01-10-03-46.jpg',     motif: 'Caramel Arabesque' },
  { file: 'C:/Users/Admin/Downloads/PHOTO-2026-07-01-10-03-45.jpg',     motif: 'Nuit Kente Soleil' },
  { file: 'C:/Users/Admin/Downloads/PHOTO-2026-07-01-10-03-44.jpg',     motif: 'Orange Soleil Arabesque' },
]

// ── Upload R2 via S3-compatible API (Signature V4) ─────────────────────────
function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest()
}
function sha256hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

async function uploadToR2(filePath, r2Key) {
  const fileContent = readFileSync(filePath)
  const endpoint    = `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`
  const host        = `${R2_ACCOUNT}.r2.cloudflarestorage.com`
  const region      = 'auto'
  const service     = 's3'
  const contentType = 'image/jpeg'

  const now       = new Date()
  const dateISO   = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const dateStamp = dateISO.slice(0, 8)

  const payloadHash = sha256hex(fileContent)

  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${dateISO}\n`

  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'

  const canonicalRequest = [
    'PUT',
    `/${R2_BUCKET}/${r2Key}`,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateISO,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n')

  const kDate    = hmac('AWS4' + R2_SECRET, dateStamp)
  const kRegion  = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSign    = hmac(kService, 'aws4_request')
  const sig      = createHmac('sha256', kSign).update(stringToSign).digest('hex')

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${R2_KEY}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${sig}`

  const res = await fetch(`${endpoint}/${R2_BUCKET}/${r2Key}`, {
    method: 'PUT',
    headers: {
      'Authorization':        authorization,
      'Content-Type':         contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date':           dateISO,
    },
    body: fileContent,
  })

  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`R2 upload échoué (${res.status}): ${txt.slice(0, 200)}`)
  }
  return `${CDN_URL}/${r2Key}`
}

// ── Création produit variable via MIAD API ─────────────────────────────────
async function createVariableProduct(name, imageUrl) {
  const res = await fetch(`${MIAD_API}/create-variable`, {
    method: 'POST',
    headers: { 'X-Miad-Products-Secret': MIAD_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      description:      DESCRIPTION,
      shortDescription: SHORT_DESC,
      category:         CATEGORY,
      vendorId:         VENDOR_ID,
      attributeName:    'Commande',
      variations:       VARIATIONS,
      imageUrl,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`API ${res.status}: ${JSON.stringify(data)}`)
  return data
}

// ── Boucle principale ──────────────────────────────────────────────────────
console.log(`\n🛍  Création de ${PHOTOS.length} produits variables — boutique #${VENDOR_ID}\n`)

for (const { file, motif } of PHOTOS) {
  const name  = `ENSEMBLE SAC+POCHETTE VIP — ${motif}`
  const r2Key = `malaakas/sac-vip-${motif.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}.jpg`

  try {
    process.stdout.write(`  📤 Upload R2 : ${motif} ... `)
    const cdnUrl = await uploadToR2(file, r2Key)
    console.log(`✅ ${cdnUrl}`)

    process.stdout.write(`  🏪 Produit WC : ${name} ... `)
    const result = await createVariableProduct(name, cdnUrl)
    console.log(`✅ ID=${result.product_id}  vars=${result.variation_ids?.join(',')}`)
  } catch (err) {
    console.error(`\n  ❌ ${motif} : ${err.message}`)
  }

  // Pause pour ne pas surcharger le serveur WP
  await new Promise(r => setTimeout(r, 1500))
}

console.log('\n✅ Terminé !\n')

#!/usr/bin/env node
/**
 * Sync miniatures vers R2/CDN pour une liste de produits WooCommerce.
 * Usage : node scripts/sync-product-images.mjs <id1> <id2> ...
 * Exemple: node scripts/sync-product-images.mjs 39478 39475 39472 39469 39463 39509 39411
 */
import { readFileSync, existsSync } from 'fs'
const envPath = 'C:/Users/Admin/OneDrive/Pictures/im/Desktop/v0-miad-front-end/.env.local'
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}
const API    = process.env.MIAD_PRODUCTS_API.replace(/\/$/, '')
const SECRET = process.env.MIAD_PRODUCTS_SECRET

const ids = process.argv.slice(2).map(Number).filter(Boolean)
if (!ids.length) {
  console.error('Usage: node sync-product-images.mjs <id1> <id2> ...')
  process.exit(1)
}

console.log(`\n🔄 Sync images pour ${ids.length} produits...\n`)

for (const productId of ids) {
  process.stdout.write(`  Produit #${productId} ... `)
  const res = await fetch(`${API}/sync-product-images`, {
    method: 'POST',
    headers: { 'X-Miad-Products-Secret': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ productIds: [productId] }),
    signal: AbortSignal.timeout(90000),
  })
  const data = await res.json().catch(() => ({}))
  const r = data.results?.[0]
  if (!r?.ok) {
    console.log(`❌ ${r?.error ?? JSON.stringify(data)}`)
  } else {
    console.log(`✅  sizes_synced=${r.sizes_synced}  r2_state=${r.r2_state}`)
    if (r.wc_thumbnail) console.log(`     300x300 : ${r.wc_thumbnail}`)
    if (r.thumbnail)    console.log(`     150x150 : ${r.thumbnail}`)
  }
}
console.log('\n✅ Terminé !')

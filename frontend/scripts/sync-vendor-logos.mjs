#!/usr/bin/env node
// Migre les logos vendeurs (Dokan) encore servis depuis api.miadmarket.com/wp-content
// vers le CDN R2, via l'endpoint /sync-thumbnails (attachment ID, pas product ID).
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

// { storeId, storeName, attachmentId }
const LOGOS = [
  { storeId: 20, name: 'Naby Gold', attachmentId: 6336 },
  { storeId: 48, name: 'Nadjoa beads', attachmentId: 26661 },
  { storeId: 95, name: "MALAÏKA'S HOUSE", attachmentId: 27162 },
  { storeId: 22, name: 'Café Touba Mame Fatou', attachmentId: 13515 },
  { storeId: 17, name: 'Ayzha Cosmetics', attachmentId: 13509 },
]

console.log(`\n🔄 Sync logos vendeurs pour ${LOGOS.length} boutique(s) (test)...\n`)

for (const { storeId, name, attachmentId } of LOGOS) {
  process.stdout.write(`  #${storeId} ${name} (attachment ${attachmentId}) ... `)

  try {
    const res = await fetch(`${API}/sync-thumbnails`, {
      method: 'POST',
      headers: { 'X-Miad-Products-Secret': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachmentIds: [attachmentId] }),
      signal: AbortSignal.timeout(90000),
    })
    const data = await res.json().catch(() => ({}))

    if (!res.ok || !data.ok) {
      console.log(`❌ HTTP ${res.status} — ${JSON.stringify(data)}`)
      continue
    }

    const r = data.results?.[0]
    if (!r?.ok) {
      console.log(`❌ ${r?.error ?? 'erreur inconnue'}`)
      continue
    }

    console.log(`✅  sizes_synced=${r.sizes_synced}  r2_state=${r.r2_state}`)
    console.log(`     r2_url : ${r.r2_url}`)
  } catch (e) {
    console.log(`❌ ${e.message}`)
  }
}
console.log('\n✅ Terminé !')

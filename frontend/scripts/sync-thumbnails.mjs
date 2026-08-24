#!/usr/bin/env node
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

const ATTACHMENT_IDS = [39854, 39855, 39856, 39857, 39858, 39859, 39860, 39861, 39862, 39863]

console.log(`\n🔄 Sync miniatures pour ${ATTACHMENT_IDS.length} attachments (un par un)...\n`)

const MOTIFS = [
  'Denim & Kente Soleil',
  'Nuit Bogolan Géo',
  'Rouge Wax Éclair',
  'Bordeaux Kente Fleur',
  'Chocolat Bogolan',
  'Denim Splash Arc-en-ciel',
  'Naturel Kente Mandala',
  'Caramel Arabesque',
  'Nuit Kente Soleil',
  'Orange Soleil Arabesque',
]

for (const [i, attId] of ATTACHMENT_IDS.entries()) {
  const motif = MOTIFS[i] ?? `att#${attId}`
  process.stdout.write(`  ${motif} ... `)

  const res = await fetch(`${API}/sync-thumbnails`, {
    method: 'POST',
    headers: { 'X-Miad-Products-Secret': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ attachmentIds: [attId] }),
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

  const synced = r.sizes_synced ?? '?'
  const state  = r.r2_state  ?? '?'
  console.log(`✅  sizes_synced=${synced}  r2_state=${state}`)
  for (const [size, url] of Object.entries(r.sizes ?? {})) {
    if (['woocommerce_gallery_thumbnail','woocommerce_thumbnail','thumbnail'].includes(size))
      console.log(`     ${size.padEnd(30)}: ${url}`)
  }
  console.log()
}
console.log('✅ Terminé !')

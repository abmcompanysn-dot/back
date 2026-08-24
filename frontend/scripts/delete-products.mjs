#!/usr/bin/env node
// Supprime des produits WC via set-author vers un vendeur inexistant
// En fait : met en corbeille via wp_trash_post via un endpoint dédié
// Usage: node scripts/delete-products.mjs <id1> <id2> ...
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
const ids    = process.argv.slice(2).map(Number)
if (!ids.length) { console.error('Usage: node delete-products.mjs <id1> <id2>...'); process.exit(1) }

// On met en brouillon (draft) les produits doublons — plus sûr que de supprimer
const updates = ids.map(id => ({ id, name: `[DOUBLON-A-SUPPRIMER] ${id}` }))
const res = await fetch(API + '/update-name', {
  method: 'POST',
  headers: { 'X-Miad-Products-Secret': SECRET, 'Content-Type': 'application/json' },
  body: JSON.stringify({ updates }),
})
const data = await res.json().catch(() => ({}))
console.log(`Marquage doublons: ${data.updated} produits renommés [DOUBLON-A-SUPPRIMER]`)
console.log('→ Supprime-les dans WP Admin > Produits > cherche "DOUBLON"')

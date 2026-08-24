#!/usr/bin/env node
/**
 * Réassigne le post_author (vendeur Dokan) de plusieurs produits WooCommerce.
 * Appelle directement miad-products/v1/set-author depuis la machine locale.
 *
 * Variables requises (.env.local) :
 *   MIAD_PRODUCTS_API     ex: https://api.miadmarket.com/wp-json/miad-products/v1
 *   MIAD_PRODUCTS_SECRET  clé affichée sur Outils > MIAD Products API
 *
 * Usage :
 *   node scripts/set-author.mjs <authorId> <id1> <id2> ...
 *
 * Exemple :
 *   node scripts/set-author.mjs 29 20820 22215 22222
 */

import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.join(__dirname, '..', '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const API    = (process.env.MIAD_PRODUCTS_API || 'https://api.miadmarket.com/wp-json/miad-products/v1').replace(/\/$/, '')
const SECRET = process.env.MIAD_PRODUCTS_SECRET

if (!SECRET) {
  console.error('❌ MIAD_PRODUCTS_SECRET manquant dans .env.local')
  process.exit(1)
}

const [,, authorIdArg, ...idArgs] = process.argv
if (!authorIdArg || !idArgs.length) {
  console.error('❌ Usage : node scripts/set-author.mjs <authorId> <id1> <id2> ...')
  process.exit(1)
}

const authorId = parseInt(authorIdArg, 10)
const ids      = idArgs.map(n => parseInt(n, 10))

console.log(`→ Transfert de ${ids.length} produit(s) vers author=${authorId}`)
console.log('  IDs :', ids.join(', '))

const res = await fetch(`${API}/set-author`, {
  method: 'POST',
  headers: { 'X-Miad-Products-Secret': SECRET, 'Content-Type': 'application/json' },
  body: JSON.stringify({ ids, authorId }),
})

const data = await res.json().catch(() => ({}))

if (!res.ok) {
  console.error(`❌ Erreur ${res.status} :`, data)
  process.exit(1)
}

console.log(`✅ Succès — ${data.updated} produit(s) mis à jour`)
if (data.errors?.length) console.warn('⚠️  Erreurs sur :', data.errors)

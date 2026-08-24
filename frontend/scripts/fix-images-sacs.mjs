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
// Les fichiers sont bien sur R2 mais via pub-*.r2.dev, pas cdn.miadmarket.com
const R2DEV = 'https://pub-5830f37957e94da4a6855da37b632a3a.r2.dev'

const products = [
  { id: 39774, key: 'malaakas/sac-vip-denim-kente-soleil-1782944069988.jpg' },
  { id: 39778, key: 'malaakas/sac-vip-nuit-bogolan-g-o-1782944077678.jpg' },
  { id: 39782, key: 'malaakas/sac-vip-rouge-wax-clair-1782944083289.jpg' },
  { id: 39786, key: 'malaakas/sac-vip-bordeaux-kente-fleur-1782944088798.jpg' },
  { id: 39790, key: 'malaakas/sac-vip-chocolat-bogolan-1782944094061.jpg' },
  { id: 39794, key: 'malaakas/sac-vip-denim-splash-arc-en-ciel-1782944103511.jpg' },
  { id: 39798, key: 'malaakas/sac-vip-naturel-kente-mandala-1782944111481.jpg' },
  { id: 39802, key: 'malaakas/sac-vip-caramel-arabesque-1782944117065.jpg' },
  { id: 39806, key: 'malaakas/sac-vip-nuit-kente-soleil-1782944122602.jpg' },
  { id: 39810, key: 'malaakas/sac-vip-orange-soleil-arabesque-1782944127914.jpg' },
]

console.log('🖼  Correction des images — appel /set-image avec URLs R2.dev\n')

for (const { id, key } of products) {
  const imageUrl = `${R2DEV}/${key}`
  const res = await fetch(`${API}/set-image`, {
    method: 'POST',
    headers: { 'X-Miad-Products-Secret': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: id, imageUrl }),
  })
  const data = await res.json().catch(() => ({}))
  console.log(res.ok
    ? `  ✅ ${id} — attachment=${data.attachment_id}  r2=${data.r2_url || '(sync async)'}`
    : `  ❌ ${id} — ${JSON.stringify(data)}`)
  await new Promise(r => setTimeout(r, 1000))
}
console.log('\n✅ Terminé !')

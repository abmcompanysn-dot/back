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

const IDS = [39774, 39778, 39782, 39786, 39790, 39794, 39798, 39802, 39806, 39810]

const res = await fetch(`${API}/clear-cache`, {
  method: 'POST',
  headers: { 'X-Miad-Products-Secret': SECRET, 'Content-Type': 'application/json' },
  body: JSON.stringify({ ids: IDS }),
})
const data = await res.json().catch(() => ({}))
console.log(res.ok ? `✅ Cache vidé pour ${data.cleared} produits` : `❌ ${JSON.stringify(data)}`)

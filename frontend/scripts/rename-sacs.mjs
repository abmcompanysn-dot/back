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

const updates = [
  { id: 39774, name: 'SAC+POCHETTE VIP — Denim & Kente Soleil' },
  { id: 39778, name: 'SAC+POCHETTE VIP — Nuit Bogolan Géo' },
  { id: 39782, name: 'SAC+POCHETTE VIP — Rouge Wax Éclair' },
  { id: 39786, name: 'SAC+POCHETTE VIP — Bordeaux Kente Fleur' },
  { id: 39790, name: 'SAC+POCHETTE VIP — Chocolat Bogolan' },
  { id: 39794, name: 'SAC+POCHETTE VIP — Denim Splash Arc-en-ciel' },
  { id: 39798, name: 'SAC+POCHETTE VIP — Naturel Kente Mandala' },
  { id: 39802, name: 'SAC+POCHETTE VIP — Caramel Arabesque' },
  { id: 39806, name: 'SAC+POCHETTE VIP — Nuit Kente Soleil' },
  { id: 39810, name: 'SAC+POCHETTE VIP — Orange Soleil Arabesque' },
]

const res = await fetch(API + '/update-name', {
  method: 'POST',
  headers: { 'X-Miad-Products-Secret': SECRET, 'Content-Type': 'application/json' },
  body: JSON.stringify({ updates }),
})
const data = await res.json().catch(() => ({}))
console.log(res.ok ? `✅ ${data.updated} produits renommés` : `❌ ${JSON.stringify(data)}`)

#!/usr/bin/env node
// Restaure la copie locale d'un ou plusieurs attachments déjà synchronisés
// sur R2, à leur chemin d'origine exact — répare les URLs externes (ex:
// gravatar Dokan) qui pointent encore vers l'ancien fichier local supprimé.
//
// Usage : node scripts/restore-local-copy.mjs <attachmentId1> <attachmentId2> ...
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
  console.error('❌ Fournir au moins un attachment ID')
  process.exit(1)
}

console.log(`\n🔄 Restauration locale pour ${ids.length} attachment(s)...\n`)

for (const attachmentId of ids) {
  process.stdout.write(`  attachment ${attachmentId} ... `)
  try {
    const res = await fetch(`${API}/restore-local-copy`, {
      method: 'POST',
      headers: { 'X-Miad-Products-Secret': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachmentId }),
      signal: AbortSignal.timeout(30000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      console.log(`❌ HTTP ${res.status} — ${JSON.stringify(data)}`)
      continue
    }
    console.log(`✅  ${data.local_path}`)
  } catch (e) {
    console.log(`❌ ${e.message}`)
  }
}
console.log('\n✅ Terminé !')

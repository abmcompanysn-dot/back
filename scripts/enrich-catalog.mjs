#!/usr/bin/env node
// enrich-catalog.mjs — Phase 2 de l'enrichissement produit MIAD Market.
//
// Rédige à la main (par l'agent), pour chaque produit d'une boutique :
//   - subtitle    : une ligne d'accroche sous le nom
//   - description  : texte long structuré (accroche + détails + usage + entretien)
//   - tags         : mots-clés de recherche
//   - specifications : tableau [{k,v,source:'vendor'}] (matière, dimensions…)
//
// et applique ces contenus via PATCH /products/{id} sur catalog-svc — pour
// la fiche FR ET sa jumelle EN (linked.id résolu automatiquement).
//
// FLUX (une boutique à la fois, validation avant application — règle du
// fondateur : toujours un dry-run avant d'écrire) :
//
//   node scripts/enrich-catalog.mjs pull   <vendor_id>
//        -> écrit scripts/catalog-enrich/<vendor_id>.pull.json
//           (id FR, id EN, nom, catégorie, description existante, variations)
//
//   [l'agent rédige scripts/catalog-enrich/<vendor_id>.content.json]
//        { "<id_fr>": { subtitle_fr, subtitle_en, description_fr,
//                       description_en, tags, specifications:[{k,v}] }, ... }
//
//   node scripts/enrich-catalog.mjs apply  <vendor_id> --dry-run
//        -> montre exactement ce qui serait envoyé (aucune écriture)
//
//   node scripts/enrich-catalog.mjs apply  <vendor_id>
//        -> PATCH réel, FR + EN, avec pause de 150 ms entre produits
//
//   node scripts/enrich-catalog.mjs verify <vendor_id>
//        -> relit les fiches et confirme que subtitle/specs sont bien en base
//
// ENV (lus depuis .env.local à la racine, comme les autres scripts) :
//   MIAD_API_BASE     défaut https://origin.miadmarket.ca  (catalog-svc public)
//   MIAD_ADMIN_TOKEN  JWT admin (envoyé en Bearer ; catalog-svc l'ignore
//                     aujourd'hui mais on le passe par cohérence / au cas où
//                     une auth serait ajoutée sur /products*).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT_DIR = join(__dirname, 'catalog-enrich')

// ---- env ----------------------------------------------------------------
function loadEnv() {
  const p = join(ROOT, '.env.local')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1')
    }
  }
}
loadEnv()

const API_BASE = (process.env.MIAD_API_BASE || 'https://origin.miadmarket.ca').replace(/\/$/, '')
const ADMIN_TOKEN = process.env.MIAD_ADMIN_TOKEN || ''

// ---- utils ------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

async function api(path, opts = {}, tries = 4) {
  const url = path.startsWith('http') ? path : API_BASE + path
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.headers || {}),
        },
      })
      const text = await res.text()
      let body
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        body = { _raw: text }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url} :: ${text.slice(0, 300)}`)
      return body
    } catch (e) {
      lastErr = e
      if (i < tries - 1) await sleep(1200 * (i + 1))
    }
  }
  throw lastErr
}

async function listVendorProducts(vendorId) {
  const rows = []
  let page = 1
  for (;;) {
    const d = await api(`/products?admin=true&vendor_id=${vendorId}&page_size=100&page=${page}`)
    const items = d.items || d.products || []
    rows.push(...items)
    const more = d.has_more ?? items.length === 100
    if (!more || items.length === 0) break
    page++
    if (page > 40) break
  }
  return rows
}

// ---- commands -------------------------------------------------------
async function cmdPull(vendorId) {
  mkdirSync(OUT_DIR, { recursive: true })
  const list = await listVendorProducts(vendorId)
  console.log(`${list.length} produits FR pour la boutique #${vendorId}`)
  const out = []
  for (const p of list) {
    // GET détail pour la description réelle (absente du list projection) +
    // linked.id (jumelle EN) + variations.
    const d = await api(`/products/${p.id}`)
    out.push({
      id: p.id,
      id_en: d.linked?.id || null,
      trid: p.trid,
      name: decodeEntities(p.name),
      category: p.category_name || p.category_slug || '',
      category_slug: p.category_slug || '',
      is_variable: p.is_variable,
      price_usd: p.price_usd,
      variation_labels: (d.variations || [])
        .map((v) => Object.values(v.attributes || {}).join('/'))
        .filter(Boolean),
      current_description: decodeEntities(d.description || ''),
      current_subtitle: d.subtitle || '',
      current_specs: d.specifications || [],
      current_tags: p.tags || [],
      image: p.image || (p.images || [])[0]?.src || '',
    })
    await sleep(60)
  }
  const file = join(OUT_DIR, `${vendorId}.pull.json`)
  writeFileSync(file, JSON.stringify(out, null, 2))
  console.log(`→ ${file}`)
  console.log(`Prochaine étape : rédiger ${vendorId}.content.json puis \`apply ${vendorId} --dry-run\``)
}

function loadContent(vendorId) {
  const file = join(OUT_DIR, `${vendorId}.content.json`)
  if (!existsSync(file)) {
    console.error(`Fichier de contenu absent : ${file}`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}
function loadPull(vendorId) {
  const file = join(OUT_DIR, `${vendorId}.pull.json`)
  if (!existsSync(file)) {
    console.error(`Fichier pull absent : ${file} — lancer d'abord \`pull ${vendorId}\``)
    process.exit(1)
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

// Construit le corps PATCH pour une langue donnée.
function bodyFor(lang, c) {
  const specs = (c.specifications || [])
    .map((s) => ({ k: String(s.k || '').trim(), v: String(s.v || '').trim(), source: 'vendor' }))
    .filter((s) => s.k && s.v)
  return {
    subtitle: lang === 'en' ? c.subtitle_en ?? c.subtitle_fr ?? '' : c.subtitle_fr ?? '',
    description: lang === 'en' ? c.description_en ?? '' : c.description_fr ?? '',
    tags: Array.isArray(c.tags) ? c.tags : [],
    specifications: specs,
  }
}

async function cmdApply(vendorId, dryRun) {
  const pull = loadPull(vendorId)
  const content = loadContent(vendorId)
  const byId = new Map(pull.map((p) => [String(p.id), p]))

  const ids = Object.keys(content)
  let done = 0
  let skipped = 0
  const missingEn = []

  for (const idFr of ids) {
    const c = content[idFr]
    const meta = byId.get(String(idFr))
    if (!meta) {
      console.warn(`  ! ${idFr} : absent du pull, ignoré`)
      skipped++
      continue
    }
    if (!c.description_fr || !c.subtitle_fr) {
      console.warn(`  ! ${idFr} (${meta.name}) : description_fr/subtitle_fr manquant, ignoré`)
      skipped++
      continue
    }
    const frBody = bodyFor('fr', c)
    const enBody = bodyFor('en', c)

    if (dryRun) {
      console.log(`\n#${idFr}  ${meta.name}`)
      console.log(`  FR sous-titre : ${frBody.subtitle}`)
      console.log(`  FR desc (${frBody.description.length} c.) : ${frBody.description.slice(0, 120).replace(/\n/g, ' ')}…`)
      console.log(`  tags : ${frBody.tags.join(', ')}`)
      console.log(`  specs : ${frBody.specifications.map((s) => `${s.k}=${s.v}`).join(' | ')}`)
      console.log(`  EN id : ${meta.id_en || '(aucune jumelle — EN non appliqué)'}`)
      if (meta.id_en && (!c.description_en || !c.subtitle_en)) {
        console.log(`  ⚠ description_en/subtitle_en manquant — EN recevrait des champs vides`)
      }
      done++
      continue
    }

    await api(`/products/${idFr}`, { method: 'PATCH', body: JSON.stringify(frBody) })
    if (meta.id_en) {
      if (!c.description_en || !c.subtitle_en) {
        missingEn.push(idFr)
      } else {
        await api(`/products/${meta.id_en}`, { method: 'PATCH', body: JSON.stringify(enBody) })
      }
    }
    done++
    process.stdout.write(`\r  appliqué ${done}/${ids.length}   `)
    await sleep(150)
  }

  console.log()
  console.log(`${dryRun ? '[DRY-RUN] ' : ''}${done} produit(s) traité(s), ${skipped} ignoré(s).`)
  if (missingEn.length) {
    console.log(`⚠ EN non appliqué (contenu anglais manquant) pour : ${missingEn.join(', ')}`)
  }
}

async function cmdVerify(vendorId) {
  const content = loadContent(vendorId)
  const pull = loadPull(vendorId)
  const byId = new Map(pull.map((p) => [String(p.id), p]))
  let ok = 0
  let bad = 0
  for (const idFr of Object.keys(content)) {
    const meta = byId.get(String(idFr))
    const d = await api(`/products/${idFr}`)
    const hasSub = Boolean(d.subtitle)
    const hasSpecs = Array.isArray(d.specifications) && d.specifications.length > 0
    const hasDesc = (d.description || '').length > 150
    const good = hasSub && hasSpecs && hasDesc
    console.log(`  ${good ? '✓' : '✗'} #${idFr} ${meta?.name || ''}  sub:${hasSub} specs:${d.specifications?.length || 0} desc:${(d.description || '').length}c`)
    good ? ok++ : bad++
    await sleep(60)
  }
  console.log(`\n${ok} OK, ${bad} incomplet(s).`)
}

// ---- main ----------------------------------------------------------
const [, , cmd, vendorArg, ...rest] = process.argv
const dryRun = rest.includes('--dry-run')

if (!cmd || !vendorArg) {
  console.log('usage : node scripts/enrich-catalog.mjs <pull|apply|verify> <vendor_id> [--dry-run]')
  process.exit(1)
}
const vendorId = Number(vendorArg)

const run = { pull: cmdPull, apply: (v) => cmdApply(v, dryRun), verify: cmdVerify }[cmd]
if (!run) {
  console.error(`commande inconnue : ${cmd}`)
  process.exit(1)
}
run(vendorId).catch((e) => {
  console.error('\nÉCHEC :', e.message)
  process.exit(1)
})

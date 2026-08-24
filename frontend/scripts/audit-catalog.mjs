#!/usr/bin/env node
/**
 * audit-catalog.mjs — Audit et nettoyage du catalogue produits MIAD Market
 *
 * node scripts/audit-catalog.mjs scan                 Analyse le catalogue (lecture seule), écrit un rapport
 * node scripts/audit-catalog.mjs scan --apply          Idem + tague "a-verifier" les produits concernés
 * node scripts/audit-catalog.mjs scan --apply --email  Idem + envoie le rapport par email à l'admin
 * node scripts/audit-catalog.mjs vendors-empty         Liste les boutiques Dokan sans aucun produit
 * node scripts/audit-catalog.mjs versions              Compare version WP/WooCommerce actuelle vs disponible
 *
 * Purge Cloudflare : volontairement absente de ce script — le fondateur la
 * fait lui-même après avoir validé un --apply. Mise à jour WordPress/WooCommerce
 * : volontairement absente aussi, cet agent n'a pas d'accès serveur (SSH/WP-CLI/
 * fichiers) pour faire un backup avant mise à jour — seule la comparaison de
 * version est possible depuis l'API REST.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const envPath = 'C:/Users/Admin/OneDrive/Pictures/im/Desktop/v0-miad-front-end/.env.local'
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}
const API    = (process.env.MIAD_PRODUCTS_API ?? '').replace(/\/$/, '').replace('/miad-products/', '/miad-audit/')
const SECRET = process.env.MIAD_PRODUCTS_SECRET ?? ''
if (!API || !SECRET) {
  console.error('❌ MIAD_PRODUCTS_API et MIAD_PRODUCTS_SECRET requis dans .env.local')
  process.exit(1)
}

async function api(method, route, body) {
  const res = await fetch(`${API}/${route}`, {
    method,
    headers: { 'X-Miad-Products-Secret': SECRET, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`)
  return data
}

function buildMarkdownReport(scan, emptyVendors) {
  const lines = []
  lines.push(`# Rapport d'audit catalogue MIAD Market`)
  lines.push(`_${new Date().toISOString()}_\n`)

  lines.push(`## Produits sans image (${scan.counts.no_image})`)
  for (const p of scan.no_image) lines.push(`- #${p.ID} — ${p.post_title}`)
  if (!scan.no_image.length) lines.push('_Aucun_')

  lines.push(`\n## Produits variables sans variation (${scan.counts.variable_no_variations})`)
  for (const p of scan.variable_no_variations) lines.push(`- #${p.ID} — ${p.post_title}`)
  if (!scan.variable_no_variations.length) lines.push('_Aucun_')

  lines.push(`\n## Variations sans prix (${scan.counts.bad_variations})`)
  for (const v of scan.bad_variations) lines.push(`- variation #${v.id} (produit parent #${v.parent_id})`)
  if (!scan.bad_variations.length) lines.push('_Aucune_')

  lines.push(`\n## Anomalies (${scan.counts.anomalies})`)
  for (const a of scan.anomalies) lines.push(`- #${a.id} — ${a.title} — **${a.reason}**`)
  if (!scan.anomalies.length) lines.push('_Aucune_')

  if (emptyVendors) {
    lines.push(`\n## Boutiques sans produit (${emptyVendors.count})`)
    for (const v of emptyVendors.empty_vendors) lines.push(`- #${v.vendor_id} — ${v.store_name} (${v.email})`)
    if (!emptyVendors.count) lines.push('_Aucune_')
  }

  return lines.join('\n')
}

function uniqueAffectedIds(scan) {
  const ids = new Set()
  for (const p of scan.no_image) ids.add(Number(p.ID))
  for (const p of scan.variable_no_variations) ids.add(Number(p.ID))
  for (const a of scan.anomalies) ids.add(Number(a.id))
  return [...ids]
}

async function cmdScan(flags) {
  console.log('\n⏳ Scan du catalogue...')
  const scan = await api('GET', 'scan')
  console.log(`   📷 Sans image        : ${scan.counts.no_image}`)
  console.log(`   🧩 Variable sans var. : ${scan.counts.variable_no_variations}`)
  console.log(`   💲 Variations sans prix : ${scan.counts.bad_variations}`)
  console.log(`   ⚠️  Anomalies         : ${scan.counts.anomalies}`)

  let emptyVendors = null
  if (flags['include-vendors']) {
    emptyVendors = await api('GET', 'vendors-empty')
    console.log(`   🏪 Boutiques vides    : ${emptyVendors.count}`)
  }

  const reportDir = 'C:/Users/Admin/AppData/Local/Temp/claude/c--Users-Admin-OneDrive-Pictures-im-Desktop-v0-miad-front-end/1db7c2ea-3181-4b57-a12e-5cf5d94f09b6/scratchpad'
  mkdirSync(reportDir, { recursive: true })
  const reportPath = join(reportDir, `audit-report-${Date.now()}.md`)
  const markdown = buildMarkdownReport(scan, emptyVendors)
  writeFileSync(reportPath, markdown, 'utf8')
  console.log(`\n📄 Rapport écrit : ${reportPath}`)

  if (flags.apply) {
    const ids = uniqueAffectedIds(scan)
    if (ids.length) {
      console.log(`\n🏷️  Tag "a-verifier" sur ${ids.length} produit(s)...`)
      const r = await api('POST', 'apply', { productIds: ids })
      console.log(`   ✅ ${r.tagged.length} tagué(s), ${r.errors.length} erreur(s)`)
    } else {
      console.log('\n✅ Rien à appliquer, catalogue propre.')
    }
  } else {
    console.log('\nℹ️  Mode dry-run (par défaut) — rien n\'a été modifié. Relance avec --apply pour taguer "a-verifier".')
  }

  if (flags.email) {
    console.log('\n📧 Envoi du rapport par email...')
    const html = '<pre style="font-family:monospace;white-space:pre-wrap">' + markdown.replace(/</g, '&lt;') + '</pre>'
    const r = await api('POST', 'send-report', { subject: `Rapport d'audit catalogue — ${new Date().toLocaleDateString('fr-FR')}`, html })
    console.log(r.ok ? `   ✅ Envoyé à ${r.sent_to}` : `   ❌ Échec d'envoi`)
  }
}

async function cmdVendorsEmpty() {
  console.log('\n⏳ Recherche des boutiques sans produit...')
  const r = await api('GET', 'vendors-empty')
  console.log(`\n🏪 ${r.count} boutique(s) sans aucun produit :`)
  for (const v of r.empty_vendors) console.log(`   #${v.vendor_id} — ${v.store_name} (${v.email})`)
}

async function cmdVersions() {
  console.log('\n⏳ Vérification des versions...')
  const r = await api('GET', 'versions')
  console.log(`\n   WordPress   : ${r.wordpress.current}${r.wordpress.update_available ? ` → ${r.wordpress.latest} disponible` : ' (à jour)'}`)
  console.log(`   WooCommerce : ${r.woocommerce.current}${r.woocommerce.update_available ? ` → ${r.woocommerce.latest} disponible` : ' (à jour)'}`)
  if (r.wordpress.update_available || r.woocommerce.update_available) {
    console.log('\n⚠️  Mise à jour disponible — cet agent ne peut pas l\'appliquer (pas d\'accès serveur/WP-CLI/SSH).')
    console.log('   Fais la mise à jour toi-même via WP Admin ou ton panneau d\'hébergement, après avoir fait un backup DB + fichiers.')
  }
}

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (const arg of argv) {
    if (arg.startsWith('--')) flags[arg.slice(2)] = true
    else positional.push(arg)
  }
  return { flags, positional }
}

const [,, command, ...rest] = process.argv
const { flags } = parseArgs(rest)

try {
  switch (command) {
    case 'scan':          await cmdScan(flags); break
    case 'vendors-empty': await cmdVendorsEmpty(); break
    case 'versions':      await cmdVersions(); break
    default:
      console.log(`
audit-catalog.mjs — Audit du catalogue MIAD Market

  node scripts/audit-catalog.mjs scan [--apply] [--email] [--include-vendors]
  node scripts/audit-catalog.mjs vendors-empty
  node scripts/audit-catalog.mjs versions
`)
      process.exit(command ? 1 : 0)
  }
} catch (e) {
  console.error(`\n❌ Erreur : ${e.message}`)
  process.exit(1)
}

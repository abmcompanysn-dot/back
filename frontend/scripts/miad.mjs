#!/usr/bin/env node
/**
 * miad.mjs — CLI tout-en-un MIAD Market
 *
 * node scripts/miad.mjs create           --name "..." --price 8500 --vendor 95 --image <url>
 * node scripts/miad.mjs create-variable  --name "..." --vendor 95 --image <url> --attr "Commande" --variation "1 pièce:15000" --variation "3 pièces:40000"
 * node scripts/miad.mjs sync             <id1> <id2> ...
 * node scripts/miad.mjs set-author       --vendor 95 <id1> <id2> ...
 * node scripts/miad.mjs set-image        --product <id> --image <url>
 * node scripts/miad.mjs set-price        --price 8500 <var-id1> <var-id2> ...
 * node scripts/miad.mjs clear-cache      <id1> <id2> ...
 * node scripts/miad.mjs links            <id1> <id2> ...
 * node scripts/miad.mjs rename           --id <id> --name "Nouveau nom"
 * node scripts/miad.mjs create-vendor    --store-name "..." --email vendeur@exemple.com --country SN
 * node scripts/miad.mjs delete-vendor    --vendor 146
 * node scripts/miad.mjs sync-embeddings  --all   (ou une liste d'IDs produits)
 */
import { readFileSync, existsSync } from 'fs'

// ── Env ────────────────────────────────────────────────────────────────────────
const envPath = 'C:/Users/Admin/OneDrive/Pictures/im/Desktop/v0-miad-front-end/.env.local'
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}
const API    = (process.env.MIAD_PRODUCTS_API ?? '').replace(/\/$/, '')
const SECRET = process.env.MIAD_PRODUCTS_SECRET ?? ''
if (!API || !SECRET) {
  console.error('❌ MIAD_PRODUCTS_API et MIAD_PRODUCTS_SECRET requis dans .env.local')
  process.exit(1)
}

// Site Next.js/Cloudflare Pages (miadmarket.com) — utilisé uniquement pour les
// endpoints qui dépendent des bindings Cloudflare (AI, Vectorize), qui n'existent
// pas côté WordPress. Tout le reste des commandes passe par MIAD_PRODUCTS_API.
const SITE_URL        = (process.env.MIAD_SITE_URL || 'https://miadmarket.com').replace(/\/$/, '')
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? ''

// miad-audit/v1 est un namespace REST séparé (même plugin family), dérivé de
// MIAD_PRODUCTS_API pour éviter une 2e variable d'env juste pour ça.
const AUDIT_API = API.replace(/miad-products\/v1$/, 'miad-audit/v1')

// wc/v3 direct (Basic Auth) — seulement pour les catégories (images de bannière),
// pas les produits : contrairement aux produits/variations, aucun incident WPML
// connu sur l'image d'une catégorie, donc pas besoin de passer par le plugin custom.
const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || '').replace(/\/$/, '')
const WOO_CK  = process.env.WOO_CONSUMER_KEY ?? ''
const WOO_CS  = process.env.WOO_CONSUMER_SECRET ?? ''

// ── HTTP ───────────────────────────────────────────────────────────────────────
async function api(route, body, timeout = 90_000) {
  const res = await fetch(`${API}/${route}`, {
    method: 'POST',
    headers: { 'X-Miad-Products-Secret': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`)
  return data
}

async function auditApi(route, timeout = 60_000) {
  const res = await fetch(`${AUDIT_API}/${route}`, {
    method: 'GET',
    headers: { 'X-Miad-Products-Secret': SECRET },
    signal: AbortSignal.timeout(timeout),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`)
  return data
}

async function siteApi(route, body, timeout = 120_000) {
  const res = await fetch(`${SITE_URL}/${route}`, {
    method: 'POST',
    headers: { 'X-Internal-Secret': INTERNAL_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`)
  return data
}

// ── Args ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const flags = {}
  const positional = []
  let i = 0
  while (i < argv.length) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const hasVal = i + 1 < argv.length && !argv[i + 1].startsWith('--')
      if (hasVal) {
        const val = argv[i + 1]
        flags[key] = flags[key] !== undefined ? [].concat(flags[key], val) : val
        i += 2
      } else {
        flags[key] = true
        i++
      }
    } else {
      positional.push(argv[i])
      i++
    }
  }
  return { flags, positional }
}

const arr = v => (v == null ? [] : [].concat(v))

// ── Taux de conversion CAD → USD ────────────────────────────────────────────────
// --price/--cost sont stockés tels quels dans WooCommerce en USD réel (aucune
// conversion côté serveur, vérifié dans miad-products-api.php + sur des
// produits publiés) — le site affiche ensuite plusieurs devises (FCFA, EUR...)
// calculées à partir de ce montant USD. Donc un prix reçu en CAD doit être
// converti en USD, pas en FCFA (corrigé le 2026-07-25 — l'ancien taux CAD→FCFA
// à 450 aurait produit un prix ~630x trop élevé si jamais utilisé). Voir
// CLAUDE.md pour la règle complète.
const CAD_TO_USD_RATE = 0.71
const cadToUsd = cad => Math.round(parseFloat(cad) * CAD_TO_USD_RATE * 100) / 100

// ── Help ───────────────────────────────────────────────────────────────────────
const HELP = `
miad.mjs — CLI tout-en-un MIAD Market
Utilisation : node scripts/miad.mjs <commande> [options]

COMMANDES
  create           Créer un produit simple
  create-variable  Créer un produit variable avec variations
  sync             Synchroniser images → R2/CDN  (par ID produit)
  set-author       Réassigner le vendeur (post_author)
  set-image        Changer l'image vedette d'un produit
  set-price        Changer le prix de variations
  clear-cache      Vider le cache WooCommerce
  links            Afficher permaliens + image CDN
  rename           Renommer un produit
  create-vendor    Créer un compte vendeur Dokan
  set-vendor-images  Poser le logo et/ou la bannière d'un vendeur (override CDN)
  delete-vendor    Supprimer un compte vendeur (refusé s'il a des produits)
  sync-embeddings  Générer les embeddings (Workers AI) et upsert dans Vectorize
  audit-categories Lister la répartition par catégorie + détecter les incohérences titre/catégorie
  audit-language   Détecter les produits dont le nom/description semblent en anglais (pas en français)
  set-category     Réassigner la catégorie d'un ou plusieurs produits
  set-tags         Poser des tags WooCommerce (mots-clés recherche) sur un ou plusieurs produits
  set-category-image  Définir l'image de bannière d'une catégorie WooCommerce

TAUX CAD → USD
  1 CAD = ${CAD_TO_USD_RATE} USD (corrigé le 2026-07-25 — --price/--cost sont
  stockés en USD réel, pas en FCFA). Utilise --price-cad / --variation-cad
  quand un vendeur donne un prix en dollars canadiens — conversion
  automatique, jamais à la main.

OPTIONS — create
  --name            Nom du produit (requis)
  --price           Prix en dollars US (stocké tel quel, sans conversion — le
                    site affiche ensuite en FCFA/EUR/... selon la devise choisie)
  --price-cad       Prix en CAD (converti en USD au taux fixe, alternative à --price)
  --cost            Prix de revient (alternative à --price)
  --markup          Marge en % (avec --cost)
  --vendor          ID vendeur Dokan
  --vendor-email    Email vendeur (alternative à --vendor)
  --category        Nom de la catégorie
  --description     Description longue
  --short-desc      Description courte
  --sku             Référence produit
  --stock           Quantité en stock
  --status          publish | draft | pending  (défaut: publish)
  --image           URL image (répétable pour galerie)
  --name-en         Nom en anglais (crée automatiquement une traduction WPML EN)
  --description-en  Description longue en anglais
  --short-desc-en   Description courte en anglais

OPTIONS — create-variable
  Mêmes que create, plus :
  --attr            Nom de l'attribut  (défaut: "Commande")
  --variation       "label:prix"  (répétable, ex: "1 pièce:15", prix en USD)
  --variation-cad   "label:prixCAD"  (répétable, converti en USD au taux fixe)
  --variation-en    "label fr:label en"  (répétable — traduit un label de
                    variation précis, ex: "1 pièce:1 piece" ; les labels non
                    listés — tailles numériques par ex. — restent identiques
                    côté EN)

OPTIONS — sync / clear-cache / links
  IDs produits en arguments positionnels

OPTIONS — set-author
  --vendor          ID vendeur cible (requis)
  IDs produits en arguments positionnels

OPTIONS — set-image
  --product         ID produit (requis)
  --image           URL image vedette
  --gallery         URL image galerie (répétable)

OPTIONS — set-price
  --price           Nouveau prix en dollars US (requis, ou --price-cad)
  --price-cad       Nouveau prix en CAD (converti en USD au taux fixe)
  IDs des variations en arguments positionnels

OPTIONS — rename
  --id              ID produit (répétable)
  --name            Nouveau nom (répétable, même ordre que --id)

OPTIONS — audit-categories
  --out             Chemin d'un fichier JSON pour le rapport complet (optionnel)

OPTIONS — audit-language
  --out             Chemin d'un fichier JSON pour le rapport complet (optionnel)
  Lecture seule (wc/v3/products en direct, Basic Auth) — ne corrige rien,
  sert à préparer les corrections à faire ensuite (rename / update-product).

OPTIONS — set-category
  --category        Nom exact de la catégorie cible (requis, voir CLAUDE.md)
  IDs produits en arguments positionnels

OPTIONS — set-category-image
  --category-id     ID de la catégorie WooCommerce (requis, voir CLAUDE.md)
  --image           URL de l'image (CDN) à assigner (requis)

OPTIONS — create-vendor
  --store-name      Nom de la boutique (requis)
  --email           Email du vendeur (requis)
  --first-name      Prénom
  --last-name       Nom
  --country         Code pays ISO 2 lettres (ex: SN, GH, CM)
  --city            Ville
  --phone           Téléphone

OPTIONS — set-vendor-images
  --vendor          ID du vendeur (requis)
  --logo            URL CDN du logo (optionnel)
  --banner          URL CDN de la bannière (optionnel — au moins un des deux requis)

OPTIONS — delete-vendor
  --vendor          ID du vendeur à supprimer (requis)
                    Refusé si le vendeur a au moins 1 produit, sauf --force
  --force           Supprime aussi les produits du vendeur (irréversible)

OPTIONS — sync-embeddings
  --all             Ré-embed tout le catalogue publié
  IDs produits en arguments positionnels (alternative à --all)
  Nécessite un déploiement Cloudflare Pages à jour (bindings AI/VECTORIZE
  indisponibles en local next dev) — voir CLAUDE.md.

EXEMPLES
  node scripts/miad.mjs create --name "Collier Cauris" --price 8500 --vendor 95 --image https://cdn.miadmarket.com/...
  node scripts/miad.mjs create-variable --name "Sac VIP Bogolan" --vendor 95 --image https://... --attr "Commande" --variation "1 pièce:15000" --variation "3 pièces:40000"
  node scripts/miad.mjs sync 39478 39475 39472
  node scripts/miad.mjs set-author --vendor 95 39478 39475 39472
  node scripts/miad.mjs set-image --product 39478 --image https://cdn.miadmarket.com/...
  node scripts/miad.mjs set-price --price 8500 12345 12346
  node scripts/miad.mjs clear-cache 39478 39475
  node scripts/miad.mjs links 39478 39475 39472
  node scripts/miad.mjs rename --id 39478 --name "Nouveau nom du produit"
  node scripts/miad.mjs create-vendor --store-name "Ma Boutique" --email vendeur@exemple.com --country SN
`

// ── Commandes ──────────────────────────────────────────────────────────────────

async function cmdCreate(flags) {
  const name = flags.name
  if (!name) { console.error('❌ --name requis'); process.exit(1) }

  const body = { name }
  if (flags['price-cad'])    body.price           = cadToUsd(flags['price-cad'])
  if (flags.price)           body.price           = parseFloat(flags.price)
  if (flags.cost)            body.costPrice        = parseFloat(flags.cost)
  if (flags.markup)          body.markupPercent    = parseFloat(flags.markup)
  if (flags.vendor)          body.vendorId         = parseInt(flags.vendor)
  if (flags['vendor-email']) body.vendorEmail      = flags['vendor-email']
  if (flags.category)        body.category         = flags.category
  if (flags.description)     body.description      = flags.description
  if (flags['short-desc'])   body.shortDescription = flags['short-desc']
  if (flags['name-en'])        body.nameEn             = flags['name-en']
  if (flags['description-en']) body.descriptionEn      = flags['description-en']
  if (flags['short-desc-en'])  body.shortDescriptionEn = flags['short-desc-en']
  if (flags.sku)             body.sku              = flags.sku
  if (flags.stock != null)   body.stockQuantity    = parseInt(flags.stock)
  if (flags.status)          body.status           = flags.status
  const images = arr(flags.image)
  if (images.length)         body.images           = images

  if (flags['price-cad']) {
    console.log(`   💱 ${flags['price-cad']} CAD × ${CAD_TO_USD_RATE} = ${body.price} USD`)
  }
  console.log(`\n⏳ Création de "${name}"...`)
  const data = await api('create', body)
  console.log(`✅ Produit créé  ID ${data.product_id}`)
  console.log(`   🔗 ${data.permalink}`)
  console.log(`   💰 Prix : ${data.price} $`)
  if (body.nameEn) {
    console.log(data.product_id_en ? `   🇬🇧 Traduction EN créée  ID ${data.product_id_en}` : `   ⚠️  Traduction EN non créée (WPML absent ou trid introuvable)`)
  }
  for (const img of data.images ?? []) {
    console.log(`   🖼  ${img.r2_url ?? img.source_url}`)
  }

  // Sync automatique des miniatures — avant, c'était une étape manuelle
  // séparée (facile à oublier), ce qui laissait des vignettes cassées
  // (150x150, 300x300...) tant qu'on ne relançait pas `sync` à la main.
  if (images.length && data.product_id) {
    await autoSyncImages(data.product_id)
  }
}

/** Synchronise les miniatures d'un produit fraîchement créé — n'échoue jamais
 * la commande principale : le produit existe déjà même si le sync rate. */
async function autoSyncImages(productId) {
  process.stdout.write(`\n🔄 Sync automatique des images... `)
  try {
    const syncData = await api('sync-product-images', { productIds: [productId] })
    const r = syncData.results?.[0]
    if (!r?.ok) {
      console.log(`⚠️  ${r?.error ?? 'échec sync'} — relance manuelle : node scripts/miad.mjs sync ${productId}`)
    } else {
      console.log(`✅ sizes_synced=${r.sizes_synced}  r2_state=${r.r2_state}`)
    }
  } catch (e) {
    console.log(`⚠️  ${e.message} — relance manuelle : node scripts/miad.mjs sync ${productId}`)
  }
}

async function cmdCreateVariable(flags) {
  const name = flags.name
  if (!name) { console.error('❌ --name requis'); process.exit(1) }

  const rawVars = arr(flags.variation)
  const rawVarsCad = arr(flags['variation-cad'])
  if (!rawVars.length && !rawVarsCad.length) { console.error('❌ Au moins un --variation "label:prix" (ou --variation-cad "label:prixCAD") requis'); process.exit(1) }

  const parseVar = v => {
    const sep = v.lastIndexOf(':')
    return { label: v.slice(0, sep).trim(), rawPrice: v.slice(sep + 1) }
  }
  const variations = [
    ...rawVars.map(v => { const { label, rawPrice } = parseVar(v); return { label, price: parseFloat(rawPrice) } }),
    ...rawVarsCad.map(v => {
      const { label, rawPrice } = parseVar(v)
      const price = cadToUsd(rawPrice)
      console.log(`   💱 ${label} : ${rawPrice} CAD × ${CAD_TO_USD_RATE} = ${price} USD`)
      return { label, price }
    }),
  ]

  const body = { name, variations }
  if (flags.vendor)          body.vendorId         = parseInt(flags.vendor)
  if (flags.category)        body.category         = flags.category
  if (flags.description)     body.description      = flags.description
  if (flags['short-desc'])   body.shortDescription = flags['short-desc']
  if (flags['name-en'])        body.nameEn             = flags['name-en']
  if (flags['description-en']) body.descriptionEn      = flags['description-en']
  if (flags['short-desc-en'])  body.shortDescriptionEn = flags['short-desc-en']
  // --variation-en "label fr:label en" (répétable) : traduit uniquement les
  // labels donnés, ex. --variation-en "1 pièce:1 piece" — les labels non
  // listés (ex. tailles numériques) restent tels quels côté EN.
  const variationsEnLabels = {}
  for (const raw of arr(flags['variation-en'])) {
    const sep = raw.lastIndexOf(':')
    variationsEnLabels[raw.slice(0, sep).trim()] = raw.slice(sep + 1).trim()
  }
  if (Object.keys(variationsEnLabels).length) body.variationsEnLabels = variationsEnLabels
  if (flags.status)          body.status           = flags.status
  if (flags.attr)            body.attributeName    = flags.attr
  const imageUrl = arr(flags.image)[0]
  if (imageUrl)              body.imageUrl         = imageUrl

  console.log(`\n⏳ Création produit variable "${name}" (${variations.length} variations)...`)
  for (const v of variations) console.log(`   • ${v.label} : ${v.price} $`)

  const data = await api('create-variable', body)
  console.log(`✅ Produit créé  ID ${data.product_id}`)
  console.log(`   Variations : ${data.variation_ids?.join(', ')}`)
  if (data.r2_url) console.log(`   🖼  ${data.r2_url}`)
  if (body.nameEn) {
    console.log(data.product_id_en ? `   🇬🇧 Traduction EN créée  ID ${data.product_id_en}` : `   ⚠️  Traduction EN non créée (WPML absent ou trid introuvable)`)
  }

  // Garde-fou : si des variations ne sont pas rattachées à l'attribut du
  // parent, le produit affichera "Veuillez sélectionner vos options avant
  // d'acheter" en boucle côté site (régression du bug 'pa_' du 2026-07-08).
  // On le signale immédiatement plutôt que de le découvrir des semaines après.
  if (data.attributes_warning?.length) {
    console.error(`\n⚠️  ATTENTION : ${data.attributes_warning.length} variation(s) sans attribut rapproché (${data.attributes_warning.join(', ')}).`)
    console.error(`   Le produit ${data.product_id} affichera "Veuillez sélectionner vos options" en boucle sur le site.`)
    console.error(`   → Vérifier le plugin miad-products-api.php ou lancer /repair-variable-attributes.`)
  }

  if (imageUrl && data.product_id) {
    await autoSyncImages(data.product_id)
  }
}

async function cmdSync(positional) {
  const ids = positional.map(Number).filter(Boolean)
  if (!ids.length) { console.error('❌ Fournir au moins un ID produit'); process.exit(1) }

  console.log(`\n🔄 Sync images pour ${ids.length} produit(s)...\n`)
  for (const productId of ids) {
    process.stdout.write(`  Produit #${productId} ... `)
    try {
      const data = await api('sync-product-images', { productIds: [productId] })
      const r = data.results?.[0]
      if (!r?.ok) {
        console.log(`❌ ${r?.error ?? JSON.stringify(data)}`)
      } else {
        console.log(`✅  sizes_synced=${r.sizes_synced}  r2_state=${r.r2_state}`)
        if (r.wc_thumbnail) console.log(`     300x300 : ${r.wc_thumbnail}`)
        if (r.thumbnail)    console.log(`     150x150 : ${r.thumbnail}`)
      }
    } catch (e) {
      console.log(`❌ ${e.message}`)
    }
  }
  console.log('\n✅ Terminé !')
}

async function cmdSetAuthor(flags, positional) {
  const vendor = parseInt(flags.vendor)
  const ids = positional.map(Number).filter(Boolean)
  if (!vendor) { console.error('❌ --vendor <id> requis'); process.exit(1) }
  if (!ids.length) { console.error('❌ Fournir au moins un ID produit'); process.exit(1) }

  console.log(`\n⏳ Réassignation de ${ids.length} produit(s) → vendeur #${vendor}...`)
  const data = await api('set-author', { ids, authorId: vendor })
  console.log(`✅ ${data.updated} produit(s) mis à jour`)
  if (data.errors?.length) console.log(`⚠️  Erreurs sur : ${data.errors.join(', ')}`)
}

async function cmdSetImage(flags) {
  const productId = parseInt(flags.product)
  const imageUrl  = arr(flags.image)[0]
  const galleryUrls = arr(flags.gallery)
  if (!productId) { console.error('❌ --product <id> requis'); process.exit(1) }
  if (!imageUrl && !galleryUrls.length) { console.error('❌ --image <url> requis'); process.exit(1) }

  console.log(`\n⏳ Changement image produit #${productId}...`)
  const data = await api('set-image', { productId, imageUrl, galleryUrls })
  console.log(`✅ Image mise à jour  (attachment #${data.attachment_id})`)
  if (data.r2_url) console.log(`   🖼  ${data.r2_url}`)
}

async function cmdSetPrice(flags, positional) {
  const ids = positional.map(Number).filter(Boolean)
  if (!flags.price && !flags['price-cad']) { console.error('❌ --price <montant> (ou --price-cad <montant>) requis'); process.exit(1) }
  if (!ids.length) { console.error('❌ Fournir au moins un ID variation'); process.exit(1) }

  const price = flags['price-cad'] ? cadToUsd(flags['price-cad']) : flags.price
  if (flags['price-cad']) console.log(`   💱 ${flags['price-cad']} CAD × ${CAD_TO_USD_RATE} = ${price} USD`)

  console.log(`\n⏳ Prix ${price} $ → ${ids.length} variation(s)...`)
  const data = await api('set-variation-price', { variationIds: ids, price })
  console.log(`✅ ${data.updated} variation(s) mise(s) à jour  (produit #${data.product_id})`)
}

async function cmdClearCache(positional) {
  const ids = positional.map(Number).filter(Boolean)
  if (!ids.length) { console.error('❌ Fournir au moins un ID produit'); process.exit(1) }

  console.log(`\n⏳ Vidage cache pour ${ids.length} produit(s)...`)
  const data = await api('clear-cache', { ids })
  console.log(`✅ Cache vidé pour ${data.cleared} produit(s)`)
}

async function cmdLinks(positional) {
  const ids = positional.map(Number).filter(Boolean)
  if (!ids.length) { console.error('❌ Fournir au moins un ID produit'); process.exit(1) }

  const data = await api('permalinks', { ids })
  console.log()
  for (const p of data.products ?? []) {
    if (p.error) { console.log(`❌ ID ${p.id}: ${p.error}`); continue }
    console.log(`📦 ${p.name}  (ID ${p.id})`)
    console.log(`   🔗 ${p.permalink}`)
    console.log(`   🖼  ${p.image}`)
    console.log()
  }
}

async function cmdRename(flags) {
  const ids   = arr(flags.id).map(Number)
  const names = arr(flags.name)
  if (!ids.length || !names.length) {
    console.error('❌ --id <id> --name "Nouveau nom" requis')
    process.exit(1)
  }
  const updates = ids.map((id, i) => ({ id, name: names[i] ?? names[0] }))

  console.log(`\n⏳ Renommage de ${updates.length} produit(s)...`)
  const data = await api('update-name', { updates })
  console.log(`✅ ${data.updated} produit(s) renommé(s)`)
  if (data.errors?.length) console.log(`⚠️  Erreurs : ${JSON.stringify(data.errors)}`)
}

async function cmdCreateVendor(flags) {
  const storeName = flags['store-name']
  const email = flags.email
  if (!storeName) { console.error('❌ --store-name requis'); process.exit(1) }
  if (!email) { console.error('❌ --email requis'); process.exit(1) }

  const body = { storeName, email }
  if (flags['first-name']) body.firstName = flags['first-name']
  if (flags['last-name'])  body.lastName  = flags['last-name']
  if (flags.country)       body.country   = flags.country
  if (flags.city)          body.city      = flags.city
  if (flags.phone)         body.phone     = flags.phone

  console.log(`\n⏳ Création du vendeur "${storeName}" (${email})...`)
  const data = await api('create-vendor', body)
  console.log(`✅ Vendeur créé  ID ${data.vendor_id}  (identifiant : ${data.login})`)
  console.log(`   🏪 ${data.store_url}`)
  console.log(`   📧 Email envoyé à ${email} pour définir son mot de passe.`)
}

async function cmdSetVendorImages(flags) {
  const vendorId = Number(flags.vendor)
  if (!vendorId) { console.error('❌ --vendor <id> requis'); process.exit(1) }
  const logoUrl = flags.logo
  const bannerUrl = flags.banner
  if (!logoUrl && !bannerUrl) { console.error('❌ --logo et/ou --banner requis'); process.exit(1) }

  console.log(`\n⏳ Mise à jour logo/bannière du vendeur ${vendorId}...`)
  const body = { vendorId }
  if (logoUrl) body.logoUrl = logoUrl
  if (bannerUrl) body.bannerUrl = bannerUrl
  await api('set-vendor-images', body)
  console.log(`✅ Enregistré pour le vendeur ${vendorId}`)
  if (logoUrl) console.log(`   🖼  Logo : ${logoUrl}`)
  if (bannerUrl) console.log(`   🖼  Bannière : ${bannerUrl}`)
}

async function cmdSyncEmbeddings(flags, positional) {
  if (!INTERNAL_SECRET) { console.error('❌ INTERNAL_API_SECRET requis dans .env.local'); process.exit(1) }
  const ids = positional.map(Number).filter(Boolean)
  const all = !!flags.all
  if (!all && !ids.length) { console.error('❌ Fournir des IDs produits, ou --all pour tout le catalogue'); process.exit(1) }

  console.log(`\n⏳ Génération embeddings ${all ? '(catalogue complet)' : `pour ${ids.length} produit(s)`}...`)
  const data = await siteApi('api/admin/embeddings', all ? { all: true } : { productIds: ids })
  console.log(`✅ ${data.synced}/${data.total} produit(s) synchronisé(s) dans Vectorize`)
  if (data.errors?.length) console.log(`⚠️  Erreurs : ${JSON.stringify(data.errors)}`)
}

// ── Audit classification ──────────────────────────────────────────────────────
// Heuristique mots-clés dérivée du "Guide rapide" de CLAUDE.md — sert à repérer
// des candidats à vérifier, pas un verdict automatique (un faux positif reste
// possible, ex: "sac à main brodé" classé à raison dans Mode si c'est un motif
// de robe). Toujours relire le produit avant de recatégoriser.
const CATEGORY_HINTS = [
  { keywords: ['sac+pochette', 'sac ', 'sac+', 'pochette', 'tote bag', 'cabas', 'maroquinerie'], expected: ['Sacs - Maroquinerie'] },
  { keywords: ['pagne', 'wax', 'kente', 'bogolan'], expected: ['Pagnes - Tissus Africains'] },
  { keywords: ['collier', 'bracelet', 'bague', 'boucle'], expected: ['Bijoux Artisanaux Africains', 'Bijoux - Accessoires', 'Accessoires Mode'] },
  { keywords: ['robe', 'ensemble femme'], expected: ['Vêtements Femme'] },
  { keywords: ['boubou'], expected: ['Vêtements Homme'] },
  { keywords: ['savon', 'crème', 'creme', 'huile de'], expected: ['Soin Visage - Corps', 'Huiles - Beurres Naturels'] },
  { keywords: ['shampoing', 'huile capillaire'], expected: ['Soin Cheveux Naturels'] },
  { keywords: ['tableau', 'peinture'], expected: ['Tableaux - Peintures'] },
  { keywords: ['statue', 'sculpture', 'statuette'], expected: ['Sculpture - Statuettes'] },
  { keywords: ['épice', 'epice', 'piment', 'condiment'], expected: ['Épices - Condiments'] },
  { keywords: ['thé', 'the ', 'café', 'cafe', 'infusion'], expected: ['Boissons - Infusions'] },
  { keywords: ['babouche', 'sandale', 'chaussure'], expected: ['Chaussures - Sandales'] },
]

async function cmdAuditCategories(flags) {
  console.log('\n⏳ Récupération de tous les produits publiés...')
  const data = await auditApi('categories')
  const products = data.products ?? []
  console.log(`✅ ${products.length} produit(s) récupéré(s)\n`)

  const byCategory = {}
  const flagged = []
  for (const p of products) {
    const cats = p.categories?.length ? p.categories : ['(sans catégorie)']
    for (const c of cats) byCategory[c] = (byCategory[c] ?? 0) + 1

    const title = (p.title ?? '').toLowerCase()
    for (const hint of CATEGORY_HINTS) {
      if (!hint.keywords.some(k => title.includes(k))) continue
      const matches = p.categories?.some(c => hint.expected.includes(c))
      if (!matches) {
        flagged.push({ id: p.id, title: p.title, currentCategories: p.categories, expectedOneOf: hint.expected })
        break
      }
    }
  }

  console.log('📊 Répartition par catégorie :')
  for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(count).padStart(4)}  ${cat}`)
  }

  console.log(`\n🚩 ${flagged.length} produit(s) à vérifier (mot-clé du titre incohérent avec la catégorie assignée) :`)
  for (const f of flagged.slice(0, 50)) {
    console.log(`   #${f.id}  "${f.title}"  →  actuellement [${f.currentCategories.join(', ') || 'aucune'}]  attendu: ${f.expectedOneOf.join(' ou ')}`)
  }
  if (flagged.length > 50) console.log(`   ... et ${flagged.length - 50} autre(s) (voir --out)`)

  if (flags.out) {
    const { writeFileSync } = await import('fs')
    writeFileSync(flags.out, JSON.stringify({ counts: byCategory, flagged, allProducts: products }, null, 2))
    console.log(`\n💾 Rapport complet écrit dans ${flags.out}`)
  }
}

// ── Audit langue (nom/description) ─────────────────────────────────────────────
// Demandé le 2026-07-25, en suivi du fix WPML (fix-product-language) : corriger
// le TAG de langue WPML ne corrige pas le CONTENU — un produit fraîchement
// retagué 'fr' peut très bien avoir un nom/description écrits en anglais (cas
// réel trouvé sur #7996 "Fouta Beanie" : "This product has been carefully
// designed..."). Heuristique mots-clés (pas de détection de langue "réelle"
// disponible en Node sans dépendance externe) : compte les marqueurs anglais
// sans équivalence en français vs les marqueurs français, sur nom+descriptions.
const ENGLISH_MARKERS = [
  '\\bthe\\b', '\\band\\b', '\\bwith\\b', '\\bthis\\b', '\\byour\\b', '\\bfrom\\b',
  '\\bhas been\\b', '\\bhave been\\b', '\\bis\\b', '\\bare\\b', '\\bwas\\b', '\\bwere\\b',
  '\\bproduct\\b', '\\bquality\\b', '\\bguarantee', '\\bdiscover\\b', '\\beasy\\b',
  '\\bdaily\\b', '\\beveryday\\b', '\\bperfect\\b', '\\bperfectly\\b', '\\bdesigned\\b',
  '\\bfor\\b', '\\bthat\\b', '\\bwill\\b',
]
const FRENCH_MARKERS = [
  '\\ble\\b', '\\bla\\b', '\\bles\\b', '\\bdes\\b', '\\bune\\b', '\\bun\\b', '\\bet\\b',
  '\\bavec\\b', '\\bdans\\b', '\\bpour\\b', '\\bvotre\\b', '\\bvos\\b', '\\bce\\b', '\\bcette\\b',
  '\\best\\b', '\\bsont\\b', 'découvr', 'garanti', 'qualité', '\\bproduit', 'facile',
  'quotidien', 'parfait',
]
const stripHtml = s => (s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ')
function countMarkers(text, patterns) {
  let n = 0
  for (const p of patterns) if (new RegExp(p, 'i').test(text)) n++
  return n
}

async function fetchAllPublishedProducts() {
  if (!WOO_CK || !WOO_CS || !WOO_URL) { console.error('❌ NEXT_PUBLIC_WOO_URL, WOO_CONSUMER_KEY et WOO_CONSUMER_SECRET requis dans .env.local'); process.exit(1) }
  const auth = Buffer.from(`${WOO_CK}:${WOO_CS}`).toString('base64')
  const all = []
  let page = 1
  for (;;) {
    const res = await fetch(`${WOO_URL}/wp-json/wc/v3/products?status=publish&per_page=100&page=${page}&_fields=id,name,slug,description,short_description`, {
      headers: { Authorization: `Basic ${auth}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} (page ${page})`)
    const batch = await res.json()
    if (!batch.length) break
    all.push(...batch)
    if (batch.length < 100) break
    page++
  }
  return all
}

async function cmdAuditLanguage(flags) {
  console.log('\n⏳ Récupération de tous les produits publiés (wc/v3, pagination)...')
  const products = await fetchAllPublishedProducts()
  console.log(`✅ ${products.length} produit(s) récupéré(s)\n`)

  const flagged = []
  for (const p of products) {
    const text = `${p.name} ${stripHtml(p.short_description)} ${stripHtml(p.description)}`
    const en = countMarkers(text, ENGLISH_MARKERS)
    const fr = countMarkers(text, FRENCH_MARKERS)
    // Signal retenu volontairement conservateur (faux négatifs préférés aux
    // faux positifs) : au moins 2 marqueurs anglais ET nettement plus
    // d'anglais que de français — un texte court ou mixte (marque + un mot
    // anglais isolé) ne suffit pas à déclencher un signalement.
    if (en >= 2 && en > fr) {
      flagged.push({ id: p.id, slug: p.slug, name: p.name, englishScore: en, frenchScore: fr })
    }
  }

  flagged.sort((a, b) => (b.englishScore - b.frenchScore) - (a.englishScore - a.frenchScore))

  console.log(`🚩 ${flagged.length} produit(s) probablement en anglais (nom/description) :`)
  for (const f of flagged.slice(0, 50)) {
    console.log(`   #${f.id}  "${f.name}"  (anglais:${f.englishScore} français:${f.frenchScore})`)
  }
  if (flagged.length > 50) console.log(`   ... et ${flagged.length - 50} autre(s) (voir --out)`)

  console.log(`\nℹ️  Heuristique par mots-clés — vérifier chaque produit avant de corriger`)
  console.log(`   (rename : node scripts/miad.mjs rename --id <id> --name "...")`)
  console.log(`   (description : passe par /update-product, pas encore de commande CLI dédiée)`)

  if (flags.out) {
    const { writeFileSync } = await import('fs')
    writeFileSync(flags.out, JSON.stringify({ flagged, totalScanned: products.length }, null, 2))
    console.log(`\n💾 Rapport complet écrit dans ${flags.out}`)
  }
}

async function cmdSetCategoryImage(flags) {
  const categoryId = flags['category-id']
  const imageUrl = flags.image
  if (!WOO_CK || !WOO_CS || !WOO_URL) { console.error('❌ NEXT_PUBLIC_WOO_URL, WOO_CONSUMER_KEY et WOO_CONSUMER_SECRET requis dans .env.local'); process.exit(1) }
  if (!categoryId) { console.error('❌ --category-id <id> requis'); process.exit(1) }
  if (!imageUrl) { console.error('❌ --image <url> requis'); process.exit(1) }

  const auth = Buffer.from(`${WOO_CK}:${WOO_CS}`).toString('base64')
  console.log(`\n⏳ Image de la catégorie #${categoryId} → ${imageUrl}...`)
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3/products/categories/${categoryId}`, {
    method: 'PUT',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: { src: imageUrl } }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) { console.error(`❌ HTTP ${res.status}: ${JSON.stringify(data)}`); process.exit(1) }
  console.log(`✅ Catégorie "${data.name}" mise à jour`)
}

async function cmdSetCategory(flags, positional) {
  const category = flags.category
  const ids = positional.map(Number).filter(Boolean)
  if (!category) { console.error('❌ --category "Nom de la catégorie" requis'); process.exit(1) }
  if (!ids.length) { console.error('❌ Fournir au moins un ID produit'); process.exit(1) }

  console.log(`\n⏳ Réassignation de ${ids.length} produit(s) → "${category}"...`)
  const data = await api('update-product', { updates: ids.map(id => ({ id, category })) })
  console.log(`✅ ${data.updated} produit(s) mis à jour`)
  if (data.errors?.length) console.log(`⚠️  Erreurs : ${JSON.stringify(data.errors)}`)
}

async function cmdSetTags(flags, positional) {
  const tags = arr(flags.tag)
  const ids = positional.map(Number).filter(Boolean)
  if (!tags.length) { console.error('❌ --tag "motclé" requis (répétable)'); process.exit(1) }
  if (!ids.length) { console.error('❌ Fournir au moins un ID produit'); process.exit(1) }

  console.log(`\n⏳ Application des tags [${tags.join(', ')}] sur ${ids.length} produit(s)...`)
  const data = await api('update-product', { updates: ids.map(id => ({ id, tags })) })
  console.log(`✅ ${data.updated} produit(s) mis à jour`)
  if (data.errors?.length) console.log(`⚠️  Erreurs : ${JSON.stringify(data.errors)}`)
}

async function cmdDeleteVendor(flags) {
  const vendorId = flags.vendor
  if (!vendorId) { console.error('❌ --vendor requis'); process.exit(1) }

  console.log(`\n⏳ Suppression du vendeur ${vendorId}...`)
  const data = await api('delete-vendor', { vendorId: Number(vendorId), force: !!flags.force })
  console.log(`✅ Vendeur supprimé  ID ${data.vendor_id}${data.store_name ? `  (${data.store_name})` : ''}`)
  if (data.deleted_products?.length) {
    console.log(`   🗑  Produits supprimés : ${data.deleted_products.join(', ')}`)
  }
}

async function cmdRenameVendor(flags) {
  const vendorId = flags.vendor
  const storeName = flags['store-name']
  if (!vendorId) { console.error('❌ --vendor requis'); process.exit(1) }
  if (!storeName) { console.error('❌ --store-name requis'); process.exit(1) }

  console.log(`\n⏳ Renommage du vendeur ${vendorId} → "${storeName}"...`)
  const data = await api('rename-vendor-store', { vendorId: Number(vendorId), storeName })
  console.log(`✅ Boutique renommée  "${data.old_name}" → "${data.new_name}"`)
}

// ── Main ───────────────────────────────────────────────────────────────────────
const [,, command, ...rest] = process.argv
const { flags, positional } = parseArgs(rest)

if (!command || flags.help || command === 'help') {
  console.log(HELP)
  process.exit(0)
}

try {
  switch (command) {
    case 'create':          await cmdCreate(flags); break
    case 'create-variable': await cmdCreateVariable(flags); break
    case 'sync':            await cmdSync(positional); break
    case 'set-author':      await cmdSetAuthor(flags, positional); break
    case 'set-image':       await cmdSetImage(flags); break
    case 'set-price':       await cmdSetPrice(flags, positional); break
    case 'clear-cache':     await cmdClearCache(positional); break
    case 'links':           await cmdLinks(positional); break
    case 'rename':          await cmdRename(flags); break
    case 'create-vendor':   await cmdCreateVendor(flags); break
    case 'set-vendor-images': await cmdSetVendorImages(flags); break
    case 'delete-vendor':   await cmdDeleteVendor(flags); break
    case 'rename-vendor':   await cmdRenameVendor(flags); break
    case 'sync-embeddings': await cmdSyncEmbeddings(flags, positional); break
    case 'audit-categories': await cmdAuditCategories(flags); break
    case 'audit-language': await cmdAuditLanguage(flags); break
    case 'set-category':    await cmdSetCategory(flags, positional); break
    case 'set-tags':        await cmdSetTags(flags, positional); break
    case 'set-category-image': await cmdSetCategoryImage(flags); break
    default:
      console.error(`❌ Commande inconnue : "${command}"\n`)
      console.log(HELP)
      process.exit(1)
  }
} catch (e) {
  console.error(`\n❌ Erreur : ${e.message}`)
  process.exit(1)
}

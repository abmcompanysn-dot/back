#!/usr/bin/env node
// ============================================================
// generate-gallery.mjs — complète la galerie des produits qui n'ont
// qu'UNE seule image, avec VALIDATION MANUELLE avant toute publication.
//
// Galerie cible par produit : [originale, studio, ambiance, zoom]
//   1. STUDIO   — le même produit, fond studio neutre (image-to-image
//                 Qwen-Image, produit gardé fidèle)
//   2. AMBIANCE — plan large lifestyle cohérent avec la catégorie
//                 (image-to-image Qwen-Image)
//   3. ZOOM     — recadrage serré de la VRAIE photo (crop local sharp,
//                 JAMAIS généré) pour montrer la matière / le détail
//
// RÈGLE D'HONNÊTETÉ : les prompts interdisent d'inventer une face, un
// angle, un logo ou un motif non visibles sur la photo source. Le "zoom
// matière" est un vrai crop de l'originale, pas une génération. On ne
// publie jamais un dos / une doublure / un intérieur de produit inventé.
//
// Catégories EXCLUES (une photo suffit) : cosmétiques / soins / savons,
// tableaux / art mural, alimentation / épicerie. Voir isExcludedCategory.
// Les coupons de tissu / pagnes restent inclus.
//
// ------------------------------------------------------------
// FLUX EN 2 ÉTAPES
//
//   1. node scripts/generate-gallery.mjs generate [options]
//        → génère les visuels dans scripts/gallery-review/<id>/
//        → RIEN n'est envoyé au serveur
//
//   2. node scripts/generate-gallery.mjs review
//        → démarre un serveur local + ouvre la page de revue
//        → chaque "✅ Valider & publier" publie CE produit immédiatement
//          (upload MinIO + PUT /products/{id}/images ; token admin lu
//           côté serveur dans .env.local)
//        → "❌ Rejeter" : marqué rejeté, rien touché
//        → bouton "Tout publier" : publie d'un coup les galeries "à revoir"
//
//   (option) node scripts/generate-gallery.mjs publish
//        → publie en CLI toutes les galeries encore "pending", sans revue
//
// ------------------------------------------------------------
// OPTIONS ("generate")
//   --dry-run          liste les produits éligibles, ne génère rien
//   --limit N          traite au plus N produits
//   --ids 12,34,56     ne traite que ces ids (ignore l'exclusion catégorie)
//   --vendor N         ne traite que les produits du vendeur N
//   --resume           saute les produits déjà présents dans review.json
//   --model NAME       modèle DashScope (défaut wan2.6-image)
// OPTIONS ("review")
//   --port N           port du serveur local (défaut 4599)
//
// ------------------------------------------------------------
// CONFIG (.env.local racine ou scripts/.env.local)
//   DASHSCOPE_API_KEY     clé API Alibaba DashScope        (generate)
//   DASHSCOPE_BASE_URL    host workspace (…/api/v1) ou générique
//   MIAD_API_BASE         défaut https://origin.miadmarket.ca
//   MIAD_ADMIN_TOKEN      JWT admin, /media/upload + PUT images  (review/publish)
// ============================================================

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, renameSync,
} from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let sharp
try {
  sharp = require(join(process.cwd(), 'frontend', 'node_modules', 'sharp'))
} catch {
  try { sharp = require('sharp') } catch {
    console.error('sharp introuvable. Lancer depuis la racine du repo (sharp est dans frontend/node_modules).')
    process.exit(1)
  }
}

// ---- .env.local (parseur minimal, pas de dépendance) ---------------
function loadDotEnv() {
  for (const path of ['scripts/.env.local', '.env.local']) {
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
        if (!m) continue
        let v = m[2].trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        if (process.env[m[1]] === undefined) process.env[m[1]] = v
      }
    } catch { /* absent */ }
  }
}
loadDotEnv()

// ---- CLI --------------------------------------------------------
const argv = process.argv.slice(2)
const CMD = ['publish', 'review'].includes(argv[0]) ? argv[0] : 'generate'
const has = (f) => argv.includes(f)
const optv = (f, d = null) => {
  const i = argv.indexOf(f)
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d
}
const DRY_RUN = has('--dry-run')
const LIMIT = optv('--limit') ? parseInt(optv('--limit'), 10) : Infinity
const ONLY_IDS = optv('--ids') ? new Set(optv('--ids').split(',').map((s) => s.trim())) : null
const ONLY_VENDOR = optv('--vendor') || null
const RESUME = has('--resume')
// wan2.6-image : seul modèle image-to-image provisionné sur le workspace
// DashScope actuel (ws-u3naq5kzbkdg0tyo, us-east-1). Les qwen-image-edit*
// renvoient "Model not exist" sur cet endpoint. Vérifié le 2026-08-29 :
// wan2.6-image répond 200 et renvoie 4 variations par appel — on garde
// la 1re. Override possible avec --model.
const MODEL = optv('--model', 'wan2.6-image')

const API_BASE = (process.env.MIAD_API_BASE || 'https://origin.miadmarket.ca').replace(/\/$/, '')
// DASHSCOPE_BASE_URL : soit le host générique (https://dashscope-intl.aliyuncs.com),
// soit le host du workspace dédié fourni dans la console Model Studio
// (https://ws-XXXX.us-east-1.maas.aliyuncs.com/api/v1). On normalise en
// retirant un éventuel /api/v1 final pour reconstruire le chemin proprement.
const DASHSCOPE_BASE = (process.env.DASHSCOPE_BASE_URL || 'https://dashscope-intl.aliyuncs.com')
  .replace(/\/$/, '')
  .replace(/\/api\/v1$/, '')
const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || ''
const ADMIN_TOKEN = process.env.MIAD_ADMIN_TOKEN || ''

const REVIEW_DIR = join(process.cwd(), 'scripts', 'gallery-review')
const REVIEW_JSON = join(REVIEW_DIR, 'review.json')
const REVIEW_PORT = optv('--port') ? parseInt(optv('--port'), 10) : 4599

// Catégories exclues de la génération de galerie (demandé le 2026-08-29) :
// une seule photo suffit pour les cosmétiques, les tableaux et l'épicerie.
// Les coupons de tissu / pagnes RESTENT (le zoom matière les valorise).
function isExcludedCategory(slug) {
  const c = (slug || '').toLowerCase()
  return (
    /beaut|soin|cosm|cheveu|savon|huile|parfum|creme|serum|lait|shampoing|gommage/.test(c) ||
    /tableau|art-mural|peinture|toile|calligraphie/.test(c) ||
    /aliment|epicerie|grocery|food|epice|the-|cafe|infusion|cereale|legumineuse/.test(c)
  )
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (o) => process.stdout.write(JSON.stringify(o) + '\n')

const decodeEntities = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')

async function fetchWithRetry(url, opts = {}, { retries = 3, backoffMs = 1500 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts)
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${res.status} ${res.statusText}`)
        await sleep(backoffMs * (attempt + 1)); continue
      }
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : {} } catch { body = { _raw: text } }
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status}: ${body?.error?.message || body?.message || text?.slice(0, 200)}`)
        e.status = res.status; e.body = body; throw e
      }
      return body
    } catch (e) {
      lastErr = e
      if (e.status && e.status < 500 && e.status !== 429) throw e
      await sleep(backoffMs * (attempt + 1))
    }
  }
  throw lastErr
}

function readReview() {
  try { return JSON.parse(readFileSync(REVIEW_JSON, 'utf8')) } catch { return { products: {} } }
}

// Écriture atomique : on écrit dans un fichier temporaire puis rename()
// (atomique sur le même volume). Évite qu'un lecteur voie un JSON tronqué,
// et qu'un writeReview partiel écrase un fichier valide si le process meurt
// en plein milieu. NE protège pas de deux process qui s'écrasent l'un
// l'autre — pour ça : NE JAMAIS lancer generate + publish/review en même
// temps (règle apprise à la dure le 2026-08-29).
function writeReview(r) {
  const tmp = REVIEW_JSON + '.tmp.' + process.pid
  writeFileSync(tmp, JSON.stringify(r, null, 2))
  renameSync(tmp, REVIEW_JSON)
}

// mutateReview(fn) : relit le fichier frais, applique fn(review) qui le
// modifie en place, puis réécrit. Toute mutation passe par ici pour
// minimiser la fenêtre read→write.
function mutateReview(fn) {
  const r = readReview()
  fn(r)
  writeReview(r)
  return r
}

// ---- lister les produits à 1 seule image (1 ligne par trid) ------
async function listSingleImageProducts() {
  const byTrid = new Map()
  let page = 1
  const pageSize = 100
  for (;;) {
    const url = new URL(`${API_BASE}/products`)
    url.searchParams.set('page_size', String(pageSize))
    url.searchParams.set('page', String(page))
    if (ONLY_VENDOR) url.searchParams.set('vendor_id', ONLY_VENDOR)
    const data = await fetchWithRetry(url.toString())
    const items = data.items || data.products || []
    for (const p of items) {
      const imgs = (p.images || []).map((x) => (typeof x === 'string' ? x : x.src)).filter(Boolean)
      if (ONLY_IDS && !ONLY_IDS.has(String(p.id))) continue
      if (imgs.length !== 1) continue
      // --ids force le traitement même sur une catégorie exclue (test ciblé).
      if (!ONLY_IDS && isExcludedCategory(p.category_slug || p.category)) continue
      const trid = p.trid || `id-${p.id}`
      if (byTrid.has(trid)) continue
      byTrid.set(trid, {
        id: p.id, trid,
        name: decodeEntities(p.name),
        category: p.category_slug || p.category || '',
        image: imgs[0],
      })
    }
    const hasMore = data.has_more ?? (items.length === pageSize)
    if (!hasMore || items.length === 0) break
    page++
  }
  return [...byTrid.values()]
}

// ---- prompts par famille de catégorie --------------------------
function promptsFor(name, categorySlug) {
  const c = (categorySlug || '').toLowerCase()
  const isFood = /aliment|epicerie|grocery|food|epice|the|cafe|infusion/.test(c)
  const isBeauty = /beaut|soin|cosm|cheveu|huile|savon|parfum/.test(c)
  const isJewel = /bijou|accessoire|collier|bracelet/.test(c)
  const isBag = /sac|maroquin|pochette/.test(c)
  const isDeco = /maison|deco|artisanat|tableau|sculpture|vannerie/.test(c)

  const FAITHFUL =
    'Keep the product identical to the reference photo: same shape, colour, ' +
    'pattern, texture, proportions and any visible text or logo. Do not add, ' +
    'remove or invent any part, side, angle, label or decoration that is not ' +
    'visible in the reference. Photorealistic, high detail, no text overlay, ' +
    'no watermark, no people unless already present.'

  let ambiance
  if (isFood) ambiance = 'Lifestyle scene: the product styled on a rustic wooden kitchen table with warm natural light, a few neutral props (linen cloth, wooden spoon), shallow depth of field.'
  else if (isBeauty) ambiance = 'Lifestyle scene: the product on a clean marble surface with soft daylight, a sprig of greenery, minimalist spa mood.'
  else if (isJewel) ambiance = 'Lifestyle scene: the jewellery presented on a soft neutral fabric, warm boutique lighting, elegant minimalist styling.'
  else if (isBag) ambiance = 'Lifestyle scene: the bag placed on a stylish chair, urban daylight, fashion editorial mood, neutral background.'
  else if (isDeco) ambiance = 'Lifestyle scene: the item placed in a warm modern interior (shelf, sideboard) with natural light and neutral decor.'
  else ambiance = 'Lifestyle scene: the product used in a natural everyday setting with warm daylight and a clean neutral background.'

  return {
    studio: `Studio product photo of "${name}". Place the exact same product on a seamless light grey studio background, soft even lighting, subtle contact shadow, centred, full product in frame. ${FAITHFUL}`,
    ambiance: `${ambiance} Product shown is "${name}". ${FAITHFUL}`,
  }
}

// ---- DashScope image-to-image (Qwen-Image edit) ----------------
async function qwenEdit(sourceUrl, prompt) {
  const url = `${DASHSCOPE_BASE}/api/v1/services/aigc/multimodal-generation/generation`
  const payload = {
    model: MODEL,
    input: { messages: [{ role: 'user', content: [{ image: sourceUrl }, { text: prompt }] }] },
    parameters: {
      watermark: false,
      negative_prompt: 'lowres, blurry, distorted, deformed, extra limbs, text, watermark, added logo',
    },
  }
  const body = await fetchWithRetry(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DASHSCOPE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, { retries: 4, backoffMs: 2500 })

  const content = body?.output?.choices?.[0]?.message?.content || body?.output?.results || []
  for (const c of (Array.isArray(content) ? content : [content])) {
    const u = c?.image || c?.url || (typeof c === 'string' && c.startsWith('http') ? c : null)
    if (u) return u
  }
  throw new Error('réponse DashScope sans URL image : ' + JSON.stringify(body).slice(0, 300))
}

async function downloadBuffer(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download ${res.status} pour ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

// Les images DashScope arrivent en PNG 2-3 Mo — on les recompresse en
// JPEG q82, bord max 1400 px, pour rester cohérent avec le reste du
// catalogue (fiches à ~200-400 Ko). L'originale du vendeur, elle, n'est
// jamais recompressée.
async function toWebJpeg(buffer) {
  return sharp(buffer)
    .resize(1400, 1400, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer()
}

async function makeZoomCrop(srcBuffer) {
  const meta = await sharp(srcBuffer).metadata()
  const w = meta.width || 1000
  const h = meta.height || 1000
  const side = Math.round(Math.min(w, h) * 0.45)
  const left = Math.round((w - side) / 2)
  const top = Math.round((h - side) / 2)
  return sharp(srcBuffer)
    .extract({ left, top, width: side, height: side })
    .resize(1000, 1000, { fit: 'cover' })
    .jpeg({ quality: 88 })
    .toBuffer()
}

// ============================================================
// ÉTAPE 1 — generate
// ============================================================
async function cmdGenerate() {
  if (!DRY_RUN && !DASHSCOPE_KEY) {
    console.error('DASHSCOPE_API_KEY manquant (scripts/.env.local). --dry-run pour lister sans générer.')
    process.exit(1)
  }
  mkdirSync(REVIEW_DIR, { recursive: true })

  const eligible = await listSingleImageProducts()
  const review = readReview()
  log({ phase: 'scan', eligible: eligible.length, already_in_review: Object.keys(review.products).length, dry_run: DRY_RUN })

  const todo = eligible.filter((p) => !(RESUME && review.products[p.id]))

  if (DRY_RUN) {
    for (const p of todo.slice(0, LIMIT === Infinity ? undefined : LIMIT)) {
      log({ id: p.id, name: p.name, category: p.category, image: p.image, status: 'would-process' })
    }
    log({ phase: 'done', processed: 0, note: 'dry-run' })
    return
  }

  let processed = 0, done = 0, errors = 0
  for (const p of todo) {
    if (processed >= LIMIT) break
    processed++
    const dir = join(REVIEW_DIR, String(p.id))
    try {
      mkdirSync(dir, { recursive: true })
      const srcBuffer = await downloadBuffer(p.image)
      writeFileSync(join(dir, '0-original.jpg'), srcBuffer)

      const { studio, ambiance } = promptsFor(p.name, p.category)
      const studioUrl = await qwenEdit(p.image, studio)
      await sleep(1200)
      const ambianceUrl = await qwenEdit(p.image, ambiance)
      await sleep(1200)

      writeFileSync(join(dir, '1-studio.jpg'), await toWebJpeg(await downloadBuffer(studioUrl)))
      writeFileSync(join(dir, '2-ambiance.jpg'), await toWebJpeg(await downloadBuffer(ambianceUrl)))
      writeFileSync(join(dir, '3-zoom.jpg'), await makeZoomCrop(srcBuffer))

      // Merge sur relecture fraîche : un `publish` / serveur `review` peut
      // tourner en parallèle et avoir passé des produits à "published".
      // Sans ça, generate réécrivait tout le fichier avec sa copie mémoire
      // (tout "pending") et écrasait ces statuts (constaté le 2026-08-29).
      const fresh = readReview()
      const prev = fresh.products[p.id] || {}
      fresh.products[p.id] = {
        id: p.id, trid: p.trid, name: p.name, category: p.category,
        original_url: p.image,
        files: ['0-original.jpg', '1-studio.jpg', '2-ambiance.jpg', '3-zoom.jpg'],
        status: prev.status === 'published' ? 'published' : 'pending',
        published_at: prev.published_at,
        published_urls: prev.published_urls,
        generated_at: new Date().toISOString(),
      }
      writeReview(fresh)
      done++
      log({ id: p.id, status: 'generated', dir: `scripts/gallery-review/${p.id}` })
    } catch (e) {
      errors++
      log({ id: p.id, status: 'error', reason: String(e.message || e).slice(0, 300) })
    }
    await sleep(800)
  }

  log({ phase: 'done', processed, done, errors, next: 'node scripts/generate-gallery.mjs review' })
}

const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// ---- page HTML de review (servie par le serveur `review`) --------
// Les boutons appellent le serveur local : Valider => POST /api/publish/{id}
// (upload MinIO + PUT galerie, token admin côté serveur), Rejeter =>
// POST /api/reject/{id}. Pas de token dans le navigateur, pas de CORS,
// pas de fichier à exporter.
function buildReviewHtml(review) {
  const cards = Object.values(review.products)
    .sort((a, b) => a.id - b.id)
    .map((p) => `
    <article class="card" data-id="${p.id}" data-status="${p.status}">
      <header>
        <span class="pid">#${p.id}</span>
        <h2>${escapeHtml(p.name)}</h2>
        <span class="cat">${escapeHtml(p.category)}</span>
      </header>
      <div class="imgs">
        <figure><img loading="lazy" src="/img/${p.id}/0-original.jpg" alt=""><figcaption>Originale (vendeur)</figcaption></figure>
        <figure><img loading="lazy" src="/img/${p.id}/1-studio.jpg" alt=""><figcaption>Studio (IA)</figcaption></figure>
        <figure><img loading="lazy" src="/img/${p.id}/2-ambiance.jpg" alt=""><figcaption>Ambiance (IA)</figcaption></figure>
        <figure><img loading="lazy" src="/img/${p.id}/3-zoom.jpg" alt=""><figcaption>Zoom matière (crop réel)</figcaption></figure>
      </div>
      <div class="actions">
        <button class="btn ok" data-act="publish">✅ Valider &amp; publier</button>
        <button class="btn no" data-act="reject">❌ Rejeter</button>
        <span class="verdict">${p.status === 'published' ? 'Publié ✓' : p.status === 'rejected' ? 'Rejeté' : ''}</span>
      </div>
    </article>`).join('\n')

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revue galeries produits — MIAD</title>
<style>
  :root{--bg:#f4f4f5;--card:#fff;--ink:#18181b;--mut:#71717a;--ok:#16a34a;--no:#dc2626;--line:#e4e4e7}
  @media(prefers-color-scheme:dark){:root{--bg:#0b0b0c;--card:#161618;--ink:#f4f4f5;--mut:#a1a1aa;--line:#27272a}}
  *{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--ink)}
  .bar{position:sticky;top:0;z-index:10;display:flex;gap:12px;align-items:center;flex-wrap:wrap;
       padding:12px 20px;background:var(--card);border-bottom:1px solid var(--line)}
  .bar h1{font-size:16px;margin:0;font-weight:800}
  .bar .count{color:var(--mut);font-size:13px}
  .bar .grow{flex:1}
  .bar button{padding:8px 16px;border:0;border-radius:8px;background:var(--ink);color:var(--bg);font-weight:700;cursor:pointer}
  .bar button.puball{background:var(--ok)}
  .filters{display:flex;gap:6px}
  .filters button{padding:6px 10px;font-size:12px;border:1px solid var(--line);border-radius:999px;
                  background:transparent;color:var(--ink);cursor:pointer;font-weight:600}
  .filters button.active{background:var(--ink);color:var(--bg)}
  main{padding:20px;display:grid;gap:20px;max-width:1400px;margin:0 auto}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
  .card[data-status=published]{outline:2px solid var(--ok)}
  .card[data-status=rejected]{outline:2px solid var(--no);opacity:.55}
  .card header{display:flex;gap:10px;align-items:baseline;padding:12px 16px;border-bottom:1px solid var(--line)}
  .card header h2{font-size:15px;margin:0;font-weight:700;flex:1}
  .pid{font-family:ui-monospace,monospace;color:var(--mut);font-size:13px}
  .cat{font-size:11px;color:var(--mut);background:var(--bg);padding:2px 8px;border-radius:999px}
  .imgs{display:grid;grid-template-columns:repeat(4,1fr);gap:2px;background:var(--line)}
  .imgs figure{margin:0;background:var(--card)}
  .imgs img{width:100%;aspect-ratio:1;object-fit:contain;background:#fff;display:block;cursor:zoom-in}
  .imgs figcaption{padding:6px 10px;font-size:11px;color:var(--mut);text-align:center}
  .actions{display:flex;gap:8px;align-items:center;padding:12px 16px}
  .btn{padding:8px 14px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);
       font-weight:700;cursor:pointer}
  .btn.ok:hover{background:var(--ok);color:#fff;border-color:var(--ok)}
  .btn.no:hover{background:var(--no);color:#fff;border-color:var(--no)}
  .btn[disabled]{opacity:.4;cursor:default}
  .verdict{margin-left:auto;font-size:13px;font-weight:700;color:var(--mut)}
  #lightbox{position:fixed;inset:0;background:rgba(0,0,0,.9);display:none;align-items:center;justify-content:center;z-index:99}
  #lightbox img{max-width:95vw;max-height:95vh}
</style></head><body>
<div class="bar">
  <h1>Revue galeries produits</h1>
  <span class="count" id="count"></span>
  <div class="grow"></div>
  <div class="filters">
    <button data-f="all" class="active">Tous</button>
    <button data-f="pending">À revoir</button>
    <button data-f="published">Publiés</button>
    <button data-f="rejected">Rejetés</button>
  </div>
  <button class="puball" id="pubAll">✅ Tout publier</button>
</div>
<main id="list">
${cards}
</main>
<div id="lightbox"><img src="" alt=""></div>
<script>
  const $ = (s, r = document) => r.querySelector(s)
  const cards = [...document.querySelectorAll('.card')]

  function refreshCount(){
    const n = k => cards.filter(c => c.dataset.status === k).length
    $('#count').textContent = cards.length + ' produits · ' + n('published') + ' publiés · ' +
      n('rejected') + ' rejetés · ' + n('pending') + ' à revoir'
  }
  function setBusy(card, busy){
    card.querySelectorAll('.btn').forEach(b => b.disabled = busy)
    if (busy) $('.verdict', card).textContent = '…'
  }
  async function act(card, kind){
    const id = card.dataset.id
    setBusy(card, true)
    try{
      const res = await fetch('/api/' + (kind === 'publish' ? 'publish' : 'reject') + '/' + id, { method: 'POST' })
      const body = await res.json()
      if(!res.ok) throw new Error(body.error || res.status)
      card.dataset.status = kind === 'publish' ? 'published' : 'rejected'
      $('.verdict', card).textContent = kind === 'publish' ? 'Publié ✓' : 'Rejeté'
    }catch(e){
      $('.verdict', card).textContent = '⚠ ' + e.message
      card.querySelectorAll('.btn').forEach(b => b.disabled = false)
    }
    refreshCount()
  }
  cards.forEach(card => {
    card.querySelectorAll('.btn').forEach(btn =>
      btn.addEventListener('click', () => act(card, btn.dataset.act)))
    card.querySelectorAll('.imgs img').forEach(img =>
      img.addEventListener('click', () => { $('#lightbox img').src = img.src; $('#lightbox').style.display = 'flex' }))
  })
  $('#lightbox').addEventListener('click', () => $('#lightbox').style.display = 'none')
  $('#pubAll').addEventListener('click', async () => {
    if(!confirm('Publier toutes les galeries encore "à revoir" ?')) return
    for(const card of cards.filter(c => c.dataset.status === 'pending')) await act(card, 'publish')
  })
  document.querySelectorAll('.filters button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.filters button').forEach(x => x.classList.remove('active'))
    b.classList.add('active')
    const f = b.dataset.f
    cards.forEach(c => { c.style.display = (f === 'all' || c.dataset.status === f) ? '' : 'none' })
  }))
  refreshCount()
</script>
</body></html>`
}

// ============================================================
// ÉTAPE 3 — publish
// ============================================================
async function uploadToMinio(buffer, filename) {
  const fd = new FormData()
  fd.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename)
  fd.append('prefix', 'products')
  const body = await fetchWithRetry(`${API_BASE}/media/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: fd,
  })
  if (!body.url) throw new Error('upload sans url : ' + JSON.stringify(body).slice(0, 200))
  return body.url
}
async function patchGallery(id, images) {
  return fetchWithRetry(`${API_BASE}/products/${id}/images`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ images }),
  })
}

// Publie la galerie d'UN produit : upload des 3 visuels dans MinIO puis
// PUT /products/{id}/images avec [originale, studio, ambiance, zoom].
// Renvoie la galerie publiée.
//
// review.json peut être réécrit en parallèle par un `generate` qui tourne
// encore : on RELIT le fichier juste avant d'écrire et on ne modifie que
// la clé de CE produit (merge), pour ne pas écraser les entrées ajoutées
// entre-temps par la génération.
async function publishOne(id, reviewHint) {
  const p0 = (reviewHint?.products || {})[id] || readReview().products[id]
  if (!p0) throw new Error('produit absent de review.json')
  if (p0.status === 'published') return p0.published_urls
  const dir = join(REVIEW_DIR, String(id))
  const [uStudio, uAmbiance, uZoom] = await Promise.all([
    uploadToMinio(readFileSync(join(dir, '1-studio.jpg')), `${id}-studio.jpg`),
    uploadToMinio(readFileSync(join(dir, '2-ambiance.jpg')), `${id}-ambiance.jpg`),
    uploadToMinio(readFileSync(join(dir, '3-zoom.jpg')), `${id}-zoom.jpg`),
  ])
  const gallery = [p0.original_url, uStudio, uAmbiance, uZoom]
  await patchGallery(id, gallery)
  // Réplication vers la fiche jumelle (même produit, autre langue FR/EN) —
  // ce script regroupe déjà par trid pour ne générer les visuels QU'UNE
  // fois (voir plus haut, byTrid), mais avant ce correctif la publication
  // ne s'appliquait qu'à l'id scanné : la fiche jumelle restait avec son
  // ancienne galerie (souvent 1 seule image). linked.id est déjà exposé
  // par GET /products/{id} (catalog-svc, WPML trid/lang) — l'original_url
  // de la fiche jumelle peut différer de celui-ci (photo différente selon
  // la langue dans de rares cas), donc on la relit plutôt que de réutiliser
  // p0.original_url tel quel. Best effort : jamais bloquant pour la
  // publication principale, qui a déjà réussi à ce stade.
  try {
    const detail = await fetchWithRetry(`${API_BASE}/products/${id}`)
    const linkedId = detail?.linked?.id
    const linkedLang = detail?.linked?.lang
    if (linkedId && String(linkedId) !== String(id)) {
      // GET /products/{id} filtre par défaut lang=fr côté catalog-svc —
      // un id EN interrogé sans ?lang=en échoue en 404 "introuvable en
      // lang=fr" (erreur explicite du service, pas une page vide muette).
      const linkedDetail = await fetchWithRetry(`${API_BASE}/products/${linkedId}?lang=${linkedLang || 'en'}`)
      // images[] est un tableau d'OBJETS {src}, pas de chaînes brutes
      // (contrat WooCommerce conservé par catalog-svc) — .src, pas l'objet
      // entier, sinon patchGallery publierait "[object Object]".
      const linkedOriginal = linkedDetail?.images?.[0]?.src || p0.original_url
      await patchGallery(linkedId, [linkedOriginal, uStudio, uAmbiance, uZoom])
      log({ phase: 'publish-linked', id, linkedId })
    }
  } catch (err) {
    log({ phase: 'publish-linked-failed', id, error: String(err?.message || err) })
  }
  // relecture fraîche + merge sur la seule clé de ce produit
  const fresh = readReview()
  fresh.products[id] = {
    ...(fresh.products[id] || p0),
    status: 'published',
    published_at: new Date().toISOString(),
    published_urls: gallery,
  }
  writeReview(fresh)
  return gallery
}

// ---- `publish` : publie en masse tous les produits pending -----
async function cmdPublish() {
  if (!ADMIN_TOKEN) { console.error('MIAD_ADMIN_TOKEN manquant (JWT admin).'); process.exit(1) }
  const review = readReview()
  const pending = Object.values(review.products).filter((p) => p.status === 'pending').map((p) => String(p.id))
  log({ phase: 'publish-start', pending: pending.length })
  let done = 0, errors = 0
  for (const id of pending) {
    try {
      const g = await publishOne(id, review)
      done++
      log({ id, status: 'published', images: g.length })
    } catch (e) {
      errors++
      log({ id, status: 'error', reason: String(e.message || e).slice(0, 300) })
    }
    await sleep(500)
  }
  log({ phase: 'done', done, errors })
}

// ---- `review` : serveur local + page de validation ------------
async function cmdReview() {
  if (!ADMIN_TOKEN) { console.error('MIAD_ADMIN_TOKEN manquant (JWT admin) — requis pour publier.'); process.exit(1) }
  const http = await import('node:http')
  const review = readReview()
  if (Object.keys(review.products).length === 0) {
    console.error('Aucun produit dans review.json — lancer d\'abord `generate`.')
    process.exit(1)
  }

  const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.html': 'text/html; charset=utf-8' }
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost')
      // page
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
        const html = buildReviewHtml(readReview())
        res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(html); return
      }
      // images locales /img/<id>/<file>
      if (req.method === 'GET' && u.pathname.startsWith('/img/')) {
        const rel = u.pathname.slice('/img/'.length)
        if (rel.includes('..')) { res.writeHead(400); res.end(); return }
        const file = join(REVIEW_DIR, rel)
        if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return }
        const ext = rel.slice(rel.lastIndexOf('.'))
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
        res.end(readFileSync(file)); return
      }
      // POST /api/publish/<id>
      if (req.method === 'POST' && u.pathname.startsWith('/api/publish/')) {
        const id = u.pathname.split('/').pop()
        try {
          // null => publishOne relit review.json frais (une génération peut
          // tourner en parallèle et l'avoir enrichi).
          const gallery = await publishOne(id, null)
          log({ id, status: 'published', images: gallery.length })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, gallery }))
        } catch (e) {
          log({ id, status: 'error', reason: String(e.message || e) })
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: String(e.message || e) }))
        }
        return
      }
      // POST /api/reject/<id>
      if (req.method === 'POST' && u.pathname.startsWith('/api/reject/')) {
        const id = u.pathname.split('/').pop()
        const r = readReview() // relecture fraîche : merge sur la seule clé
        if (r.products[id]) {
          r.products[id] = { ...r.products[id], status: 'rejected' }
          writeReview(r)
        }
        log({ id, status: 'rejected' })
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return
      }
      res.writeHead(404); res.end('not found')
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(e.message || e) }))
    }
  })

  server.listen(REVIEW_PORT, () => {
    const url = `http://localhost:${REVIEW_PORT}/`
    log({ phase: 'review-server', url, products: Object.keys(review.products).length })
    console.error(`\n  Revue ouverte sur ${url}\n  (Ctrl+C pour arrêter)\n`)
    // ouverture auto du navigateur (Windows / macOS / Linux)
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]]
    import('node:child_process').then(({ spawn }) => {
      try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref() } catch {}
    })
  })
}

// ---- entrée ----------------------------------------------------
const RUN = CMD === 'publish' ? cmdPublish : CMD === 'review' ? cmdReview : cmdGenerate
RUN().catch((e) => {
  log({ phase: 'fatal', reason: String(e.message || e) })
  process.exit(1)
})

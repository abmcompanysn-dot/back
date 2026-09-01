#!/usr/bin/env node
// ============================================================
// split-cofapp-bonnets.mjs
//
// Les 2 fiches produit de la boutique COFAPP (vendor 49) contiennent
// chacune plusieurs BONNETS DIFFÉRENTS entassés dans une seule galerie :
//   - 678 « bonnet traditionnel guineen » : 4 images = 4 bonnets
//   - 691 « Bonnet Pouto »                : 4 images = 4 bonnets
// Un client ne peut pas savoir quel modèle il achète.
//
// Ce script éclate chaque galerie : 1 image = 1 nouvelle fiche produit
// (nom = nom de base + couleur dominante détectée), puis supprime les
// 2 fiches d'origine. → 8 nouvelles fiches COFAPP.
//
// Les nouvelles fiches partent en `pending_review` (modération vendeur
// active par défaut) : invisibles en boutique tant que non approuvées
// dans l'admin. À toi d'approuver / élaguer ensuite.
//
// Usage :
//   node scripts/split-cofapp-bonnets.mjs             # DRY-RUN : montre le plan, ne touche à rien
//   node scripts/split-cofapp-bonnets.mjs --apply     # crée les 8 fiches + supprime 678 et 691
//
// Aucune auth : passe par la passerelle publique origin.miadmarket.ca/catalog/*
// (mêmes endpoints catalog-svc que le dashboard vendeur).
// ============================================================

const APPLY = process.argv.includes('--apply')
const BASE = process.env.MIAD_CATALOG_BASE || 'https://origin.miadmarket.ca/catalog'

// Noms établis à l'œil sur les 8 images (la détection auto de couleur
// échouait : photos petites, sombres, broderies noir/blanc, décor parasite).
// L'ordre suit exactement l'ordre des images dans product.images de chaque
// fiche source — vérifié le 2026-08-31.
const SOURCE_IDS = [678, 691]
const NAME_BY_SOURCE = {
  678: [
    'Bleu & Orange',        // bonnet-traditionnel-guineen-0 : damier bleu roi / orange / noir-blanc
    'Turquoise',            // -1 : motifs losanges turquoise (pile studio)
    'Turquoise & Orange',   // -2 : carrés turquoise + orange (extérieur)
    'Bleu & Blanc',         // -3 : motifs kente bleu vif / blanc (pile studio)
  ],
  691: [
    'Bleu & Rouge',         // WhatsApp-...-1.jpeg : losange central rouge/blanc sur bleu
    'Bleu & Blanc',         // WhatsApp-...27.jpeg : motifs kente bleu / blanc (sur canapé)
    'Vert & Rouge',         // bonnet-pouto-0.avif : vert foncé + rouge + orange
    'Bleu Marine & Rouge',  // bonnet-pouto-1.avif : bleu marine + rouge, motif flèches
  ],
}

// ---------- Helpers HTTP ----------

async function getProduct(id) {
  const r = await fetch(`${BASE}/products/${id}?lang=fr`)
  if (!r.ok) throw new Error(`GET /products/${id} -> ${r.status}`)
  return r.json()
}

async function createProduct(payload) {
  const r = await fetch(`${BASE}/vendor/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`POST /vendor/products -> ${r.status} ${JSON.stringify(body)}`)
  return body // { id: <idFR>, ... }
}

async function deleteProduct(id) {
  const r = await fetch(`${BASE}/products/${id}`, { method: 'DELETE' })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`DELETE /products/${id} -> ${r.status} ${JSON.stringify(body)}`)
  return body
}

// nom de base : « bonnet traditionnel guineen » -> « Bonnet Traditionnel Guinéen »
// Capitalise la 1re lettre de chaque mot, laisse le reste (accents inclus)
// intact. Pour « Bonnet Pouto » : inchangé.
function tidyBaseName(name) {
  return name
    .replace(/guineen/i, 'guinéen')
    .replace(/\bbrode\b/i, 'brodé')
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

// ---------- Plan ----------

async function buildPlan() {
  const plan = []
  for (const id of SOURCE_IDS) {
    const p = await getProduct(id)
    const images = (p.images || []).map((im) => (typeof im === 'string' ? im : im.src)).filter(Boolean)
    const base = tidyBaseName(p.name)
    const names = NAME_BY_SOURCE[id] || []

    console.error(`\nSource #${id} « ${p.name} » — ${images.length} image(s), catégorie ${p.category_id}, ${p.price_usd}$`)
    if (names.length !== images.length) {
      throw new Error(
        `Source #${id} : ${images.length} images mais ${names.length} noms définis dans NAME_BY_SOURCE. ` +
        `Vérifie l'ordre/le nombre des images (elles ont peut-être changé).`
      )
    }

    for (let i = 0; i < images.length; i++) {
      const url = images[i]
      const suffix = names[i]
      const nameFR = `${base} — ${suffix}`
      plan.push({
        sourceId: id,
        imageIndex: i,
        url,
        payload: {
          vendor_id: p.vendor_id,
          category_id: p.category_id,
          price_usd: p.price_usd,
          stock: p.stock || 0,
          name_fr: nameFR,
          name_en: '', // repli FR côté catalog-svc
          images: [url],
          tags: p.tags || [],
          is_variable: false,
        },
        _preview: { nameFR, price: p.price_usd, image: url },
      })
      console.error(`  [${i}] ${suffix.padEnd(22)} -> « ${nameFR} »`)
      console.error(`       ${url}`)
    }
  }
  return plan
}

async function main() {
  console.error('=== split-cofapp-bonnets ===')
  console.error(APPLY ? 'MODE : APPLY (création + suppression réelles)' : 'MODE : DRY-RUN (aucune écriture)')

  const plan = await buildPlan()

  console.error(`\n--- Résumé ---`)
  console.error(`${plan.length} nouvelles fiches à créer`)
  console.error(`${SOURCE_IDS.length} fiches d'origine à supprimer : ${SOURCE_IDS.join(', ')}`)

  if (!APPLY) {
    console.error('\nDRY-RUN terminé. Relance avec --apply pour exécuter.')
    // sortie JSON exploitable
    console.log(JSON.stringify({ dry_run: true, create: plan.map(p => p._preview), delete: SOURCE_IDS }, null, 2))
    return
  }

  console.error('\n--- Création ---')
  const created = []
  for (const item of plan) {
    const res = await createProduct(item.payload)
    created.push({ id: res.id, name: item.payload.name_fr })
    console.error(`  + #${res.id}  ${item.payload.name_fr}`)
  }

  console.error('\n--- Suppression des fiches d\'origine ---')
  for (const id of SOURCE_IDS) {
    await deleteProduct(id)
    console.error(`  - #${id} supprimé`)
  }

  console.error('\nTerminé.')
  console.log(JSON.stringify({ dry_run: false, created, deleted: SOURCE_IDS }, null, 2))
}

main().catch((e) => {
  console.error('\nÉCHEC :', e.message)
  process.exit(1)
})

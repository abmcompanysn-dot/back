// build-64.mjs — génère 64.content.json (nana_coutureofficial, #64, 43 produits).
//
// 4 familles de tissus (VIP Vanety Cotton, Dentelle Appliquée, Dentelle
// Swiss Voil, Ankara Super Wax Glitter) + 3 boubous. Les descriptions
// d'origine sont déjà bonnes — on les GARDE comme corps, on ajoute la
// structure vente-au-métrage / entretien / usage, sous-titre, specs, tags.
//
//   node scripts/catalog-enrich/build-64.mjs
//   puis : node scripts/enrich-catalog.mjs apply 64 --dry-run

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const pull = JSON.parse(readFileSync(join(HERE, '64.pull.json'), 'utf8'))

const clean = (s) =>
  String(s || '')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<li[^>]*>\s*<p[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/’/g, "'")
    .replace(/\(Prix par yard\)|\(Prix pour 5 yards\)/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const mkDesc = (lines) =>
  lines.filter((l) => l !== null && l !== undefined && l !== '').join('\n\n').replace(/\n{3,}/g, '\n\n').trim()

const motif = (name) => (name.match(/Motif\s+(\d+)/i) || [])[1] || ''

// Longueurs proposées (labels de variation "Motif N/6 mètres" etc.).
function lengths(labels) {
  const set = new Set()
  for (const l of labels || []) {
    const m = String(l).match(/(\d+)\s*m[eè]tres?/i)
    if (m) set.add(m[1] + ' mètres')
  }
  return [...set]
}

const SELL_FR =
  "Vente au coupon : longueurs proposées ci-dessous (le prix affiché correspond à la longueur choisie). Le tissu est livré non coupé, prêt à porter chez votre couturier."
const SELL_EN =
  "Sold by the cut length: choose from the options below (the price shown matches the selected length). The fabric ships uncut, ready for your tailor."

const CARE_COTTON_FR =
  "Entretien : lavage machine à 30 °C sur l'envers, séchage à l'ombre, repassage moyen. Le coton peut légèrement rétrécir au premier lavage — prévoir une petite marge à la coupe."
const CARE_COTTON_EN =
  "Care: machine wash at 30 °C inside out, dry in the shade, medium iron. Cotton may shrink slightly on the first wash — allow a small margin when cutting."
const CARE_LACE_FR =
  "Entretien : lavage à la main à l'eau froide ou nettoyage à sec, ne pas essorer, sécher à plat. Repasser à basse température sur l'envers, à travers un linge, en évitant les pierres et les appliqués."
const CARE_LACE_EN =
  "Care: hand-wash cold or dry-clean, do not wring, dry flat. Iron on low on the reverse through a cloth, avoiding the stones and appliqués."
const CARE_WAX_FR =
  "Entretien : lavage à la main à l'eau froide les premières fois pour fixer les couleurs, séchage à l'ombre, repassage moyen sur l'envers en évitant les zones à pierres."
const CARE_WAX_EN =
  "Care: hand-wash cold for the first few washes to set the colours, dry in the shade, medium iron on the reverse avoiding the stoned areas."

// --- familles de tissu ---
const FAMILIES = {
  'Coton VIP Vanety': {
    subFR: (m) => `Coton VIP Vanety premium pour homme${m ? ` — motif ${m}` : ''}, vendu au métrage`,
    subEN: `Premium VIP Vanety cotton for menswear, sold by the length`,
    bodyEN: (base) =>
      `VIP Vanety Cotton — a premium menswear fabric built for comfort, durability and a clean finish. Soft cotton hand, breathable, with a firm weave that keeps its shape after tailoring. Made for men who like sharp, classic, timeless styles.\n\nWhy you'll love it: high-quality cotton, breathable and soft on the skin, durable with an excellent finish, easy to sew and care for.\n\nGood for: sénateur outfits, boubous, traditional attire, smart-casual looks.`,
    care: [CARE_COTTON_FR, CARE_COTTON_EN],
    tags: ['tissu', 'coton', 'pagne homme', 'tissu sénateur', 'VIP Vanety', 'tissu premium', 'nana couture', 'couture homme', 'boubou homme'],
    specs: (lens, m) => [
      { k: 'Type', v: 'Coton premium (VIP Vanety), pour homme' },
      { k: 'Toucher', v: 'Doux, respirant' },
      { k: 'Tissage', v: 'Résistant, garde sa forme après couture' },
      m ? { k: 'Motif', v: `Motif ${m}` } : null,
      { k: 'Longueurs', v: lens.join(' ou ') || 'Au coupon' },
      { k: 'Usage', v: 'Sénateur, boubou, tenues traditionnelles, smart casual' },
      { k: 'Entretien', v: 'Lavage 30 °C sur l\'envers, séchage à l\'ombre, repassage moyen' },
    ],
  },
  'Dentelle Appliquée': {
    subFR: (m) => `Dentelle appliquée à motifs en relief${m ? ` — motif ${m}` : ''}, pour la haute couture`,
    subEN: `Appliqué lace with raised motifs, for couture pieces`,
    bodyEN: (base) =>
      `A superb appliqué lace with delicate, intricate motifs that bring texture, elegance and a luxurious touch to any outfit. For anyone who loves timeless sophistication with an artistic edge — ideal for one-off, stand-out pieces.\n\nGood for: boubou, dresses, evening wear, blouses, skirts and any special-occasion couture creation.`,
    care: [CARE_LACE_FR, CARE_LACE_EN],
    tags: ['tissu', 'dentelle', 'dentelle appliquée', 'tissu soirée', 'haute couture', 'tissu mariage', 'nana couture', 'pagne dentelle'],
    specs: (lens, m) => [
      { k: 'Type', v: 'Dentelle appliquée (motifs en relief)' },
      { k: 'Aspect', v: 'Motifs délicats et complexes, effet luxueux' },
      m ? { k: 'Motif', v: `Motif ${m}` } : null,
      { k: 'Longueurs', v: lens.join(' ou ') || 'Au coupon' },
      { k: 'Usage', v: 'Boubou, robes, tenues de soirée, chemisiers, jupes' },
      { k: 'Entretien', v: 'Lavage main à froid ou nettoyage à sec, séchage à plat' },
    ],
  },
  'Dentelle Swiss Voil': {
    subFR: (m) => `Dentelle Swiss Voile ornée de pierres${m ? ` — motif ${m}` : ''}, tenues de mariée et soirée`,
    subEN: `Swiss voile lace set with stones, for bridal and evening wear`,
    bodyEN: (base) =>
      `Premium Swiss Voile lace, set with dazzling Swarovski-style stones for an elegant sparkle on outfits that stand out. Soft, smooth and top quality, ideal for dresses, bridal outfits and one-off show-stopping pieces.\n\nGood for: bridal outfits, boubou, evening dresses, blouses and any special-occasion creation that calls for glamour.`,
    care: [CARE_LACE_FR, CARE_LACE_EN],
    tags: ['tissu', 'dentelle', 'swiss voile', 'dentelle pierres', 'tissu mariée', 'tissu soirée', 'haute couture', 'nana couture'],
    specs: (lens, m) => [
      { k: 'Type', v: 'Dentelle Swiss Voile ornée de pierres' },
      { k: 'Toucher', v: 'Doux, lisse, haut de gamme' },
      { k: 'Ornement', v: 'Pierres serties, éclat élégant' },
      m ? { k: 'Motif', v: `Motif ${m}` } : null,
      { k: 'Longueurs', v: lens.join(' ou ') || 'Au coupon' },
      { k: 'Usage', v: 'Tenues de mariée, boubou, robes de soirée, chemisiers' },
      { k: 'Entretien', v: 'Lavage main à froid ou nettoyage à sec, séchage à plat' },
    ],
  },
  'Tissu Ankara Super Wax Glitter': {
    subFR: (m) => `Ankara super wax à scintillement et pierres${m ? ` — motif ${m}` : ''}`,
    subEN: `Ankara super wax with glitter and stones`,
    bodyEN: (base) =>
      `A luxe Ankara made from premium super wax: a smooth, high-end finish lifted by a discreet, elegant shimmer. Stone inlays add an eye-catching sparkle — made for outfits that turn heads. Durable, vibrant and naturally elegant.\n\nGood for: boubou, dresses, skirts, blouses, peplums, headscarves and any bold, forward creation.`,
    care: [CARE_WAX_FR, CARE_WAX_EN],
    tags: ['tissu', 'ankara', 'super wax', 'wax glitter', 'pagne wax', 'wax pierres', 'tissu africain', 'nana couture'],
    specs: (lens, m) => [
      { k: 'Type', v: 'Ankara super wax, scintillement + pierres' },
      { k: 'Finition', v: 'Lisse, haut de gamme, éclat discret' },
      { k: 'Ornement', v: 'Incrustations de pierres' },
      m ? { k: 'Motif', v: `Motif ${m}` } : null,
      { k: 'Longueurs', v: lens.join(' ou ') || 'Au coupon' },
      { k: 'Usage', v: 'Boubou, robes, jupes, chemisiers, peplums, foulards' },
      { k: 'Entretien', v: 'Lavage main à froid au début, séchage à l\'ombre, repassage sur l\'envers' },
    ],
  },
}

function buildFabric(p, famKey) {
  const fam = FAMILIES[famKey]
  const m = motif(p.name)
  const lens = lengths(p.variation_labels)
  const base = clean(p.current_description)
  return {
    subtitle_fr: fam.subFR(m),
    subtitle_en: fam.subEN,
    description_fr: mkDesc([base, SELL_FR, fam.care[0]]),
    description_en: mkDesc([fam.bodyEN(base), SELL_EN, fam.care[1]]),
    tags: fam.tags,
    specifications: fam.specs(lens, m).filter(Boolean),
  }
}

// --- boubous (#773, #774, #775) : garder la description longue existante ---
const BOUBOU = {
  773: {
    subtitle_fr: `Boubou de cérémonie à manches bouffantes et col en V — 5 coloris luxe`,
    subtitle_en: `Ceremonial boubou with puff sleeves and a V-neck — 5 luxe colours`,
    tags: ['boubou', 'boubou femme', 'tenue de cérémonie', 'robe de soirée', 'bubu', 'grande taille', 'nana couture', 'tenue africaine', 'manches bouffantes'],
    specs: [
      { k: 'Type', v: 'Boubou de cérémonie (bubu)' },
      { k: 'Coupe', v: 'Silhouette fluide, taille structurée' },
      { k: 'Manches', v: 'Bouffantes' },
      { k: 'Encolure', v: 'Col en V' },
      { k: 'Tissu', v: 'Finition brillante et luxueuse' },
      { k: 'Coloris', v: 'Bleu Marine, Lilas, Olive, Vin, Violet' },
      { k: 'Occasions', v: 'Cérémonies, soirées, événements formels' },
      { k: 'Entretien', v: 'Nettoyage à sec recommandé' },
    ],
  },
  774: {
    subtitle_fr: `Boubou de luxe à broderie florale bleue — blanc ou olive`,
    subtitle_en: `Luxe boubou with blue floral embroidery — white or olive`,
    tags: ['boubou', 'boubou blanc', 'boubou olive', 'broderie', 'bubu', 'tenue de cérémonie', 'nana couture', 'tenue africaine'],
    specs: [
      { k: 'Type', v: 'Boubou (bubu) en tissu structuré de luxe' },
      { k: 'Coupe', v: 'Silhouette fluide et gracieuse' },
      { k: 'Manches', v: 'Larges et évasées' },
      { k: 'Broderie', v: 'Motifs floraux bleus (manches + ourlet)' },
      { k: 'Encolure', v: 'Col en V légèrement arrondi' },
      { k: 'Coloris', v: 'Blanc ou Olive' },
      { k: 'Tailles', v: 'S à XXXL' },
      { k: 'Entretien', v: 'Nettoyage à sec recommandé' },
    ],
  },
  775: {
    subtitle_fr: `Boubou royal en mikado orange brûlé, brodé — headwrap assorti inclus`,
    subtitle_en: `Royal boubou in burnt-orange mikado, embroidered — matching headwrap included`,
    tags: ['boubou', 'bubu', 'mikado', 'tenue de cérémonie', 'broderie', 'headwrap', 'boubou orange', 'nana couture', 'tenue africaine'],
    specs: [
      { k: 'Type', v: 'Boubou royal (bubu) en mikado' },
      { k: 'Couleur principale', v: 'Orange brûlé (mikado qualité supérieure)' },
      { k: 'Panneau central', v: 'Brodé, orange profond' },
      { k: 'Coupe', v: 'Silhouette fluide, détails structurés à l\'intérieur' },
      { k: 'Tailles', v: '10 à 17' },
      { k: 'Inclus', v: 'Headwrap assorti' },
      { k: 'Autres combinaisons', v: 'Orange, Violet/Lilas, Vert/Olive' },
      { k: 'Occasions', v: 'Cérémonies, soirées, événements' },
      { k: 'Entretien', v: 'Nettoyage à sec recommandé' },
    ],
  },
}
const BOUBOU_EN_BODY = {
  774: `Meet Wúràbílọ̀, a boubou that carries elegance effortlessly. Cut from a structured luxe fabric, this white or olive boubou has a fluid, graceful silhouette for women who like to pair style with comfort. The wide, flared sleeves are set off by delicate blue floral embroidery, echoed on the hem for a refined balance. The gently rounded V-neck adds a note of simple class, making it an ideal choice for any special occasion.`,
  775: `Meet the Royal Sunset Bubu, a luxe piece made to flatter every woman. Cut from a premium burnt-orange mikado, it captures the warmth and glow of a sunset. The centre panel, finely embroidered in deep orange, brings depth and sophistication to this regal outfit. Its fluid, elegant silhouette keeps you comfortable and fits sizes 10 to 17. Supplied with a matching headwrap and structured inner details for a perfect hold and a refined look. Also available in unique colour combinations: Orange, Violet with Lilac, and Green with Olive. For women who want comfort, elegance and timeless style.`,
  773: `Meet the Bubu Majestueux, an exceptional piece for women who want to combine style, comfort and distinction. Made from a fabric with a bright, luxurious finish, it catches the light and elevates every movement, adding glamour and sophistication.\n\nIts fluid, graceful silhouette keeps you comfortable while gently flattering natural curves. The puff sleeves add volume and majesty, while the delicate V-neck sets off the neckline with finesse.\n\nThe structured detail at the waist strikes a balance between flow and hold, for a refined, harmonious line. Perfect for ceremonies, evenings, formal events and styled celebrations, this bubu is elegance and unforgettable presence.\n\nAvailable in five luxe colours: Navy (classic and timeless), Lilac (soft and feminine), Olive (natural and chic), Wine (deep and refined), Violet (majestic, distinguished glow).`,
}

function buildBoubou(p) {
  const b = BOUBOU[p.id]
  const fr = clean(p.current_description)
  return {
    subtitle_fr: b.subtitle_fr,
    subtitle_en: b.subtitle_en,
    description_fr: mkDesc([
      fr,
      `Livraison : tenue confectionnée. Précisez taille et coloris à la commande.`,
      `Entretien : nettoyage à sec recommandé pour préserver le tissu et les broderies.`,
    ]),
    description_en: mkDesc([
      BOUBOU_EN_BODY[p.id],
      `Delivery: a finished garment. State size and colour at checkout.`,
      `Care: dry-cleaning recommended to protect the fabric and embroidery.`,
    ]),
    tags: b.tags,
    specifications: b.specs,
  }
}

// --- assemblage ---
const out = {}
const counts = {}
for (const p of pull) {
  let c
  const famKey = Object.keys(FAMILIES).find((k) => p.name.startsWith(k))
  if (famKey) {
    c = buildFabric(p, famKey)
    counts[famKey] = (counts[famKey] || 0) + 1
  } else if (BOUBOU[p.id]) {
    c = buildBoubou(p)
    counts.boubou = (counts.boubou || 0) + 1
  } else {
    // repli : boubou générique traité comme vêtement
    c = buildBoubou({ ...p, id: 773 })
    counts.autre = (counts.autre || 0) + 1
  }
  out[p.id] = c
}
writeFileSync(join(HERE, '64.content.json'), JSON.stringify(out, null, 2))
console.log(`64.content.json écrit — ${Object.keys(out).length} produits`)
console.log('Par famille :', counts)

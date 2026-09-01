// build-70.mjs — génère 70.content.json (I'Dool / l'Dool "cuir en sérère",
// #70, 30 produits). Maroquinerie + chaussures cuir artisanales, Sénégal.
//
// Descriptions d'origine déjà bonnes et spécifiques -> on les GARDE comme
// corps (nettoyées : #833 a un préfixe de DOM parasite), on ajoute
// entretien cuir + specs + tags selon le type détecté.
//
//   node scripts/catalog-enrich/build-70.mjs
//   puis : node scripts/enrich-catalog.mjs apply 70 --dry-run

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const pull = JSON.parse(readFileSync(join(HERE, '70.pull.json'), 'utf8'))

// #833 "Babouches" : la fiche d'origine est un copier-coller de DOM
// ChatGPT (div/article/data-testid + classes Tailwind). Description
// réécrite à la main à partir du texte réel qu'elle contenait.
const BODY_OVERRIDE = {
  833: "Les babouches en cuir de la marque l'Dool (cuir en sérère) sont conçues pour offrir un confort optimal tout en valorisant le savoir-faire artisanal sénégalais. Fabriquées à la main avec du cuir véritable de qualité, elles sont souples, légères et agréables à porter au quotidien.\n\nLeur design traditionnel et élégant s'adapte aussi bien aux tenues modernes que traditionnelles. Idéales pour la maison, les sorties ou les événements culturels, ces babouches allient simplicité, authenticité et durabilité.\n\nCaractéristiques : 100 % cuir véritable, fabrication artisanale Made in Sénégal, légères, souples et confortables, design traditionnel et élégant. Disponibles en noir et blanc, pointures EU 35 à 45.",
}

function clean(s) {
  let t = String(s || '')
  // fiche = fragment de DOM collé -> on jette tout ce qui ressemble à du
  // markup Tailwind/React résiduel : lignes contenant pointer-events,
  // data-testid, scroll-mt, calc(var(--...)).
  if (/pointer-events-auto|data-testid|data-turn-id|scroll-mt-\[/.test(t)) {
    t = t
      .replace(/<[^>]*>/g, ' ')
      .replace(/[*\]:A-Za-z-]+\s*scroll-mt-\[[^"]*"/g, '')
      .replace(/\b(dir|data-[\w-]+|class|style)="[^"]*"/g, '')
      .replace(/[@\w/:.-]+:pt-header-height[^ ]*/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }
  return t
    .replace(/<\/(p|li|h[1-6]|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/’/g, "'")
    .replace(/\bL['']Dool\b/g, "l'Dool")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const mkDesc = (lines) =>
  lines.filter((l) => l && String(l).trim()).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()

const dims = (t) => {
  const m = String(t).match(/(\d{2,3})\s?x\s?(\d{1,3})\s?x\s?(\d{1,3})\s?cm/i)
  return m ? `${m[1]} x ${m[2]} x ${m[3]} cm` : ''
}

// Pointures présentes dans les variations (EU 35-45).
function shoeSizes(labels) {
  const s = new Set()
  for (const l of labels || []) {
    const m = String(l).match(/(?:^|\/)(\d{2})(?:$|\/)/)
    if (m && +m[1] >= 34 && +m[1] <= 46) s.add(m[1])
  }
  return [...s].sort()
}
// Coloris présents (après un "/" ou dans le nom).
function colorFromName(name) {
  const m = name.match(/[—-]\s*([A-Za-zÀ-ÿ' ]+)$/)
  return m ? m[1].trim() : ''
}

const CARE_LEATHER_FR =
  "Entretien du cuir : nourrir 2 à 3 fois par an avec un lait ou une crème incolore pour cuir, protéger de la pluie et des sources de chaleur, essuyer les taches sans détremper. Le cuir véritable se patine avec le temps — c'est normal et recherché."
const CARE_LEATHER_EN =
  "Leather care: feed 2–3 times a year with a colourless leather milk or cream, keep away from rain and heat sources, wipe stains without soaking. Genuine leather develops a patina over time — this is normal and sought-after."
const CARE_SHOE_FR =
  "Entretien : essuyer la semelle après usage, nourrir le dessus en cuir avec une crème incolore, laisser sécher à l'air loin d'une source de chaleur, glisser du papier dans la chaussure pour garder la forme."
const CARE_SHOE_EN =
  "Care: wipe the sole after wear, feed the leather upper with a colourless cream, air-dry away from heat, stuff with paper to keep the shape."

const MADE = "Fabriqué à la main au Sénégal par la marque l'Dool, spécialiste du cuir en sérère (cuir 100 % véritable)."
const MADE_EN = "Handmade in Senegal by l'Dool, a specialist in sérère leather (100 % genuine leather)."

function seg(p) {
  const n = p.name.toLowerCase()
  if (/ordinateur|laptop/.test(n)) return 'sac-ordi'
  if (/sac à dos|sac a dos|backpack/.test(n)) return 'sac-dos'
  if (/sac de voyage|voyage/.test(n)) return 'sac-voyage'
  if (/banane/.test(n)) return 'banane'
  if (/trousse|kalp[eè]|pochette/.test(n)) return 'petite-maroquinerie'
  if (/sacoche/.test(n)) return 'sacoche'
  if (/\bsac\b|kouta/.test(n)) return 'sac'
  if (/babouche/.test(n)) return 'babouche'
  if (/talon|padam dame|padam classic/.test(n)) return 'talon'
  if (/soulier/.test(n)) return 'soulier'
  if (/sandale|padam|layu/.test(n)) return 'sandale'
  return 'maroquinerie'
}

function build(p) {
  const s = seg(p)
  const body = BODY_OVERRIDE[p.id] || clean(p.current_description)
  const d = dims(p.name + ' ' + body)
  const sizes = shoeSizes(p.variation_labels)
  const color = colorFromName(p.name)
  const isShoe = /sandale|talon|babouche|soulier/.test(s)

  const careFR = isShoe ? CARE_SHOE_FR : CARE_LEATHER_FR
  const careEN = isShoe ? CARE_SHOE_EN : CARE_LEATHER_EN

  // sous-titre + type + specs par segment
  const S = {
    'sac-ordi': ['Sac ordinateur en cuir — compartiment portable, finitions soignées', 'Leather laptop bag — padded compartment, careful finishing', 'Sac ordinateur (porté épaule / main)'],
    'sac-dos': ['Sac à dos en cuir véritable — usage quotidien et déplacements', 'Genuine-leather backpack — daily use and travel', 'Sac à dos en cuir'],
    'sac-voyage': ['Sac de voyage en cuir premium — fait main au Sénégal', 'Premium leather travel bag — handmade in Senegal', 'Sac de voyage / week-end en cuir'],
    banane: ['Sac banane en cuir — à la taille ou en bandoulière', 'Leather belt bag — at the waist or crossbody', 'Sac banane en cuir'],
    'petite-maroquinerie': [`${p.name} en cuir — fait main`, `${p.name} in leather — handmade`, 'Petite maroquinerie en cuir'],
    sacoche: ['Sacoche en cuir authentique — portée bandoulière', 'Genuine-leather satchel — crossbody', 'Sacoche en cuir'],
    sac: [`Sac en cuir${color ? ` ${color.toLowerCase()}` : ''} — pièce artisanale, Made in Sénégal`, `Leather bag — handcrafted, Made in Senegal`, 'Sac à main en cuir'],
    babouche: [`Babouches en cuir souple${color ? ` ${color.toLowerCase()}` : ''} — design traditionnel`, 'Soft-leather babouches — traditional design', 'Babouche / mule en cuir'],
    talon: [`Sandales à talons en cuir${color ? ` ${color.toLowerCase()}` : ''} — doublure cuir`, 'Leather heeled sandals — leather-lined', 'Sandales à talons femme, cuir'],
    soulier: ['Soulier en cuir premium — cousu main, 100 % cuir', 'Premium leather shoe — hand-stitched, all leather', 'Soulier en cuir'],
    sandale: [`Sandales en cuir${color ? ` ${color.toLowerCase()}` : ''} — semelle confort, fait main`, 'Leather sandals — comfort sole, handmade', 'Sandales en cuir'],
    maroquinerie: [`${p.name} — cuir véritable, fait main`, `${p.name} — genuine leather, handmade`, 'Article en cuir'],
  }[s]

  const specs = [
    { k: 'Type', v: S[2] },
    { k: 'Matière', v: 'Cuir 100 % véritable (cuir en sérère)' },
    { k: 'Fabrication', v: 'Artisanale, faite main au Sénégal' },
  ]
  if (color) specs.push({ k: 'Coloris', v: color })
  if (d) specs.push({ k: 'Dimensions', v: d })
  if (isShoe && sizes.length) specs.push({ k: 'Pointures', v: `EU ${sizes[0]} à ${sizes[sizes.length - 1]}` })
  if (s === 'sac-ordi') specs.push({ k: 'Compartiment', v: 'Emplacement ordinateur portable' })
  if (/sac-dos|sac-voyage|sac|sacoche|banane/.test(s)) specs.push({ k: 'Fermeture', v: 'Zip / rabat selon le modèle' })
  if (s === 'talon') specs.push({ k: 'Talon', v: '3 à 12 cm selon le modèle' }, { k: 'Doublure', v: 'Cuir' })
  if (s === 'babouche') specs.push({ k: 'Port', v: 'Maison, sorties, événements' })
  specs.push({ k: 'Entretien', v: isShoe ? 'Crème incolore, séchage à l\'air, garder la forme' : 'Lait/crème incolore, protéger de la pluie' })

  return {
    subtitle_fr: S[0],
    subtitle_en: S[1],
    description_fr: mkDesc([
      body || `${p.name} en cuir véritable, fait main au Sénégal.`,
      /made in s[eé]n[eé]gal|made in africa|l'dool/i.test(body) ? null : MADE,
      careFR,
    ]),
    description_en: mkDesc([
      engBody(p, s, body),
      MADE_EN,
      careEN,
    ]),
    tags: tagsFor(s, color),
    specifications: specs,
  }
}

function engBody(p, s, bodyFR) {
  const type = {
    'sac-ordi': 'A leather laptop bag, elegant and functional for the working day. Roomy main compartment for a laptop, careful finishing, a comfortable strap.',
    'sac-dos': "A genuine-leather backpack, elegant and practical for everyday use. Large main compartment, zipped front pocket, reinforced straps for all-day comfort.",
    'sac-voyage': "A premium leather travel bag, handmade in Senegal from high-quality genuine leather. Built to carry a weekend's belongings and to last for years.",
    banane: "A leather belt bag, handmade from 100% natural leather. Holds your essentials (phone, wallet, keys) and wears at the waist or crossbody. Secure zip closure.",
    'petite-maroquinerie': `A ${p.name.toLowerCase()} in premium leather, carefully handmade for durability and everyday use.`,
    sacoche: "A genuine-leather satchel by l'Dool, handmade from 100% leather. Carried crossbody, with careful finishing and a long life.",
    sac: `A leather bag by l'Dool${/kouta/i.test(p.name) ? ' (KOUTA line)' : ''}, a handcrafted piece made to combine style, function and durability.`,
    babouche: "Soft leather babouches, handmade from quality genuine leather. Light, supple and comfortable day to day, with a traditional, elegant design that suits both modern and traditional outfits.",
    talon: "Heeled sandals for women in leather, kevlar and raffia, with a leather lining for step-after-step comfort. A stable heel, from 3 cm to 12 cm depending on the model.",
    soulier: "A premium leather shoe by l'Dool, hand-stitched from 100% leather. Each pair is finished with care for a clean line and a long life.",
    sandale: "Leather sandals, handmade with 100% genuine leather. A thick sole for all-day comfort and a clean, modern line.",
    maroquinerie: `${p.name}: a genuine-leather item, handmade in Senegal.`,
  }[s]
  return type
}

function tagsFor(s, color) {
  const base = ['cuir', 'cuir véritable', 'fait main', 'artisanat sénégalais', "l'Dool", 'Made in Sénégal', 'cuir en sérère']
  const extra = {
    'sac-ordi': ['sac ordinateur', 'sac cuir homme', 'sac bureau'],
    'sac-dos': ['sac à dos', 'sac à dos cuir'],
    'sac-voyage': ['sac de voyage', 'sac week-end', 'bagage cuir'],
    banane: ['sac banane', 'banane cuir', 'sac ceinture'],
    'petite-maroquinerie': ['trousse', 'petite maroquinerie', 'pochette cuir'],
    sacoche: ['sacoche', 'sacoche cuir', 'sac bandoulière'],
    sac: ['sac à main', 'sac cuir', 'sac femme'],
    babouche: ['babouche', 'babouche cuir', 'mule cuir', 'chaussure traditionnelle'],
    talon: ['sandales à talons', 'talon femme', 'chaussure cuir femme'],
    soulier: ['soulier', 'chaussure cuir homme', 'derby cuir'],
    sandale: ['sandale', 'sandale cuir', 'sandale artisanale'],
    maroquinerie: ['maroquinerie'],
  }[s] || []
  return [...extra, ...base]
}

// ---- assemblage ---
const out = {}
const counts = {}
for (const p of pull) {
  out[p.id] = build(p)
  counts[seg(p)] = (counts[seg(p)] || 0) + 1
}
writeFileSync(join(HERE, '70.content.json'), JSON.stringify(out, null, 2))
console.log(`70.content.json écrit — ${Object.keys(out).length} produits`)
console.log('Par segment :', counts)

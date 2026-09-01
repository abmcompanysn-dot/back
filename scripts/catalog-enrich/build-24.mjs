// build-24.mjs — génère 24.content.json (Blings_by_ze, #24, 59 produits).
//
// Ces fiches ont déjà une bonne description d'origine, courte (1 paragraphe
// spécifique par produit). On la GARDE comme accroche, on ajoute autour la
// structure manquante (matériau/entretien acier inox, port, cadeau) selon
// le TYPE de bijou détecté, plus sous-titre + specs + tags.
//
//   node scripts/catalog-enrich/build-24.mjs
//   puis : node scripts/enrich-catalog.mjs apply 24 --dry-run

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const pull = JSON.parse(readFileSync(join(HERE, '24.pull.json'), 'utf8'))

const stripTags = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/’/g, "'")
    .replace(/^[-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()

const mkDesc = (lines) =>
  lines.filter((l) => l !== null && l !== undefined && l !== '').join('\n\n').replace(/\n{3,}/g, '\n\n').trim()

// Type de produit d'après le nom (repli : description).
function kindOf(name, desc) {
  const t = `${name} ${desc}`.toLowerCase()
  if (/\bmontre\b/.test(t)) return 'montre'
  if (/coupon|tissu|m[eè]trage|rouleau|chemise premium/.test(t)) return 'tissu'
  if (/parure/.test(t)) return 'parure'
  if (/\bcollier\b/.test(t) && !/parure/.test(t)) return 'collier'
  if (/bracelet|jonc|manchette|duo bracelets|trio bracelets/.test(t)) {
    if (/r[eé]sine/.test(t)) return 'bracelet-resine'
    return 'bracelet'
  }
  if (/boucle|cr[eé]ole|puce/.test(t)) return 'boucles'
  return 'bijou'
}

// Métal / finition d'après la description.
function metal(desc) {
  const d = desc.toLowerCase()
  const dore = /dor[ée]|gold/.test(d)
  const argent = /argent[ée]|silver/.test(d)
  if (dore && argent) return 'acier inoxydable, finition dorée ou argentée selon le modèle'
  if (dore) return 'acier inoxydable, finition dorée brillante'
  if (argent) return 'acier inoxydable, finition argentée'
  if (/r[eé]sine/.test(d)) return 'résine'
  return 'acier inoxydable'
}

const CARE_STEEL =
  "Entretien : essuyer avec un chiffon doux, éviter le contact prolongé avec l'eau, les parfums et les produits cosmétiques, ranger à l'abri de l'humidité."
const CARE_RESIN =
  "Entretien : nettoyer avec un chiffon doux et sec, éviter les chocs et les sources de chaleur qui peuvent marquer la résine, retirer avant la douche."
const CARE_WATCH =
  "Entretien : garder le bracelet cuir à l'écart de l'eau et de l'humidité, essuyer le boîtier avec un chiffon doux. Mouvement quartz : la pile se remplace chez tout horloger."

function build(p) {
  const desc0 = stripTags(p.current_description) || p.name
  const kind = kindOf(p.name, desc0)
  const met = metal(desc0)
  const isGift = /parure|montre/.test(kind)

  const common = {
    tagsBase: ['bijou', 'acier inoxydable', 'Blings by ze', 'accessoire femme', 'cadeau femme'],
  }

  if (kind === 'montre') {
    return {
      subtitle_fr: `Montre à quartz, boîtier ovale, bracelet cuir — livrée en écrin cadeau`,
      subtitle_en: `Quartz watch, oval case, leather strap — delivered in a gift box`,
      description_fr: mkDesc([
        desc0,
        `Boîtier ovale, cadran à chiffres romains, aiguilles fines. Mouvement à quartz (pile), précis et sans entretien mécanique. Bracelet en cuir avec boucle ardillon réglable.`,
        `Livrée dans un écrin, prête à offrir. Se porte aussi bien en journée qu'en soirée, avec une tenue habillée comme décontractée.`,
        CARE_WATCH,
      ]),
      description_en: mkDesc([
        engMontre(desc0),
        `Oval case, Roman-numeral dial, slim hands. Quartz movement (battery), accurate and free of mechanical upkeep. Leather strap with an adjustable pin buckle.`,
        `Delivered in a box, ready to gift. Wears from day to evening, with dressy or casual outfits.`,
        `Care: keep the leather strap away from water and humidity, wipe the case with a soft cloth. Quartz movement: the battery is replaced by any watchmaker.`,
      ]),
      tags: ['montre', 'montre femme', 'montre quartz', 'bracelet cuir', 'montre ovale', ...common.tagsBase],
      specifications: [
        { k: 'Type', v: 'Montre à quartz (analogique)' },
        { k: 'Boîtier', v: 'Forme ovale' },
        { k: 'Cadran', v: 'Chiffres romains, aiguilles fines' },
        { k: 'Bracelet', v: braceletColor(desc0) },
        { k: 'Mouvement', v: 'Quartz (pile)' },
        { k: 'Livraison', v: 'Écrin cadeau inclus' },
        { k: 'Entretien', v: "Bracelet cuir à tenir à l'écart de l'eau" },
      ],
    }
  }

  if (kind === 'tissu') {
    return {
      subtitle_fr: `Coupon de tissu chemise premium — tissage fin, vendu au métrage`,
      subtitle_en: `Premium shirting fabric length — fine weave, sold by the metre`,
      description_fr: mkDesc([
        desc0,
        `Tissage serré et souple, tombé fluide, adapté à la confection de chemises sur mesure, chemisiers et hauts légers. Coloris uni.`,
        `Vendu au coupon / au rouleau : indiquez le métrage souhaité. Lavage à 30 °C sur l'envers recommandé, repassage tissu légèrement humide.`,
      ]),
      description_en: mkDesc([
        `Premium shirting fabric, ${fabricColorEN(desc0)}, fine and supple weave for made-to-measure shirts.`,
        `Tight, supple weave with a fluid drape, suited to tailored shirts, blouses and light tops. Plain colour.`,
        `Sold by the length / roll: state the metrage you need. Wash at 30 °C inside out, iron slightly damp.`,
      ]),
      tags: ['tissu', 'coupon tissu', 'tissu chemise', 'tissu sur-mesure', 'mercerie', 'Blings by ze', 'couture'],
      specifications: [
        { k: 'Type', v: 'Coupon de tissu (chemiserie)' },
        { k: 'Coloris', v: fabricColorFR(desc0) },
        { k: 'Tissage', v: 'Fin et souple, tombé fluide' },
        { k: 'Usage', v: 'Chemises, chemisiers, hauts légers sur mesure' },
        { k: 'Vente', v: 'Au métrage / au rouleau' },
        { k: 'Entretien', v: 'Lavage 30 °C sur l\'envers, repassage tissu humide' },
      ],
    }
  }

  if (kind === 'parure') {
    return {
      subtitle_fr: `Parure collier + boucles d'oreilles assortis — ${met}`,
      subtitle_en: `Matching necklace + earrings set`,
      description_fr: mkDesc([
        desc0,
        `L'ensemble comprend le collier et sa paire de boucles d'oreilles coordonnées. Chaîne fine à longueur réglable, fermoir mousqueton. Boucles à tige et poussoir.`,
        `${met.charAt(0).toUpperCase() + met.slice(1)} : ne noircit pas, résiste au quotidien, convient aux peaux sensibles. Se porte en entier pour une occasion ou séparément au quotidien.`,
        `Idéale à offrir : livrée prête à être glissée dans un écrin.`,
        CARE_STEEL,
      ]),
      description_en: mkDesc([
        engBijou(desc0),
        `The set includes the necklace and its matching pair of earrings. Fine chain with adjustable length, lobster clasp. Stud earrings with push backs.`,
        `Stainless steel: does not tarnish, holds up to daily wear, suits sensitive skin. Wear the full set for an occasion or each piece on its own day to day.`,
        `A ready gift: supplied ready to slip into a box.`,
        `Care: wipe with a soft cloth, avoid prolonged contact with water, perfume and cosmetics, store away from humidity.`,
      ]),
      tags: ['parure', 'collier et boucles', 'parure dorée', 'collier femme', 'boucles d\'oreilles', 'ensemble bijoux', ...common.tagsBase],
      specifications: [
        { k: 'Composition', v: 'Collier + boucles d\'oreilles assorties' },
        { k: 'Matière', v: met },
        { k: 'Chaîne', v: 'Fine, longueur réglable, fermoir mousqueton' },
        { k: 'Boucles', v: 'Tige et poussoir' },
        { k: 'Peau sensible', v: 'Convient (acier inoxydable)' },
        { k: 'Livraison', v: 'Prête à offrir' },
        { k: 'Entretien', v: "Chiffon doux, éviter eau/parfum/cosmétiques" },
      ],
    }
  }

  if (kind === 'collier') {
    return {
      subtitle_fr: `Collier à pendentif — chaîne fine réglable, ${met}`,
      subtitle_en: `Pendant necklace — fine adjustable chain`,
      description_fr: mkDesc([
        desc0,
        `Chaîne fine à longueur réglable, fermoir mousqueton. ${met.charAt(0).toUpperCase() + met.slice(1)} : ne noircit pas, convient aux peaux sensibles.`,
        `Se porte seul pour un effet minimaliste ou superposé à d'autres chaînes.`,
        CARE_STEEL,
      ]),
      description_en: mkDesc([
        engBijou(desc0),
        `Fine chain with adjustable length, lobster clasp. Stainless steel: does not tarnish, suits sensitive skin.`,
        `Wear it alone for a minimalist look or layered with other chains.`,
        `Care: wipe with a soft cloth, avoid prolonged contact with water, perfume and cosmetics.`,
      ]),
      tags: ['collier', 'collier femme', 'pendentif', 'collier doré', 'chaîne fine', ...common.tagsBase],
      specifications: [
        { k: 'Type', v: 'Collier à pendentif' },
        { k: 'Matière', v: met },
        { k: 'Chaîne', v: 'Fine, longueur réglable, fermoir mousqueton' },
        { k: 'Peau sensible', v: 'Convient (acier inoxydable)' },
        { k: 'Entretien', v: 'Chiffon doux, éviter eau/parfum/cosmétiques' },
      ],
    }
  }

  if (kind === 'bracelet-resine') {
    const lot = /lot de 3|x\s?3|\(3\)/i.test(desc0) ? 'Lot de 3 bracelets' : 'Bracelets'
    return {
      subtitle_fr: `${lot} joncs en résine — à empiler`,
      subtitle_en: `Set of resin bangle bracelets — stackable`,
      description_fr: mkDesc([
        desc0,
        `Joncs rigides à enfiler par la main, diamètre standard adulte. La résine est légère et confortable à porter toute la journée.`,
        `À porter en pile sur un poignet, ou répartis avec vos bijoux dorés. Effet bohème chic ou coloré selon la tenue.`,
        CARE_RESIN,
      ]),
      description_en: mkDesc([
        engBijou(desc0),
        `Rigid bangles that slide over the hand, standard adult diameter. Resin is light and comfortable for all-day wear.`,
        `Stack them on one wrist, or spread them among your gold pieces. Boho-chic or colourful depending on the outfit.`,
        `Care: clean with a soft dry cloth, avoid knocks and heat sources that can mark resin, remove before showering.`,
      ]),
      tags: ['bracelet', 'bracelet jonc', 'bracelet résine', 'lot de bracelets', 'bracelets à empiler', 'Blings by ze', 'accessoire femme'],
      specifications: [
        { k: 'Type', v: 'Bracelets joncs rigides (lot)' },
        { k: 'Matière', v: 'Résine, finition brillante' },
        { k: 'Enfilage', v: 'Par la main, diamètre standard adulte' },
        { k: 'Port', v: 'Empilés ou répartis' },
        { k: 'Entretien', v: 'Chiffon sec, éviter chocs et chaleur' },
      ],
    }
  }

  if (kind === 'bracelet') {
    const multi = /duo|trio|ensemble de \d|lot/i.test(desc0)
    return {
      subtitle_fr: multi
        ? `Bracelets à empiler — ${met}`
        : `Bracelet jonc / manchette — ${met}`,
      subtitle_en: multi ? `Stackable bracelet set` : `Bangle / cuff bracelet`,
      description_fr: mkDesc([
        desc0,
        `${met.charAt(0).toUpperCase() + met.slice(1)} : ne noircit pas, garde son éclat, convient aux peaux sensibles. ${multi ? 'À porter ensemble pour un effet plus marqué ou séparément.' : 'À enfiler par le poignet ; ouverture souple pour un ajustement facile.'}`,
        `Se porte seul pour un effet minimaliste ou superposé à une montre et à d'autres joncs.`,
        CARE_STEEL,
      ]),
      description_en: mkDesc([
        engBijou(desc0),
        `Stainless steel: does not tarnish, keeps its shine, suits sensitive skin. ${multi ? 'Wear together for a bolder effect or separately.' : 'Slides over the wrist; a flexible opening makes fit easy.'}`,
        `Wear alone for a minimalist look or stacked with a watch and other bangles.`,
        `Care: wipe with a soft cloth, avoid prolonged contact with water, perfume and cosmetics.`,
      ]),
      tags: ['bracelet', multi ? 'bracelets à empiler' : 'bracelet jonc', 'bracelet doré', 'manchette', 'bijou minimaliste', ...common.tagsBase],
      specifications: [
        { k: 'Type', v: multi ? 'Lot de bracelets à empiler' : 'Bracelet jonc / manchette' },
        { k: 'Matière', v: met },
        { k: 'Ajustement', v: multi ? 'Diamètre standard adulte' : 'Ouverture souple, enfilage par le poignet' },
        { k: 'Peau sensible', v: 'Convient (acier inoxydable)' },
        { k: 'Entretien', v: 'Chiffon doux, éviter eau/parfum/cosmétiques' },
      ],
    }
  }

  // boucles / créoles / bijou générique
  return {
    subtitle_fr: `Boucles d'oreilles — ${met}, légères à porter`,
    subtitle_en: `Earrings — light to wear`,
    description_fr: mkDesc([
      desc0,
      `${met.charAt(0).toUpperCase() + met.slice(1)} : ne noircit pas, ne provoque pas d'allergie dans la grande majorité des cas, garde son éclat dans le temps. Tige et poussoir (ou système créole selon le modèle).`,
      `Légères, elles se portent toute la journée sans tirer sur le lobe. À assortir à un bracelet ou un collier de la même finition.`,
      CARE_STEEL,
    ]),
    description_en: mkDesc([
      engBijou(desc0),
      `Stainless steel: does not tarnish, non-allergenic for the large majority of wearers, keeps its shine over time. Post and push back (or hoop system depending on the model).`,
      `Light enough to wear all day without pulling on the lobe. Match with a bracelet or necklace in the same finish.`,
      `Care: wipe with a soft cloth, avoid prolonged contact with water, perfume and cosmetics.`,
    ]),
    tags: ["boucles d'oreilles", 'créoles', 'boucles dorées', 'bijou minimaliste', 'puces oreilles', ...common.tagsBase],
    specifications: [
      { k: 'Type', v: "Boucles d'oreilles" },
      { k: 'Matière', v: met },
      { k: 'Attache', v: 'Tige et poussoir (ou créole selon le modèle)' },
      { k: 'Poids', v: 'Légères, port prolongé confortable' },
      { k: 'Peau sensible', v: 'Convient (acier inoxydable)' },
      { k: 'Entretien', v: 'Chiffon doux, éviter eau/parfum/cosmétiques' },
    ],
  }
}

// --- petites aides EN (les fiches d'origine sont en FR, on rend une
//     phrase EN fidèle mais générique selon le type, on n'essaie pas de
//     traduire mot à mot le détail FR). ---
function engBijou(descFR) {
  const d = descFR.toLowerCase()
  const fin = /r[eé]sine/.test(d)
    ? 'resin'
    : /dor[ée]/.test(d)
      ? 'gold-finish'
      : /argent[ée]/.test(d)
        ? 'silver-finish'
        : 'stainless-steel'
  // parure d'abord (contient "boucles d'oreilles" dans le texte)
  if (/parure/.test(d))
    return `A ${fin} matching necklace-and-earrings set by Blings by ze, with a clean, contemporary line.`
  if (/lot de 3|duo|trio|ensemble de \d/.test(d) && /bracelet|jonc/.test(d))
    return `A set of ${fin} stacking bracelets by Blings by ze, with a clean, contemporary line.`
  if (/boucles? d.oreilles?|cr[eé]ole|boucle rectangulaire|boucles? rectangulaires/.test(d))
    return `A pair of ${fin} earrings by Blings by ze, with a clean, contemporary line.`
  if (/collier/.test(d))
    return `A ${fin} pendant necklace by Blings by ze, with a clean, contemporary line.`
  if (/bracelet|jonc|manchette/.test(d))
    return `A ${fin} bangle by Blings by ze, with a clean, contemporary line.`
  return `A ${fin} piece of jewellery by Blings by ze, with a clean, contemporary line.`
}
function engMontre(descFR) {
  const d = descFR.toLowerCase()
  const color = /vert/.test(d) ? 'green' : /marron|brun/.test(d) ? 'brown' : 'black'
  const tone = /dor[ée]/.test(d) ? 'gold-tone' : 'silver-tone'
  return `An elegant quartz watch with a ${tone} oval case, white Roman-numeral dial and slim hands, on a ${color} leather strap.`
}
function braceletColor(descFR) {
  const d = descFR.toLowerCase()
  const color = /vert/.test(d) ? 'Cuir vert' : /marron|brun/.test(d) ? 'Cuir marron' : 'Cuir noir'
  return /croco/.test(d) ? `${color} façon croco` : color
}
function fabricColorFR(descFR) {
  const m = descFR.match(/coloris\s+([a-zàâäéèêëîïôöùûüç ]+?)[,.]/i)
  return m ? m[1].trim() : 'uni'
}
function fabricColorEN(descFR) {
  const c = fabricColorFR(descFR).toLowerCase()
  return c.replace('bleu ciel', 'sky blue').replace('bleu', 'blue').replace('blanc', 'white').replace('noir', 'black').replace('gris', 'grey')
}

// --- assemblage ---
const out = {}
const counts = {}
for (const p of pull) {
  const c = build(p)
  out[p.id] = c
  const k = kindOf(p.name, stripTags(p.current_description))
  counts[k] = (counts[k] || 0) + 1
}
writeFileSync(join(HERE, '24.content.json'), JSON.stringify(out, null, 2))
console.log(`24.content.json écrit — ${Object.keys(out).length} produits`)
console.log('Par type :', counts)

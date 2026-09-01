// build-66.mjs — génère 66.content.json (ALL store, #66, 38 produits).
//
// Boutique fourre-tout : catégories mélangées, descriptions souvent
// auto-générées et hors-sujet ("produit alimentaire naturel" sur un
// tableau de verre). On classe par catégorie + mot-clé du NOM, on ne
// garde de la description que ce qui est cohérent (bloc COMPOSITION/
// UTILISATION pour les soins ; sinon on réécrit à partir du nom).
//
// #782 (Toyota Camry Hybride, sans description, sans EN, prix 48 900) est
// IGNORÉ — hors périmètre catalogue artisanal.
//
//   node scripts/catalog-enrich/build-66.mjs
//   puis : node scripts/enrich-catalog.mjs apply 66 --dry-run

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const pull = JSON.parse(readFileSync(join(HERE, '66.pull.json'), 'utf8'))

const SKIP_IDS = new Set([782]) // Toyota Camry — hors périmètre

// Nettoyage : balises -> retours ligne, entités, filler retiré.
function clean(s) {
  return String(s || '')
    .replace(/<\/(p|li|h[1-6]|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/’/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Un texte est "filler" si, une fois retirée la ligne d'entête qui
// répète le nom, son 1er paragraphe est une tournure générique connue
// (souvent hors-sujet).
const FILLER_OPENERS = [
  /un produit alimentaire naturel de qualite superieure/i,
  /une oeuvre d'art originale qui capture l'emotion/i,
  /un accessoire soigneusement confectionne/i,
  /un vetement magnifiquement confectionne/i,
  /un produit de soin soigneusement formule/i,
  /un produit capillaire haut de gamme/i,
]
// Retire une éventuelle 1re ligne qui n'est que le nom du produit.
function stripNameEcho(txt, name) {
  const lines = txt.split('\n')
  const norm = (s) => s.toLowerCase().replace(/[^a-zàâäéèêëîïôöùûüç0-9]+/g, ' ').trim()
  if (lines.length > 1 && norm(lines[0]).length && norm(name).includes(norm(lines[0]).slice(0, 20))) {
    return lines.slice(1).join('\n').trim()
  }
  return txt
}

// Coupe le préambule filler : on garde à partir du 1er intertitre utile
// (COMPOSITION, CARACTERISTIQUES, COMMENT, UTILISATION, POUR QUI, INGREDIENTS).
function usefulTail(txt) {
  const m = txt.match(/\n\s*(COMPOSITION|CARACT[EÉ]RISTIQUES|INGR[EÉ]DIENTS|COMMENT L'UTILISER|UTILISATION|MODE D'EMPLOI|CE QUE [ÇC]A FAIT|POUR QUI|BIENFAITS)\b/i)
  if (m) return txt.slice(m.index).trim()
  return ''
}

const mkDesc = (lines) =>
  lines.filter((l) => l && String(l).trim()).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()

// ---- classifieurs -----------------------------------------------
function segment(p) {
  const cat = (p.category || '').toLowerCase()
  const n = p.name.toLowerCase()
  if (/toyota|camry|voiture/.test(n)) return 'skip'
  if (/savon/.test(n)) return 'savon'
  if (/gel nettoyant|intime/.test(n)) return 'gel-intime'
  if (/cr[eè]me coiffante|capillaire|gamme capillaire|stylin/.test(n)) return 'capillaire'
  if (/[eé]pice|soumbara|m[eé]lange d'[eé]pices/.test(n)) return 'epice'
  if (/sac (cabas|artisanal|à dos)|sac à main/.test(n) || (cat.includes('sacs') && /sac/.test(n))) return 'sac'
  if (/tableau|table (en verre|sand|glass|women|sand|d'appoint)|sand (art|map|table)|carte d'afrique|panneau de verre|plaque d[eé]corative|bois de table|bois grand format|peinture sur verre/.test(n)) return 'tableau'
  if (/boucle|bijou|mode et bijoux/.test(n)) return 'bijou'
  if (/v[eê]tements?$/.test(n) || cat.includes('mode - v')) return 'vetement'
  return 'generic'
}

// Sous-type de tableau d'après le nom.
function tableauKind(n) {
  const t = n.toLowerCase()
  if (/carte d'afrique|map of africa|sand map/.test(t)) return { fr: "carte de l'Afrique", en: 'map of Africa', tech: /sable|sand/.test(t) ? 'sable' : 'verre' }
  if (/pilant|pounding|pile le mil|pounding (grain|millet)/.test(t)) return { fr: 'une femme pilant le mil', en: 'a woman pounding millet', tech: /sable|sand/.test(t) ? 'sable' : 'verre' }
  if (/calebass|calabash/.test(t)) return { fr: 'une femme à la calebasse', en: 'a woman with a calabash', tech: /sable|sand/.test(t) ? 'sable' : 'verre' }
  if (/maternit|femme.*enfant|women.*enfant|femme avec enfant/.test(t)) return { fr: 'une scène de maternité', en: 'a motherhood scene', tech: 'verre' }
  if (/goree|slaves|maison des esclaves/.test(t)) return { fr: "la Maison des Esclaves de Gorée", en: "the House of Slaves, Gorée", tech: 'verre' }
  if (/horseback|cheval/.test(t)) return { fr: 'des femmes à cheval', en: 'women on horseback', tech: 'sable' }
  if (/calligraphie|allah|islamique/.test(t)) return { fr: "la calligraphie du nom d'Allah", en: "the calligraphy of the name of Allah", tech: 'tissu' }
  if (/bois/.test(t)) return { fr: 'une scène africaine sculptée', en: 'a carved African scene', tech: 'bois' }
  if (/tissu/.test(t)) return { fr: 'une scène africaine', en: 'an African scene', tech: 'tissu' }
  return { fr: 'une scène africaine', en: 'an African scene', tech: /sable|sand/.test(t) ? 'sable' : 'verre' }
}

function dims(name) {
  const m = name.match(/(\d{2,3})\s?[x×/]\s?(\d{2,3})/)
  return m ? `${m[1]} x ${m[2]} cm` : ''
}

// ---- constructeurs par segment --------------------------------
function build(p) {
  const seg = segment(p)
  const raw = stripNameEcho(clean(p.current_description), p.name)
  const rawIsFiller = FILLER_OPENERS.some((re) => re.test(raw.slice(0, 200)))
  const tail = usefulTail(raw)
  // Pour les soins, on préfère toujours le bloc structuré (COMPOSITION…)
  // s'il existe, et on jette le préambule (souvent générique/hors-sujet).
  const preferTail = /savon|gel-intime|capillaire/.test(seg) || rawIsFiller
  const salvage = preferTail ? tail : raw

  if (seg === 'tableau') {
    const k = tableauKind(p.name)
    const d = dims(p.name)
    const techFR = {
      sable: 'sable naturel coloré fixé sur panneau',
      verre: 'peinture sous verre (technique du verre inversé)',
      bois: 'bois massif sculpté',
      tissu: 'tissu tendu',
    }[k.tech]
    const techEN = {
      sable: 'coloured natural sand set on a board',
      verre: 'reverse-glass painting',
      bois: 'carved solid wood',
      tissu: 'stretched fabric',
    }[k.tech]
    return {
      subtitle_fr: `Tableau artisanal sénégalais — ${k.fr}${d ? `, ${d}` : ''}`,
      subtitle_en: `Senegalese handcrafted wall art — ${k.en}${d ? `, ${d}` : ''}`,
      description_fr: mkDesc([
        `Tableau décoratif réalisé à la main au Sénégal. Sujet : ${k.fr}. Réalisation en ${techFR}.`,
        `Chaque pièce est faite à l'unité : les couleurs et les détails varient légèrement d'un exemplaire à l'autre. Prêt à accrocher.`,
        d ? `Dimensions : ${d}.` : null,
        `Entretien : dépoussiérer avec un chiffon sec ou un plumeau, éviter l'humidité et l'exposition directe au soleil.`,
      ]),
      description_en: mkDesc([
        `A decorative wall piece handmade in Senegal. Subject: ${k.en}. Made in ${techEN}.`,
        `Each piece is one-off: colours and detail vary slightly between items. Ready to hang.`,
        d ? `Dimensions: ${d}.` : null,
        `Care: dust with a dry cloth or a feather duster, keep away from humidity and direct sunlight.`,
      ]),
      tags: ['tableau', 'art africain', 'décoration murale', 'artisanat sénégalais', k.tech === 'sable' ? 'tableau de sable' : k.tech === 'verre' ? 'peinture sous verre' : 'art mural', 'fait main', 'ALL store'],
      specifications: [
        { k: 'Type', v: 'Tableau décoratif mural' },
        { k: 'Sujet', v: k.fr.charAt(0).toUpperCase() + k.fr.slice(1) },
        { k: 'Technique', v: techFR },
        d ? { k: 'Dimensions', v: d } : null,
        { k: 'Fabrication', v: 'Faite main au Sénégal' },
        { k: 'Unicité', v: "Pièce unique, légères variations d'un exemplaire à l'autre" },
        { k: 'Pose', v: 'Prêt à accrocher' },
        { k: 'Entretien', v: 'Chiffon sec, éviter humidité et soleil direct' },
      ].filter(Boolean),
    }
  }

  if (seg === 'savon') {
    const name = p.name.replace(/^Savon\s+/i, '')
    return {
      subtitle_fr: `Savon artisanal ${name.toLowerCase()} — visage et corps, usage quotidien`,
      subtitle_en: `Handmade ${name.toLowerCase()} soap — face and body, daily use`,
      description_fr: mkDesc([
        `${p.name} : savon de soin fabriqué à la main, formulé avec des ingrédients naturels actifs pour nettoyer, nourrir et apaiser la peau. Convient à tous les types de peau, y compris sensibles.`,
        salvage || null,
        `Conservation : garder au sec entre deux utilisations, sur un porte-savon drainant, à l'abri de la lumière directe.`,
      ]),
      description_en: mkDesc([
        `${p.name}: a handmade care soap formulated with active natural ingredients to cleanse, nourish and soothe the skin. Suits all skin types, including sensitive.`,
        `Keep it dry between uses on a draining soap dish, away from direct light.`,
      ]),
      tags: ['savon', 'savon artisanal', 'savon naturel', 'soin visage', 'soin corps', 'cosmétique naturel', 'fait main', 'ALL store'],
      specifications: [
        { k: 'Type', v: 'Savon de soin solide' },
        { k: 'Zone', v: 'Visage et corps' },
        { k: 'Peau', v: 'Tous types, y compris sensible' },
        { k: 'Fabrication', v: 'Artisanale, ingrédients naturels' },
        { k: 'Usage', v: 'Quotidien, matin et soir' },
        { k: 'Conservation', v: 'Au sec, sur porte-savon drainant' },
      ],
    }
  }

  if (seg === 'gel-intime') {
    return {
      subtitle_fr: `Gel nettoyant intime aux extraits de plantes — usage quotidien, pH doux`,
      subtitle_en: `Plant-based intimate wash — daily use, gentle pH`,
      description_fr: mkDesc([
        `Gel lavant pour la toilette intime, formulé avec des extraits de plantes apaisantes. Nettoie en douceur en respectant l'équilibre naturel, sans dessécher.`,
        salvage || null,
        `Usage : une petite quantité sur zone externe, rincer à l'eau claire. Ne pas utiliser en interne. Tenir hors de portée des enfants.`,
      ]),
      description_en: mkDesc([
        `A wash for intimate hygiene, formulated with soothing plant extracts. Cleanses gently while respecting the natural balance, without drying.`,
        `Use a small amount on the external area, rinse with clean water. Not for internal use. Keep out of reach of children.`,
      ]),
      tags: ['hygiène intime', 'gel intime', 'toilette intime', 'soin aux plantes', 'cosmétique naturel', 'ALL store'],
      specifications: [
        { k: 'Type', v: 'Gel nettoyant intime' },
        { k: 'Formule', v: 'Extraits de plantes apaisantes, pH doux' },
        { k: 'Usage', v: 'Quotidien, zone externe uniquement' },
        { k: 'Précautions', v: 'Pas d\'usage interne, tenir hors de portée des enfants' },
      ],
    }
  }

  if (seg === 'capillaire') {
    const isPack = /pack|gamme/i.test(p.name)
    return {
      subtitle_fr: isPack
        ? `Pack soin capillaire enfants — routine complète, tous types de cheveux`
        : `Crème coiffante définissante et hydratante — boucles et cheveux texturés`,
      subtitle_en: isPack
        ? `Kids' hair-care set — full routine, all hair types`
        : `Defining moisturising styling cream — curls and textured hair`,
      description_fr: mkDesc([
        isPack
          ? `${p.name} : ensemble de soins capillaires pensé pour les cheveux des enfants — nettoie, démêle et hydrate en douceur. Convient aux cheveux naturels, tressés ou défrisés.`
          : `${p.name} : crème coiffante qui définit les boucles, hydrate et discipline les frisottis sans effet carton. Pour cheveux bouclés, frisés et crépus.`,
        salvage || null,
        `Usage : appliquer sur cheveux humides, mèche par mèche, froisser pour former la boucle, laisser sécher à l'air libre.`,
      ]),
      description_en: mkDesc([
        isPack
          ? `${p.name}: a hair-care set designed for children's hair — gently cleanses, detangles and moisturises. Suits natural, braided or relaxed hair.`
          : `${p.name}: a styling cream that defines curls, moisturises and tames frizz without a crunchy finish. For curly, coily and kinky hair.`,
        `Apply to damp hair section by section, scrunch to form the curl, air-dry.`,
      ]),
      tags: ['soin cheveux', 'cheveux naturels', isPack ? 'soin enfant' : 'crème coiffante', 'boucles', 'hydratation cheveux', 'cosmétique naturel', 'ALL store'],
      specifications: [
        { k: 'Type', v: isPack ? 'Pack / routine capillaire enfants' : 'Crème coiffante hydratante' },
        { k: 'Cheveux', v: isPack ? 'Naturels, tressés, défrisés' : 'Bouclés, frisés, crépus' },
        { k: 'Action', v: isPack ? 'Nettoie, démêle, hydrate' : 'Définit, hydrate, anti-frisottis' },
        { k: 'Application', v: 'Sur cheveux humides' },
      ],
    }
  }

  if (seg === 'epice') {
    return {
      subtitle_fr: `Mélange d'épices soumbara artisanal — sauces, riz, bouillons`,
      subtitle_en: `Artisanal soumbara spice blend — sauces, rice, broths`,
      description_fr: mkDesc([
        `Mélange artisanal à base de soumbara (néré fermenté), associé à du poisson fumé, des crevettes séchées, de l'oignon déshydraté et du piment. Un condiment umami puissant, base des sauces d'Afrique de l'Ouest.`,
        salvage && !FILLER_OPENERS.some((re) => re.test(raw)) ? salvage : null,
        `Utilisation : ajouter en cours de cuisson dans les sauces, riz gras, bouillons et plats traditionnels, à doser selon le goût. Conditionné en pot verre 100 g à couvercle hermétique.`,
        `Conservation : au sec, à l'abri de la lumière et de l'humidité, bien refermer après usage.`,
      ]),
      description_en: mkDesc([
        `An artisanal blend based on soumbara (fermented néré), with smoked fish, dried shrimp, dehydrated onion and chilli. A powerful umami seasoning, the base of West African sauces.`,
        `Use: add during cooking to sauces, jollof-style rice, broths and traditional dishes, to taste. Packed in a 100 g glass jar with an airtight lid.`,
        `Storage: keep dry, away from light and humidity, reseal after use.`,
      ]),
      tags: ['épices', 'soumbara', 'néré', 'condiment', 'cuisine africaine', 'assaisonnement', 'épicerie', 'ALL store'],
      specifications: [
        { k: 'Type', v: "Mélange d'épices / condiment" },
        { k: 'Composition', v: 'Soumbara, poisson fumé, crevettes séchées, oignon, piment' },
        { k: 'Conditionnement', v: 'Pot verre 100 g, couvercle hermétique' },
        { k: 'Usage', v: 'Sauces, riz, bouillons, plats traditionnels' },
        { k: 'Conservation', v: "Au sec, à l'abri de la lumière et de l'humidité" },
      ],
    }
  }

  if (seg === 'sac') {
    const backpack = /à dos|dos –|backpack/i.test(p.name)
    return {
      subtitle_fr: backpack
        ? `Grand sac à dos ${sacColor(p.name)} — spacieux, résistant, usage quotidien`
        : `Sac ${p.name.toLowerCase().includes('cabas') ? 'cabas' : 'à main'} artisanal en wax et cuir — fait main`,
      subtitle_en: backpack
        ? `Large ${sacColorEN(p.name)} backpack — roomy, hard-wearing, daily use`
        : `Handcrafted wax-and-leather ${p.name.toLowerCase().includes('cabas') ? 'tote' : 'handbag'}`,
      description_fr: mkDesc([
        backpack
          ? `${p.name} : grand sac à dos spacieux et résistant, pour un usage quotidien ou en déplacement. Compartiment principal large, bretelles réglables.`
          : salvage || `Sac fabriqué à la main en pagne wax et finitions cuir. Structure qui garde sa forme, intérieur doublé.`,
        backpack ? null : `Pièce artisanale : le placement du motif wax varie d'un sac à l'autre.`,
        `Entretien : nettoyer les taches au chiffon humide sans détremper, protéger le cuir de la pluie, ranger à plat.`,
      ]),
      description_en: mkDesc([
        backpack
          ? `${p.name}: a large, roomy and hard-wearing backpack for daily use or travel. Wide main compartment, adjustable straps.`
          : `A handmade bag in wax print with leather trim. A structure that holds its shape, lined interior. Handcrafted: wax-print placement varies from bag to bag.`,
        `Care: spot-clean with a damp cloth without soaking, protect the leather from rain, store flat.`,
      ]),
      tags: backpack
        ? ['sac à dos', 'sac à dos femme', 'grand sac', 'sac quotidien', 'maroquinerie', 'ALL store']
        : ['sac', 'sac wax', 'sac artisanal', 'sac cuir', 'sac à main', 'maroquinerie', 'fait main', 'ALL store'],
      specifications: backpack
        ? [
            { k: 'Type', v: 'Sac à dos grande capacité' },
            { k: 'Coloris', v: sacColor(p.name) },
            { k: 'Bretelles', v: 'Réglables' },
            { k: 'Usage', v: 'Quotidien, déplacements' },
            { k: 'Entretien', v: 'Chiffon humide en surface, séchage à plat' },
          ]
        : [
            { k: 'Type', v: p.name.toLowerCase().includes('cabas') ? 'Sac cabas' : 'Sac à main' },
            { k: 'Matière', v: 'Pagne wax + finitions cuir' },
            { k: 'Structure', v: 'Rigide, garde sa forme' },
            { k: 'Intérieur', v: 'Doublé' },
            { k: 'Fabrication', v: 'Faite main' },
            { k: 'Entretien', v: 'Chiffon humide en surface, protéger le cuir de la pluie' },
          ],
    }
  }

  if (seg === 'bijou') {
    return {
      subtitle_fr: `Sélection bijoux et accessoires mode — plusieurs modèles`,
      subtitle_en: `Jewellery and fashion accessories — several models`,
      description_fr: mkDesc([
        salvage || `Sélection d'accessoires mode et de bijoux pour compléter un look. Plusieurs modèles disponibles ci-dessous.`,
        `Choisissez le modèle dans la liste. Bijoux fantaisie : éviter le contact prolongé avec l'eau et les parfums.`,
      ]),
      description_en: mkDesc([
        `A selection of fashion accessories and jewellery to finish a look. Several models available below.`,
        `Pick the model from the list. Costume jewellery: avoid prolonged contact with water and perfume.`,
      ]),
      tags: ['bijou', 'accessoire mode', 'bijoux fantaisie', 'accessoire femme', 'ALL store'],
      specifications: [
        { k: 'Type', v: 'Bijoux / accessoires mode' },
        { k: 'Choix', v: 'Plusieurs modèles (voir liste)' },
        { k: 'Entretien', v: 'Éviter eau et parfum prolongés' },
      ],
    }
  }

  if (seg === 'vetement') {
    return {
      subtitle_fr: `Vêtements en style africain contemporain — ensembles, robes, shorts`,
      subtitle_en: `Contemporary African-style clothing — sets, dresses, shorts`,
      description_fr: mkDesc([
        salvage || `Sélection de vêtements confectionnés avec soin, alliant confort et style africain contemporain.`,
        `Choisissez le modèle et la taille dans la liste (S à 3XL selon le modèle). Ensembles Ankara 3 pièces, robes et shorts.`,
        `Entretien : lavage à 30 °C sur l'envers, séchage à l'ombre.`,
      ]),
      description_en: mkDesc([
        `A selection of carefully made garments combining comfort with contemporary African style.`,
        `Pick the model and size from the list (S to 3XL depending on the model). 3-piece Ankara sets, dresses and shorts.`,
        `Care: wash at 30 °C inside out, dry in the shade.`,
      ]),
      tags: ['vêtements', 'mode africaine', 'ensemble ankara', 'robe', 'style africain', 'ALL store'],
      specifications: [
        { k: 'Type', v: 'Vêtements (ensembles, robes, shorts)' },
        { k: 'Style', v: 'Africain contemporain' },
        { k: 'Tailles', v: 'S à 3XL selon le modèle' },
        { k: 'Entretien', v: "Lavage 30 °C sur l'envers, séchage à l'ombre" },
      ],
    }
  }

  // generic — dernier recours
  return {
    subtitle_fr: `${p.name} — pièce artisanale`,
    subtitle_en: `${p.name} — a handcrafted item`,
    description_fr: mkDesc([
      salvage || `${p.name}. Pièce proposée par ALL store.`,
      `Contactez la boutique pour toute précision sur les matières, dimensions ou l'entretien.`,
    ]),
    description_en: mkDesc([
      `${p.name}. Item offered by ALL store.`,
      `Contact the shop for details on materials, dimensions or care.`,
    ]),
    tags: ['artisanat', 'ALL store'],
    specifications: [
      { k: 'Vendu par', v: 'ALL store' },
      { k: 'Type', v: p.name },
    ],
  }
}

function sacColor(name) {
  const t = name.toLowerCase()
  if (/blanc.*noir|noir.*blanc/.test(t)) return 'Blanc et noir'
  if (/noir/.test(t)) return 'Noir'
  if (/blanc/.test(t)) return 'Blanc'
  return 'Voir photo'
}
const sacColorEN = (n) => sacColor(n).replace('Blanc et noir', 'white and black').replace('Noir', 'black').replace('Blanc', 'white').replace('Voir photo', 'as shown')

// ---- assemblage ---
const out = {}
const counts = {}
for (const p of pull) {
  if (SKIP_IDS.has(p.id)) {
    counts.skipped = (counts.skipped || 0) + 1
    continue
  }
  const seg = segment(p)
  if (seg === 'skip') {
    counts.skipped = (counts.skipped || 0) + 1
    continue
  }
  out[p.id] = build(p)
  counts[seg] = (counts[seg] || 0) + 1
}
writeFileSync(join(HERE, '66.content.json'), JSON.stringify(out, null, 2))
console.log(`66.content.json écrit — ${Object.keys(out).length} produits (${counts.skipped || 0} ignorés)`)
console.log('Par segment :', counts)

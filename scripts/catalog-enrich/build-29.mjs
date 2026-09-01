// build-29.mjs — génère 29.content.json (MALAÏKA'S HOUSE, Yaoundé, CM).
//
// La rédaction (accroches, structure des descriptions, specs, tags) est
// écrite ici à la main, par famille de produit. Le script remplit, pour
// chaque produit, son détail visuel réel (couleur/motif, déjà présent
// dans la fiche d'origine) dans ces gabarits, pour que les 116 fiches
// soient cohérentes sans être 116 copier-coller manuels.
//
// Choix assumés :
//   - EN : on n'auto-traduit PAS la phrase de détail française (vocabulaire
//     couleur/motif trop piégeux) — la version EN décrit le motif de façon
//     générique et fidèle ("a hand-beaded central medallion", etc.).
//   - Babouches : pointures annoncées "37 à 43" d'après la description
//     d'origine du vendeur (certaines lignes de variation en base portent
//     29–35, visiblement une erreur d'un ancien backfill — à corriger via
//     la page Maintenance variations, pas ici).
//   - Coloris : seuls les vrais mots de couleur des variations sont repris ;
//     les paliers "1 pièce / Gros - 5+ / 1 Ensemble" sont ignorés.
//
//   node scripts/catalog-enrich/build-29.mjs
//   -> scripts/catalog-enrich/29.content.json
//   puis : node scripts/enrich-catalog.mjs apply 29 --dry-run

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const pull = JSON.parse(readFileSync(join(HERE, '29.pull.json'), 'utf8'))

// ---- helpers ------------------------------------------------------
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

const stripTags = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[✨👌🏽🥰❌💯🔥😍💥⭐️👜👝🛍️]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()

// Dernière phrase descriptive de la fiche d'origine = le détail visuel.
function minedDetail(desc) {
  const parts = [...String(desc).matchAll(/<p>([\s\S]*?)<\/p>/g)]
    .map((m) => stripTags(m[1]))
    .filter(Boolean)
  return parts[parts.length - 1] || ''
}

const suffix = (name) => (name.split('—')[1] || '').trim()
const family = (name) => name.split('—')[0].trim().toUpperCase().replace(/\s+/g, ' ')

// Détail visuel miné, rendu comme une PHRASE NOMINALE autonome (pas
// grafté derrière un verbe — trop de pièges d'accord). On l'utilise tel
// quel dans une ligne "Coloris et motif : …". Juste un nettoyage léger.
// Détails "filler" génériques (fiche d'origine sans info visuelle réelle) —
// dans ce cas on ne met PAS de ligne "Coloris et motif".
const FILLER_DETAIL = /qualit[eé] premium|produit artisanal|pi[eè]ce artisanale unique|design [eé]l[eé]gant|finitions?|mat[eé]riau/i

const lc = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s)
// Assemble une description : ignore les lignes null, comprime les doubles
// sauts créés par une section omise.
const mkDesc = (lines) =>
  lines
    .filter((l) => l !== null && l !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')

function detailClauseFR(d, kind) {
  let c = String(d).trim().replace(/\s+/g, ' ').replace(/\.$/, '')
  c = c.replace(/^Sandale en cuir,?\s*/i, '')
  // enlève le nom d'objet en tête ("Pochette grise…" -> "grise…",
  // "Base sable…" -> "sable…") : redondant dans "Coloris et motif : …".
  c = c.replace(/^(Pochette|Sandale|Base|Sac(?: à main artisanal)?(?: en denim)?)[,\s]+/i, '')
  if (kind === 'set') {
    c = c
      .split(/\s+[—–-]\s+|\s*,\s*(?:ensemble|sac\s*\+|pochette assortie|perles artisanales|ornement perlé)/i)[0]
      .trim()
  }
  if (!c || FILLER_DETAIL.test(c)) return '' // pas de détail exploitable
  return c.charAt(0).toUpperCase() + c.slice(1)
}

// Coloris réels (allowlist) parmi les labels de variation.
const COLOR_WORDS = new Set([
  'beige', 'blanc', 'blanche', 'bleu', 'bleue', 'jaune', 'marron', 'noir', 'noire',
  'orange', 'rouge', 'vert', 'verte', 'rose', 'violet', 'gris', 'grise', 'or', 'doré',
  'multicouleur1', 'multicouleur6', 'multicolore', 'multicouleur',
])
function realColors(labels) {
  const out = []
  for (const l of labels || []) {
    const t = String(l).trim().toLowerCase()
    if (COLOR_WORDS.has(t)) {
      out.push(t === 'multicouleur1' ? 'multicolore (motif 1)' : t === 'multicouleur6' ? 'multicolore (motif 6)' : t)
    }
  }
  return [...new Set(out)]
}

// ---- gabarits par famille --------------------------------------
function babouche({ detailFR, suffixLabel }) {
  const SIZES = '37 à 43'
  const detailLower = lc(detailFR)
  return {
    subtitle_fr: detailLower
      ? `Babouche en cuir véritable — ${detailLower}, cousue et perlée main`
      : `Babouche en cuir véritable, cousue et perlée main`,
    subtitle_en: `Genuine leather slipper with a hand-beaded strap — stitched and beaded by hand`,
    description_fr: mkDesc([
      `Cette babouche est taillée dans un cuir véritable pleine fleur, choisi pour sa souplesse et sa tenue dans le temps. Le dessus est entièrement brodé de perles à la main dans l'atelier de MALAÏKA'S HOUSE, à Yaoundé.`,
      ``,
      detailLower ? `Coloris et motif : ${detailLower}.` : null,
      detailLower ? `` : null,
      `Chaque paire est montée par un artisan : la perle est enfilée une à une puis fixée sur la lanière, ce qui explique les légères différences d'un exemplaire à l'autre — la marque d'un vrai travail fait main, pas d'une production en série.`,
      ``,
      `La semelle intérieure est rembourrée et recouverte de cuir ; elle épouse le pied et reste confortable sur une journée entière. La semelle extérieure, souple et antidérapante, convient à un usage urbain.`,
      ``,
      `À porter avec un jean, une robe longue, un boubou ou une tenue de cérémonie. Pointures disponibles : ${SIZES}. Si vous hésitez entre deux tailles, prenez la plus grande — la babouche se détend légèrement à l'usage.`,
      ``,
      `Entretien : essuyer avec un chiffon doux légèrement humide, laisser sécher à l'air libre, éviter l'exposition prolongée au soleil et le contact avec l'eau. Ne pas mettre en machine.`,
    ]),
    description_en: [
      `This slipper is cut from genuine full-grain leather, chosen for its suppleness and durability. The strap is hand-beaded throughout in the MALAÏKA'S HOUSE workshop in Yaoundé, Cameroon${suffixLabel ? ` (pattern: ${suffixLabel.toLowerCase()})` : ''}.`,
      ``,
      `Every pair is assembled by a single craftsperson: each bead is threaded and secured onto the strap by hand, which is why pairs differ slightly from one another — the sign of genuine handwork rather than mass production.`,
      ``,
      `The insole is padded and leather-lined; it moulds to the foot and stays comfortable all day. The outsole is flexible and non-slip, suited to city wear.`,
      ``,
      `Wears well with jeans, a long dress, a boubou or formal attire. Available sizes: EU 37 to 43. If you are between sizes, take the larger one — the slipper relaxes slightly with wear.`,
      ``,
      `Care: wipe with a soft, slightly damp cloth, air-dry, avoid prolonged sun exposure and contact with water. Do not machine wash.`,
    ].join('\n'),
    tags: ['babouche', 'babouche cuir', 'sandale cuir', 'chaussure artisanale', 'cuir véritable', 'perlé main', 'fait main', 'Cameroun', 'MALAÏKA', 'mule cuir', 'sandale perlée'],
    specifications: [
      { k: 'Type', v: 'Babouche / mule ouverte' },
      { k: 'Matière dessus', v: 'Cuir véritable pleine fleur' },
      { k: 'Semelle intérieure', v: 'Cuir sur mousse de confort' },
      { k: 'Semelle extérieure', v: 'Souple, antidérapante' },
      { k: 'Ornement', v: 'Perles brodées et cousues main' },
      detailFR ? { k: 'Motif', v: capFirst(detailFR) } : null,
      { k: 'Pointures', v: 'EU 37 à 43' },
      { k: 'Fabrication', v: 'Faite main à Yaoundé, Cameroun' },
      { k: 'Entretien', v: "Chiffon doux humide, séchage à l'air, tenir à l'écart de l'eau" },
    ].filter(Boolean),
  }
}

function pochette({ detailFR }) {
  const detailLower = lc(detailFR)
  return {
    subtitle_fr: detailLower
      ? `Pochette de soirée à médaillon perlé — ${detailLower}`
      : `Pochette de soirée à médaillon perlé, structure rigide et chaînette`,
    subtitle_en: `Beaded evening clutch with a hand-worked central medallion`,
    description_fr: mkDesc([
      `Pochette de la ligne SUPER PREMIUM de MALAÏKA'S HOUSE, avec un médaillon central en perles brodées main qui capte la lumière.`,
      ``,
      detailLower ? `Coloris et motif : ${detailLower}.` : null,
      detailLower ? `` : null,
      `La structure est rigide et garde sa forme une fois fermée. L'intérieur est doublé et comporte une petite poche plate. Fermeture par rabat aimanté. Livrée avec une chaînette amovible pour la porter à l'épaule ou en travers.`,
      ``,
      `Format pensé pour l'essentiel d'une sortie : téléphone, cartes, clés, rouge à lèvres. Se marie avec une tenue de cérémonie, un ensemble en pagne ou une robe unie pour un contraste net.`,
      ``,
      `Chaque pièce est assemblée main : le médaillon perlé peut varier très légèrement d'un exemplaire à l'autre. Entretien : dépoussiérer avec un chiffon sec, ranger à plat dans la housse, éviter l'humidité.`,
    ]),
    description_en: [
      `A clutch from the MALAÏKA'S HOUSE SUPER PREMIUM line. The body carries a central hand-beaded medallion that catches the light.`,
      ``,
      `The frame is rigid and holds its shape when closed. The interior is lined with a small flat pocket. Magnetic flap closure. Supplied with a removable chain to carry it over the shoulder or crossbody.`,
      ``,
      `Sized for a night out's essentials: phone, cards, keys, lipstick. Pairs with formal wear, a wax-print co-ord or a plain dress for sharp contrast.`,
      ``,
      `Each piece is hand-assembled: the beaded medallion may vary very slightly between items. Care: dust with a dry cloth, store flat in the dust bag, keep away from moisture.`,
    ].join('\n'),
    tags: ['pochette', 'pochette soirée', 'clutch', 'pochette perlée', 'sac de soirée', 'ornement perlé', 'fait main', 'Cameroun', 'MALAÏKA', 'accessoire cérémonie', 'pochette chaînette'],
    specifications: [
      { k: 'Type', v: 'Pochette de soirée (clutch) à structure rigide' },
      { k: 'Fermeture', v: 'Rabat aimanté' },
      { k: 'Bandoulière', v: 'Chaînette amovible fournie' },
      { k: 'Intérieur', v: 'Doublé, une poche plate' },
      { k: 'Ornement', v: 'Médaillon en perles brodées main' },
      detailFR ? { k: 'Aspect', v: capFirst(detailFR) } : null,
      { k: 'Contenance', v: 'Téléphone, cartes, clés, petits objets' },
      { k: 'Fabrication', v: 'Faite main à Yaoundé, Cameroun' },
      { k: 'Entretien', v: "Chiffon sec, rangement à plat, éviter l'humidité" },
    ].filter(Boolean),
  }
}

function vipBag({ detailFR, xl }) {
  const cap = xl
    ? "Format XL : contient un ordinateur portable, un cahier A4, une trousse et les affaires d'une journée."
    : "Format moyen : contient un portefeuille, une tablette, une bouteille d'eau et les affaires courantes."
  const capEN = xl
    ? "XL size: fits a laptop, an A4 notebook, a pouch and a day's belongings."
    : "Medium size: fits a wallet, a tablet, a water bottle and everyday belongings."
  const detailLower = lc(detailFR)
  return {
    subtitle_fr: detailLower
      ? `Sac ${xl ? 'cabas XL' : 'porté épaule'} tissé main — ${detailLower}`
      : `Sac ${xl ? 'cabas XL' : 'porté épaule'} tissé main, médaillon perlé signature`,
    subtitle_en: `Hand-woven ${xl ? 'XL tote' : 'shoulder'} bag with a beaded central medallion`,
    description_fr: mkDesc([
      `Sac de la ligne VIP ORIGINAL de MALAÏKA'S HOUSE${xl ? ', version XL' : ''}. Le corps est tissé à la main et reçoit un médaillon central en perles brodées qui signe la maison.`,
      ``,
      detailLower ? `Coloris et motif : ${detailLower}.` : null,
      detailLower ? `` : null,
      `Anses assez longues pour un porté épaule. Ouverture large sur un intérieur doublé avec une poche zippée. La base est renforcée pour que le sac tienne debout une fois posé.`,
      ``,
      `${cap}`,
      ``,
      `Pièce artisanale : le tissage et le médaillon perlé varient légèrement d'un sac à l'autre. Entretien : brosser doucement, nettoyer les taches au chiffon humide sans détremper, sécher à plat loin d'une source de chaleur.`,
    ]),
    description_en: [
      `A bag from the MALAÏKA'S HOUSE VIP ORIGINAL line${xl ? ', XL version' : ''}. The body is hand-woven and carries a central hand-beaded medallion that is the house signature.`,
      ``,
      `Straps long enough for shoulder carry. Wide opening onto a lined interior with a zipped pocket. The base is reinforced so the bag stands upright when set down.`,
      ``,
      `${capEN}`,
      ``,
      `A handcrafted piece: the weave and the beaded medallion vary slightly from bag to bag. Care: brush gently, spot-clean with a damp cloth without soaking, dry flat away from heat.`,
    ].join('\n'),
    tags: ['sac', xl ? 'cabas' : 'sac épaule', 'sac tissé', 'sac perlé', 'sac artisanal', xl ? 'grand sac' : 'sac femme', 'ornement perlé', 'fait main', 'Cameroun', 'MALAÏKA', 'sac wax'],
    specifications: [
      { k: 'Type', v: xl ? 'Grand cabas porté épaule' : 'Sac porté épaule' },
      { k: 'Corps', v: 'Tissé main' },
      { k: 'Base', v: 'Renforcée, tient debout' },
      { k: 'Intérieur', v: 'Doublé, une poche zippée' },
      { k: 'Ornement', v: 'Médaillon en perles brodées main' },
      detailFR ? { k: 'Aspect', v: capFirst(detailFR) } : null,
      { k: 'Contenance', v: xl ? 'Ordinateur portable, format A4, affaires du jour' : 'Portefeuille, tablette, affaires courantes' },
      { k: 'Fabrication', v: 'Faite main à Yaoundé, Cameroun' },
      { k: 'Entretien', v: 'Brossage doux, nettoyage local au chiffon humide, séchage à plat' },
    ].filter(Boolean),
  }
}

function sacPochetteVIP({ detailFR }) {
  // detailFR arrive déjà tronqué à la partie tissu (kind:'set') ; on en
  // fait un fragment propre pour le sous-titre et la spec.
  const fabric = detailFR
    .replace(/^un\s+/i, '')
    .replace(/[.,]$/, '')
    .replace(/\s*[—–-]\s*anse en bois.*$/i, '')
    .trim()
  const fabricLower = lc(fabric)
  return {
    subtitle_fr: fabricLower
      ? `Ensemble sac + pochette assortis — ${fabricLower}, anse en bois naturel`
      : `Ensemble sac + pochette assortis, tissu africain, anse en bois naturel`,
    subtitle_en: `Matching bag + clutch set with a natural-wood handle`,
    description_fr: mkDesc([
      `Ensemble deux pièces de MALAÏKA'S HOUSE : un sac à main et sa pochette assortie, taillés dans le même tissu.`,
      ``,
      fabricLower ? `Tissu et motif : ${fabricLower}.` : null,
      fabricLower ? `` : null,
      `Le sac a une anse rigide en bois naturel et un ornement en perles brodées main. La pochette reprend le tissu et le travail de perles, avec une fermeture éclair ; elle se glisse dans le sac ou se porte seule.`,
      ``,
      `Intérieur doublé pour les deux pièces. L'ensemble accompagne aussi bien une tenue de tous les jours qu'une cérémonie.`,
      ``,
      `Pièces artisanales : tissu positionné à la coupe, motif et perles variant légèrement d'un ensemble à l'autre. Entretien : chiffon humide en surface, séchage à plat, tenir le bois à l'écart de l'eau.`,
    ]),
    description_en: mkDesc([
      `A two-piece set from MALAÏKA'S HOUSE: a handbag and its matching clutch, cut from the same African fabric.`,
      ``,
      `The bag has a rigid natural-wood handle and a hand-beaded ornament. The clutch echoes the fabric and beadwork, with a zip closure; it tucks inside the bag or is carried on its own.`,
      ``,
      `Both pieces are lined. The set suits both everyday wear and formal occasions.`,
      ``,
      `Handcrafted pieces: fabric placed at cutting, pattern and beads vary slightly between sets. Care: surface-clean with a damp cloth, dry flat, keep the wood away from water.`,
    ]),
    tags: ['ensemble sac pochette', 'sac et pochette', 'set assorti', 'sac wax', 'sac kente', 'anse bois', 'ornement perlé', 'fait main', 'Cameroun', 'MALAÏKA', 'sac cérémonie'],
    specifications: [
      { k: 'Composition', v: 'Sac à main + pochette assortie' },
      { k: 'Anse du sac', v: 'Bois naturel, rigide' },
      { k: 'Fermeture pochette', v: 'Fermeture éclair' },
      fabric ? { k: 'Tissu', v: capFirst(fabric) } : null,
      { k: 'Ornement', v: 'Perles brodées main' },
      { k: 'Intérieur', v: 'Doublé (les deux pièces)' },
      { k: 'Fabrication', v: 'Faite main à Yaoundé, Cameroun' },
      { k: 'Entretien', v: "Chiffon humide en surface, séchage à plat, bois à l'écart de l'eau" },
    ].filter(Boolean),
  }
}

// Les 6 "Sac en perle" ont chacun un caractère distinct — rédaction à la
// main, indexée par id, plutôt qu'un gabarit générique.
const PERLE_COPY = {
  488: {
    color: 'fuchsia',
    hookFR:
      `Intense et lumineux, ce sac en perles fuchsia est fait pour celles qui assument un style éclatant. Le fuchsia profond est monté en motifs géométriques par des mains expertes ; chaque perle est placée avec soin pour un rendu net et régulier.`,
    useFR:
      `Il réveille instantanément une tenue, du look de jour à la tenue de fête. Format compact, fermeture sécurisée.`,
    hookEN:
      `Intense and luminous, this fuchsia beaded bag is for anyone who owns a bold look. The deep fuchsia is set in geometric motifs by expert hands, each bead placed for a clean, even finish.`,
    useEN: `It lifts an outfit instantly, from daywear to party wear. Compact size, secure closure.`,
  },
  489: {
    color: 'vert (forme cœur)',
    hookFR:
      `Création originale : ce sac en perles vertes prend la forme d'un cœur. Chaque perle est assemblée pour dessiner fidèlement cette silhouette, à la fois romantique et facile à reconnaître.`,
    useFR:
      `Malgré sa forme, il reste fonctionnel : l'intérieur accueille vos essentiels, la fermeture sécurisée protège vos affaires, l'anse assure un port confortable.`,
    hookEN:
      `An original design: this green beaded bag is shaped like a heart. Each bead is assembled to trace that silhouette faithfully — romantic and instantly recognisable.`,
    useEN:
      `Despite the shape it stays practical: the interior holds your essentials, the secure closure protects them, the strap carries comfortably.`,
  },
  490: {
    color: 'rose',
    hookFR:
      `Féminin et romantique, ce sac en perles rose est une pièce douce et affirmée. Le soin de l'artisan se lit dans la régularité du tissage et la précision des motifs ; les nuances de rose créent un effet de relief qui rend chaque sac unique.`,
    useFR: `Il se porte avec une tenue casual comme avec une tenue habillée, pour une soirée ou un événement.`,
    hookEN:
      `Feminine and romantic, this pink beaded bag is a soft but assured piece. The maker's care shows in the even weave and precise motifs; shades of pink give a relief effect that makes each bag unique.`,
    useEN: `Wears with casual or dressy outfits, for an evening or a special event.`,
  },
  491: {
    color: 'marron et or',
    hookFR:
      `Pièce maîtresse de la collection, ce sac en perles marron et or se distingue par son format généreux et la densité de son tissage. Les tons chauds du marron et les reflets dorés lui donnent un aspect luxueux et intemporel.`,
    useFR:
      `Grande capacité intérieure doublée d'un tissu souple. Anses doubles : porté main ou porté épaule au choix.`,
    hookEN:
      `The collection's centrepiece: this brown-and-gold beaded bag stands out for its generous size and dense weave. Warm browns and gold highlights give it a luxurious, timeless look.`,
    useEN:
      `Large lined interior in a supple fabric. Double straps: carry by hand or on the shoulder.`,
  },
  492: {
    color: 'vert',
    hookFR:
      `Ce sac en perles à dominante verte est une explosion de couleurs et de savoir-faire. Chaque perle est placée pour composer un motif harmonieux ; les verts, associés à des perles complémentaires, lui donnent un caractère festif et lumineux.`,
    useFR:
      `Léger et facile à porter, il s'adapte aux tenues de jour comme aux sorties du soir. Taille compacte, doublure intérieure protectrice.`,
    hookEN:
      `This predominantly green beaded bag is a burst of colour and craft. Each bead is placed to build a balanced motif; greens with complementary beads give it a festive, luminous character.`,
    useEN:
      `Light and easy to carry, it works for daywear and evening outings alike. Compact size, protective lining.`,
  },
  493: {
    color: 'noir et or',
    hookFR:
      `Réalisé entièrement à la main, ce sac en perles noires et dorées est une pièce d'exception. Chaque perle est enfilée selon une technique traditionnelle qui garantit la solidité et la régularité du motif. Le noir et l'or lui donnent un caractère élégant et sobre.`,
    useFR:
      `Idéal pour les soirées, mariages et sorties chic. La structure interne rigide maintient la forme, la doublure protège vos affaires.`,
    hookEN:
      `Made entirely by hand, this black-and-gold beaded bag is an exceptional piece. Each bead is threaded using a traditional technique that keeps the motif strong and even. Black and gold give it an elegant, understated character.`,
    useEN:
      `Ideal for evenings, weddings and dressy outings. The rigid internal frame holds the shape; the lining protects your belongings.`,
  },
}

function sacPerle({ id, name }) {
  const meta = PERLE_COPY[id] || { color: name.replace(/^Sac en perle\s*/i, '').trim() || 'multicolore' }
  const color = meta.color
  return {
    subtitle_fr: `Sac en perles tissées main, ${color} — pièce unique`,
    subtitle_en: `Hand-woven all-bead bag — one-off piece`,
    description_fr: mkDesc([
      meta.hookFR ||
        `Sac entièrement réalisé en perles tissées et assemblées à la main par MALAÏKA'S HOUSE, dans une dominante ${color}.`,
      ``,
      meta.useFR || null,
      meta.useFR ? `` : null,
      `Chaque sac est une pièce unique : le tissage de perles ne se reproduit jamais exactement à l'identique.`,
      ``,
      `Entretien : dépoussiérer au chiffon sec, ne pas immerger, éviter l'humidité prolongée, ranger à plat à l'abri des chocs.`,
    ]),
    description_en: mkDesc([
      meta.hookEN ||
        `A bag made entirely of beads, hand-woven and assembled by MALAÏKA'S HOUSE.`,
      ``,
      meta.useEN || null,
      meta.useEN ? `` : null,
      `Each bag is a one-off piece: the beadwork is never reproduced exactly.`,
      ``,
      `Care: dust with a dry cloth, do not immerse, avoid prolonged moisture, store flat away from knocks.`,
    ]),
    tags: ['sac en perle', 'sac perlé', 'sac soirée', 'pochette perlée', 'pièce unique', 'perles tissées', 'fait main', 'Cameroun', 'MALAÏKA', 'sac mariage'],
    specifications: [
      { k: 'Type', v: 'Sac en perles, porté main' },
      { k: 'Matière', v: 'Perles tissées et assemblées main' },
      { k: 'Structure', v: 'Cadre interne rigide' },
      { k: 'Fermeture', v: 'Sécurisée, sur le dessus' },
      { k: 'Dominante', v: capFirst(color) },
      { k: 'Unicité', v: 'Pièce unique — tissage non reproductible' },
      { k: 'Fabrication', v: 'Faite main à Yaoundé, Cameroun' },
      { k: 'Entretien', v: 'Chiffon sec, ne pas immerger, rangement à plat' },
    ],
  }
}
const EN_COLOR = {
  fuchsia: 'fuchsia', rose: 'pink', 'vert coeur': 'green', vert: 'green', verte: 'green',
  marron: 'brown', noir: 'black', noire: 'black', bleu: 'blue', bleue: 'blue', jaune: 'yellow',
  orange: 'orange', beige: 'beige', blanc: 'white', blanche: 'white', gris: 'grey', grise: 'grey',
  rouge: 'red', violet: 'purple', multicolore: 'multicoloured',
  'multicolore (motif 1)': 'multicoloured (pattern 1)', 'multicolore (motif 6)': 'multicoloured (pattern 6)',
}
const toEnColor = (c) => EN_COLOR[String(c).toLowerCase()] || String(c).toLowerCase()

function ensembleVIP({ colors }) {
  const colorLine = colors.length ? `Coloris proposés : ${colors.join(', ')}.` : ''
  const colorLineEN = colors.length ? `Available colours: ${colors.map(toEnColor).join(', ')}.` : ''
  return {
    subtitle_fr: `Ensemble sac + pochette coordonnés, finition premium`,
    subtitle_en: `Coordinated bag + clutch set, premium finish`,
    description_fr: mkDesc([
      `Ensemble deux pièces de MALAÏKA'S HOUSE : un sac à main et une pochette coordonnée, réalisés à la main dans des matériaux haut de gamme selon des techniques d'atelier traditionnelles.`,
      ``,
      `Le sac offre une contenance pour un usage quotidien ou une sortie ; la pochette assortie se porte séparément ou se range à l'intérieur. Finitions soignées, structure qui tient dans le temps.`,
      ``,
      colorLine || null,
      colorLine ? `` : null,
      `Convient pour les cérémonies, les sorties habillées et les occasions où l'ensemble compte autant que la tenue. Idéal aussi comme cadeau.`,
      ``,
      `Entretien : nettoyer en surface au chiffon doux, séchage à plat, éviter l'humidité prolongée.`,
    ]),
    description_en: mkDesc([
      `A two-piece set from MALAÏKA'S HOUSE: a handbag and a coordinated clutch, handmade in premium materials using traditional workshop techniques.`,
      ``,
      `The bag holds enough for daily use or an outing; the matching clutch is carried separately or stored inside. Careful finishing, a structure that lasts.`,
      ``,
      colorLineEN || null,
      colorLineEN ? `` : null,
      `Suited to ceremonies, dressy outings and occasions where the set matters as much as the outfit. Also makes a strong gift.`,
      ``,
      `Care: surface-clean with a soft cloth, dry flat, avoid prolonged moisture.`,
    ]),
    tags: ['ensemble sac pochette', 'set sac et pochette', 'sac coordonné', 'sac premium', 'pochette assortie', 'fait main', 'Cameroun', 'MALAÏKA', 'sac cérémonie', 'cadeau femme'],
    specifications: [
      { k: 'Composition', v: 'Sac à main + pochette coordonnée' },
      { k: 'Fabrication', v: 'Faite main, matériaux haut de gamme' },
      colors.length ? { k: 'Coloris', v: colors.join(', ') } : null,
      { k: 'Usage', v: 'Quotidien habillé, cérémonies, sorties' },
      { k: 'Origine', v: 'Yaoundé, Cameroun' },
      { k: 'Entretien', v: "Chiffon doux en surface, séchage à plat, éviter l'humidité" },
    ].filter(Boolean),
  }
}

function sacMainSimple() {
  return {
    subtitle_fr: `Sac à main artisanal, format pratique pour tous les jours`,
    subtitle_en: `Handcrafted handbag, practical everyday size`,
    description_fr: [
      `Sac à main réalisé à la main par MALAÏKA'S HOUSE dans des matériaux haut de gamme, selon des techniques d'atelier traditionnelles. Chaque pièce est un peu différente : c'est la marque d'un objet fabriqué à l'unité et non à la chaîne.`,
      ``,
      `Format polyvalent qui contient l'essentiel d'une journée. Anse confortable pour un porté main ou épaule. Finitions soignées, intérieur fonctionnel.`,
      ``,
      `À l'aise au quotidien comme pour une sortie shopping ou un rendez-vous. Se glisse aussi bien dans un usage féminin que mixte.`,
      ``,
      `Entretien : nettoyer en surface au chiffon doux légèrement humide, sécher à plat, tenir à l'écart d'une source de chaleur directe.`,
    ].join('\n'),
    description_en: [
      `A handbag handmade by MALAÏKA'S HOUSE in premium materials, using traditional workshop techniques. Each piece is slightly different — the mark of an item made one at a time rather than on a line.`,
      ``,
      `A versatile size that holds a day's essentials. Comfortable strap for hand or shoulder carry. Careful finishing, a functional interior.`,
      ``,
      `At ease day to day as much as for a shopping trip or a meeting. Suits both women's and unisex use.`,
      ``,
      `Care: surface-clean with a soft, slightly damp cloth, dry flat, keep away from direct heat.`,
    ].join('\n'),
    tags: ['sac à main', 'sac artisanal', 'sac femme', 'sac quotidien', 'sac fait main', 'accessoire mode', 'Cameroun', 'MALAÏKA', 'cadeau', 'sac polyvalent'],
    specifications: [
      { k: 'Type', v: 'Sac à main, porté main ou épaule' },
      { k: 'Fabrication', v: 'Faite main, matériaux haut de gamme' },
      { k: 'Usage', v: 'Quotidien, shopping, rendez-vous' },
      { k: 'Intérieur', v: 'Fonctionnel, contient les affaires du jour' },
      { k: 'Origine', v: 'Yaoundé, Cameroun' },
      { k: 'Entretien', v: 'Chiffon doux humide en surface, séchage à plat' },
    ],
  }
}

// ---- assemblage --------------------------------------------------
const out = {}
const counts = {}

for (const p of pull) {
  const fam = family(p.name)
  const mined = minedDetail(p.current_description)
  const colors = realColors(p.variation_labels)

  let c
  if (fam === 'BABOUCHES CUIR' || fam === 'BABOUCHE EN CUIR') {
    c = babouche({ detailFR: detailClauseFR(mined, 'babouche'), suffixLabel: suffix(p.name) })
  } else if (fam === 'POCHETTE SUPER PREMIUM') {
    c = pochette({ detailFR: detailClauseFR(mined, 'sac') })
  } else if (fam === 'VIP ORIGINAL BAG XL') {
    c = vipBag({ detailFR: detailClauseFR(mined, 'sac'), xl: true })
  } else if (fam === 'VIP ORIGINAL BAG') {
    c = vipBag({ detailFR: detailClauseFR(mined, 'sac'), xl: false })
  } else if (fam === 'SAC+POCHETTE VIP') {
    c = sacPochetteVIP({ detailFR: detailClauseFR(mined, 'set') })
  } else if (fam.startsWith('SAC EN PERLE')) {
    c = sacPerle({ id: p.id, name: p.name })
  } else if (/^ENSEMBLE (SAC|VIP)/.test(fam)) {
    c = ensembleVIP({ colors })
  } else {
    c = sacMainSimple()
  }
  counts[fam] = (counts[fam] || 0) + 1
  out[p.id] = c
}

writeFileSync(join(HERE, '29.content.json'), JSON.stringify(out, null, 2))
console.log(`29.content.json écrit — ${Object.keys(out).length} produits`)
console.log('Par famille :', counts)

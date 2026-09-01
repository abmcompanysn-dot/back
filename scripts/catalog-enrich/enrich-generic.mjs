// enrich-generic.mjs — moteur d'enrichissement générique pour toutes les
// boutiques restantes. Classe chaque produit par catégorie + mots-clés du
// nom, garde la description d'origine si elle est correcte, ajoute la
// structure manquante (usage, entretien), rédige sous-titre + specs + tags
// FR/EN. specs en source:'vendor'.
//
//   node scripts/catalog-enrich/enrich-generic.mjs <vendorId>
//     -> écrit scripts/catalog-enrich/<vendorId>.content.json
//        (à partir de <vendorId>.pull.json, produit par `enrich-catalog.mjs pull`)
//
//   node scripts/catalog-enrich/enrich-generic.mjs --all
//     -> pull + génère pour toutes les boutiques listées dans _remaining.json

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

// ---- texte ------------------------------------------------------
function clean(s) {
  let t = String(s || '')
  if (/pointer-events-auto|data-testid|data-turn-id|scroll-mt-\[/.test(t)) {
    t = t
      .replace(/<[^>]*>/g, ' ')
      .replace(/[*\]:@\w/.-]+:pt-header-height[^ ]*/g, '')
      .replace(/[*\]:A-Za-z-]+\s*scroll-mt-\[[^"]*"/g, '')
      .replace(/\b(dir|data-[\w-]+|class|style)="[^"]*"/g, '')
  }
  return t
    .replace(/<\/(p|li|h[1-6]|div|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&rsquo;|’/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
const mkDesc = (a) => a.filter((l) => l && String(l).trim()).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
// le body commence-t-il par un entête nu (bloc structuré sans intro) ?
const startsWithHeader = (t) =>
  /^\s*(COMPOSITION|CARACT[EÉ]RISTIQUES|INGR[EÉ]DIENTS?|INGREDIENTS|PROPRI[EÉ]T[EÉ]S|BIENFAITS|POUR QUI|UTILISATION|MODE D'EMPLOI|CONSEILS?)\b/i.test(String(t))
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
const lc = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s)

// Description d'origine jugée exploitable ? (assez longue, pas 100 % filler)
const FILLER = [
  /un produit alimentaire naturel de qualite superieure/i,
  /une oeuvre d'art originale qui capture l'emotion/i,
  /un accessoire soigneusement confectionne/i,
  /un vetement magnifiquement confectionne/i,
  /un produit de soin soigneusement formule/i,
  /un produit capillaire haut de gamme concu/i,
  /un soigneusement fabrique/i,
  /un accessoire polyvalent adapte aux hommes et aux femmes/i,
  /parfait comme cadeau personnel ou comme petit geste/i,
  /un produit de qualite superieure qui/i,
]
// Une ligne "filler" isolée (souvent au milieu d'un bloc généré).
const FILLER_LINE =
  /^(POUR QUI\s*:?\s*$|Un accessoire polyvalent|Parfait comme cadeau|Ideal pour une utilisation quotidienne|Fait un excellent cadeau|MATERIAUX ET SAVOIR-?FAIRE\s*:?\s*$|A QUI S'ADRESSE)/i

function usefulTail(txt) {
  const m = txt.match(
    /\n\s*(COMPOSITION|CARACT[EÉ]RISTIQUES|INGR[EÉ]DIENTS?|COMMENT L'UTILISER|UTILISATION|MODE D'EMPLOI|CE QUE [ÇC]A FAIT|BIENFAITS|PROPRI[EÉ]T[EÉ]S|CONSEILS? D'ENTRETIEN|COMMENT L'APPLIQUER)\b/i
  )
  if (!m) return ''
  // garde à partir de l'entête, mais vire les lignes filler résiduelles
  return txt
    .slice(m.index)
    .split('\n')
    .filter((l) => !FILLER_LINE.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
function baseText(raw, name) {
  let t = clean(raw)
  const lines = t.split('\n')
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (lines.length > 1 && norm(lines[0]) && norm(name).includes(norm(lines[0]).slice(0, 15))) {
    t = lines.slice(1).join('\n').trim()
  }
  const isFiller = FILLER.some((re) => re.test(t.slice(0, 260)))
  if (isFiller) return usefulTail(t) // '' si rien d'exploitable -> le gabarit prend le relais
  // pas filler global, mais on nettoie quand même les lignes filler isolées
  t = t
    .split('\n')
    .filter((l) => !FILLER_LINE.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // si après nettoyage ça commence par un entête nu ("COMPOSITION :"),
  // c'est qu'il ne restait que le bloc structuré -> on le garde tel quel.
  return t
}

// ---- classification ------------------------------------------
// Nom "propre" : sans "(Copie)", sans doublons de fin, replié si vide.
function cleanName(p) {
  let n = String(p.name || '').replace(/\s*\((copie|copy|\d+)\)\s*$/i, '').replace(/\s{2,}/g, ' ').trim()
  if (!n) {
    // pas de nom : dériver un titre court de la description
    const first = clean(p.current_description).split(/[.\n]|\s[-–—]\s|\s:\s/)[0].trim()
    n = first && first.length >= 3 && first.length < 80 ? first : (p.category_name || 'Article')
  }
  return n
}

function classify(p) {
  const cat = (p.category_name || p.category || '').toLowerCase()
  const n = cleanName(p).toLowerCase()
  const nd = n + ' ' + clean(p.current_description).slice(0, 200).toLowerCase()
  const hasShoeWord = /sandale|babouche|basket|mule|escarpin|talon|soulier|claquette|mocassin|derby|espadrille|tong|nu-pied|chaussure|padam|chausson|chausset|bottine|botte|ballerine|nu-pieds|slippers?/.test(n)

  if (/toyota|camry|\bbmw\b|mercedes|peugeot|renault|hyundai|voiture|v[eé]hicule|berline|\bsuv\b|4x4/.test(n)) return 'skip'

  // 1) catégories fortes d'abord (la catégorie prime sur les mots-clés).
  // objets liés au culte mais qui ne sont pas des livres
  if (/pupitre|lutrin|porte-?coran|porte-?livre|étag[eè]re|tapis de pri[eè]re|sajjada|chapelet|tasbih|misbaha|encensoir|bruleur|br[uû]le-?parfum/.test(n)) return 'maison'
  if (cat.includes('livres') || /\bcoran\b|khassida|hadith|riyad|tafsir|mushaf|kitab|\blivre\b|recueil de pri[eè]res|traduction fran[cç]aise/.test(n)) return 'livre'
  if (cat.includes('électronique') || cat.includes('electronique') || /t[eé]l[eé]phone|casque audio|enceinte|montre connect|chargeur|c[aâ]ble usb|powerbank|batterie externe/.test(n))
    return 'tech'
  if (cat.includes('artisanat') || cat.includes('art africain'))
    return /d[eé]coration|ustensile|bougie|vase|coussin|nappe|calebasse/.test(n) && !/tableau|toile|sculpture|masque|statue/.test(n) ? 'maison' : 'art'
  if (cat.includes('soin cheveux')) return 'cheveux'
  if (cat.includes('beaut') || (cat.includes('soin') && !cat.includes('cheveux'))) return 'beaute'
  if (cat.includes('alimentation') || cat.includes('épicerie') || cat.includes('epicerie')) return 'alimentation'
  if (cat.includes('maison') || cat.includes('décoration') || cat.includes('decoration')) return 'maison'
  if (cat.includes('bijou')) return 'bijou'
  // catégorie "Chaussures" mais nom qui ne parle pas de chaussure
  // (produit mal rangé, ex. "Ensemble pantalon et Chapeau") -> on
  // reclasse d'après le nom plus bas.
  if (cat.includes('chaussures') && hasShoeWord) return 'chaussure'

  // Nom = vêtement évident : prime sur une catégorie mal rangée
  // (ex. "Robe Portefeuille" classée dans "Sacs - Maroquinerie").
  if (/^robe\b|^ensemble\b|^tenue\b|^boubou\b|^kaftan\b|^caftan\b|^abaya\b|^hijab\b|^tailleur\b|^combinaison\b/i.test(n.trim())) return 'vetement'

  if (cat.includes('sacs') || cat.includes('maroquinerie')) return 'sac'

  // 2) "Mode - Vêtements" : distinguer une VRAIE pièce de tissu au coupon
  //    (le nom dit coupon/mètre/yard/tissu) d'un vêtement confectionné.
  const isFabricByName = /\bcoupon\b|\bau m[eè]tre\b|\d+\s*(m[eè]tres?|yards?)\b|^tissu\b|pagne \d|\bwax\b.*\bm[eè]tre/i.test(n)
  if (cat.includes('mode') || cat.includes('vêtement') || cat.includes('vetement')) {
    if (/^robe|^ensemble|^tenue|boubou|kaftan|caftan|abaya|hijab|palazzo|peplum|kimono|corset|jupe|pantalon|chemis|tunique|top |haut /i.test(n)) return 'vetement'
    return isFabricByName ? 'tissu' : 'vetement'
  }
  if (cat.includes('pagne') || cat.includes('tissu')) return 'tissu'

  // 3) sans catégorie utile : mots-clés du nom seulement (pas la description).
  if (/tableau|toile|peinture|sculpture|statue|masque africain|calligraphie|sous verre/.test(n)) return 'art'
  if (isFabricByName || /^pagne\b|bazin|getzner|dentelle au coupon/i.test(n)) return 'tissu'
  if (hasShoeWord) return 'chaussure'
  if (/\bsac\b|pochette|cabas|sacoche|banane|trousse|porte-?feuille|portefeuille|valise|bagage|kalp/.test(n)) return 'sac'
  if (/collier|bracelet|bague|boucle d|parure|pendentif|cha[iî]ne dor|montre(?! connect)|cauris|cr[eé]ole/.test(n)) return 'bijou'
  if (/shampoing|apr[eè]s-shampoing|masque capillaire|huile capillaire|cr[eè]me coiffante|d[eé]fris|edge control|leave-in/.test(nd)) return 'cheveux'
  if (/savon|cr[eè]me|huile de|beurre de|gommage|gel douche|lotion|s[eé]rum|masque visage|d[eé]odorant|baume|pommade|karit[eé]|gel intime/.test(n)) return 'beaute'
  if (/caf[eé]|th[eé]|tisane|infusion|[eé]pice|piment|bissap|moringa|miel|c[eé]r[eé]ale|farine|attieke|soumbara|n[eé]r[eé]|poudre de|kinkeliba|gingembre|curcuma/.test(n)) return 'alimentation'
  if (/d[eé]coration|ustensile|bougie|vase|coussin|nappe|panier|calebasse/.test(n)) return 'maison'
  if (/robe|ensemble|boubou|chemise|pantalon|jupe|t-?shirt|veste|kaftan|caftan|tunique|hijab|voile de pri[eè]re|abaya|djellaba|complet|tailleur|short|sarouel|palazzo|peplum/.test(n)) return 'vetement'
  return 'generic'
}

// dimensions "38x14x17cm" / "74 x 50 cm" / "48/30"
function dims(s) {
  let m = String(s).match(/(\d{2,3})\s?[x×]\s?(\d{1,3})\s?[x×]\s?(\d{1,3})\s?cm/i)
  if (m) return `${m[1]} x ${m[2]} x ${m[3]} cm`
  m = String(s).match(/(\d{2,3})\s?[x×/]\s?(\d{1,3})\s?(?:cm)?/i)
  return m ? `${m[1]} x ${m[2]} cm` : ''
}
// pointures 34-47 dans les variations
function shoeSizes(labels) {
  const s = new Set()
  for (const l of labels || []) {
    for (const mm of String(l).matchAll(/(\d{2})/g)) {
      const v = +mm[1]
      if (v >= 34 && v <= 47) s.add(mm[1])
    }
  }
  return [...s].sort((a, b) => a - b)
}
// coloris depuis le nom "— Rouge" / "- Noir Blanc"
function colorFromName(name) {
  const m = name.match(/[—-]\s*([A-Za-zÀ-ÿ'&/ ]{2,40})$/)
  if (!m) return ''
  const c = m[1].trim()
  return /\d/.test(c) || c.length > 30 ? '' : c
}
// coloris depuis les labels de variation
function colorsFromLabels(labels) {
  const COL = /^(noir|noire|blanc|blanche|rouge|bleu|bleue|vert|verte|jaune|orange|rose|violet|gris|grise|marron|beige|or|dor[ée]|argent[ée]|multicolore|bordeaux|kaki|turquoise|corail|fuchsia|camel|tan|cognac|nude|ivoire|lilas|olive|vin)$/i
  const out = []
  for (const l of labels || []) {
    const parts = String(l).split(/[\/|]/).map((x) => x.trim())
    for (const x of parts) if (COL.test(x)) out.push(lc(x))
  }
  return [...new Set(out)]
}

const VENDOR_NAME = { current: '' }

// ---- générateurs par famille --------------------------------
function gen(p0) {
  // travaille sur une copie avec un nom nettoyé
  const p = { ...p0, name: cleanName(p0) }
  const fam = classify(p0)
  const body = baseText(p.current_description, p.name)
  const D = dims(p.name + ' ' + clean(p.current_description))
  const color = colorFromName(p.name) || colorsFromLabels(p.variation_labels).join(', ')
  const sizes = shoeSizes(p.variation_labels)
  const V = VENDOR_NAME.current

  const CARE = {
    tissu: ['Entretien : lavage à la main à l\'eau froide les premières fois pour fixer les couleurs, ou nettoyage à sec pour les tissus ornés ; séchage à l\'ombre, repassage sur l\'envers.', 'Care: hand-wash cold for the first washes to set the colours, or dry-clean for embellished fabrics; dry in the shade, iron on the reverse.'],
    chaussure: ['Entretien : essuyer la semelle après usage, nourrir le cuir avec une crème incolore, sécher à l\'air loin d\'une source de chaleur, garder la forme avec du papier.', 'Care: wipe the sole after wear, feed the leather with a colourless cream, air-dry away from heat, keep the shape with paper.'],
    sac: ['Entretien : nettoyer les taches au chiffon humide sans détremper, protéger le cuir de la pluie, nourrir 2 à 3 fois par an, ranger à plat rempli de papier.', 'Care: spot-clean with a damp cloth without soaking, protect leather from rain, feed 2–3 times a year, store flat stuffed with paper.'],
    bijou: ['Entretien : essuyer avec un chiffon doux, éviter le contact prolongé avec l\'eau, les parfums et les cosmétiques, ranger à l\'abri de l\'humidité.', 'Care: wipe with a soft cloth, avoid prolonged contact with water, perfume and cosmetics, store away from humidity.'],
    beaute: ['Conservation : refermer après usage, garder au sec et à l\'abri de la lumière directe. Test cutané conseillé avant la première utilisation.', 'Storage: reseal after use, keep dry and away from direct light. A patch test is advised before first use.'],
    cheveux: ['Conservation : refermer après usage, tenir à l\'abri de la chaleur et de la lumière directe.', 'Storage: reseal after use, keep away from heat and direct light.'],
    alimentation: ['Conservation : conserver au sec, à l\'abri de la lumière et de l\'humidité, bien refermer après ouverture.', 'Storage: keep dry, away from light and humidity, reseal after opening.'],
    art: ['Entretien : dépoussiérer avec un chiffon sec ou un plumeau, éviter l\'humidité et l\'exposition directe au soleil.', 'Care: dust with a dry cloth or a feather duster, keep away from humidity and direct sunlight.'],
    maison: ['Entretien : dépoussiérer régulièrement, nettoyer selon la matière (chiffon sec ou légèrement humide), éviter l\'humidité prolongée.', 'Care: dust regularly, clean according to the material (dry or slightly damp cloth), avoid prolonged humidity.'],
    vetement: ['Entretien : lavage à 30 °C sur l\'envers, séchage à l\'ombre, repassage à température moyenne. Nettoyage à sec pour les pièces brodées ou en bazin.', 'Care: wash at 30 °C inside out, dry in the shade, medium iron. Dry-clean embroidered or bazin pieces.'],
    livre: ['Conservation : garder au sec, à l\'abri du soleil, manipuler avec des mains propres.', 'Storage: keep dry, away from sunlight, handle with clean hands.'],
    tech: ['Garantie et notice fournies selon le modèle. Charger complètement avant la première utilisation le cas échéant.', 'Warranty and manual supplied depending on the model. Fully charge before first use where applicable.'],
    generic: [null, null],
  }[fam] || [null, null]

  // ---------- ART ----------
  if (fam === 'art') {
    // description qui parle en fait d'un sac/tissu/soin -> on ignore le
    // corps et on décrit d'après le nom.
    const bodyOffTopic = body && /^(sac à main|pochette|tissu|savon|cr[eè]me|shampoing)\b/i.test(body.trim())
    const useBody = body && !startsWithHeader(body) && !bodyOffTopic ? body : null
    const subj = artSubject(p.name)
    return pack({
      sf: `${artType(p.name)} artisanal africain${subj ? ` — ${subj}` : ''}${D ? `, ${D}` : ''}`,
      se: `African handcrafted ${artTypeEN(p.name)}${subj ? ` — ${subjEN(subj)}` : ''}${D ? `, ${D}` : ''}`,
      df: mkDesc([
        useBody || `${p.name} : pièce d'art décoratif réalisée à la main par un artisan africain, dans la tradition sénégalaise.`,
        D ? `Dimensions : ${D}.` : null,
        `Pièce faite à l'unité : les couleurs et les détails varient légèrement d'un exemplaire à l'autre. Prêt à exposer.`,
        CARE[0],
      ]),
      de: mkDesc([
        `${p.name}: a decorative art piece handmade by an African craftsperson.`,
        D ? `Dimensions: ${D}.` : null,
        `A one-off piece: colours and detail vary slightly between items. Ready to display.`,
        CARE[1],
      ]),
      tags: ['art africain', 'décoration murale', artType(p.name).toLowerCase(), 'artisanat', 'fait main', 'pièce unique', V].filter(Boolean),
      specs: [
        { k: 'Type', v: cap(artType(p.name)) },
        subj ? { k: 'Sujet', v: cap(subj) } : null,
        D ? { k: 'Dimensions', v: D } : null,
        { k: 'Fabrication', v: 'Faite main' },
        { k: 'Unicité', v: 'Pièce unique, légères variations' },
        { k: 'Entretien', v: 'Chiffon sec, éviter humidité et soleil direct' },
      ],
    })
  }

  // ---------- TISSU ----------
  if (fam === 'tissu') {
    const kind = tissuKind(p.name + ' ' + body)
    const lens = (p.variation_labels || [])
      .map((l) => (String(l).match(/(\d+)\s*(m[eè]tres?|yards?)/i) || [])[0])
      .filter(Boolean)
    const lenTxt = [...new Set(lens)].join(' ou ') || 'au coupon'
    return pack({
      sf: `${cap(kind.fr)}${color ? ` ${lc(color)}` : ''} — vendu au métrage, pour la couture`,
      se: `${cap(kind.en)} — sold by the length, for tailoring`,
      df: mkDesc([
        body && !startsWithHeader(body)
          ? body
          : `${p.name} : ${kind.fr}, adapté à la confection de tenues traditionnelles et de créations sur mesure.`,
        body && startsWithHeader(body) ? body : null,
        `Vente au coupon : ${lenTxt}. Le tissu est livré non coupé, prêt à porter chez votre couturier.`,
        CARE[0],
      ]),
      de: mkDesc([
        `${p.name}: ${kind.en}, suited to traditional attire and made-to-measure creations.`,
        `Sold by the cut: ${lenTxt.replace('mètres', 'metres').replace(' ou ', ' or ')}. Ships uncut, ready for your tailor.`,
        CARE[1],
      ]),
      tags: ['tissu', kind.tag, 'pagne', 'couture', 'tissu africain', 'sur-mesure', V].filter(Boolean),
      specs: [
        { k: 'Type', v: cap(kind.fr) },
        color ? { k: 'Coloris', v: cap(color) } : null,
        { k: 'Longueurs', v: lenTxt },
        { k: 'Usage', v: 'Boubou, robes, ensembles, créations sur mesure' },
        { k: 'Entretien', v: 'Lavage main à froid ou nettoyage à sec, séchage à l\'ombre' },
      ],
    })
  }

  // ---------- CHAUSSURE ----------
  if (fam === 'chaussure') {
    const k = chaussureKind(p.name)
    return pack({
      sf: `${cap(k.fr)}${color ? ` ${lc(color)}` : ''}${sizes.length ? ` — pointures EU ${sizes[0]} à ${sizes[sizes.length - 1]}` : ''}`,
      se: `${cap(k.en)}${color ? ` ${lc(color)}` : ''}${sizes.length ? ` — EU ${sizes[0]} to ${sizes[sizes.length - 1]}` : ''}`,
      df: mkDesc([
        body || `${p.name} : chaussures confectionnées avec soin, alliant confort et style.`,
        sizes.length ? `Pointures disponibles : ${sizes.join(', ')}. En cas d'hésitation entre deux tailles, prendre la plus grande.` : null,
        CARE[0],
      ]),
      de: mkDesc([
        `${p.name}: carefully made footwear combining comfort and style.`,
        sizes.length ? `Available sizes: EU ${sizes.join(', ')}. If between sizes, take the larger.` : null,
        CARE[1],
      ]),
      tags: [k.tag, 'chaussure', 'chaussure artisanale', color ? lc(color) : null, 'fait main', V].filter(Boolean),
      specs: [
        { k: 'Type', v: cap(k.fr) },
        color ? { k: 'Coloris', v: cap(color) } : null,
        sizes.length ? { k: 'Pointures', v: `EU ${sizes[0]} à ${sizes[sizes.length - 1]}` } : null,
        { k: 'Fabrication', v: 'Confection soignée' },
        { k: 'Entretien', v: 'Essuyer la semelle, nourrir le cuir, séchage à l\'air' },
      ],
    })
  }

  // ---------- SAC ----------
  if (fam === 'sac') {
    const k = sacKind(p.name)
    return pack({
      sf: `${cap(k.fr)}${color ? ` ${lc(color)}` : ''} — ${k.hintFR}`,
      se: `${cap(k.en)}${color ? ` ${lc(color)}` : ''} — ${k.hintEN}`,
      df: mkDesc([
        body || `${p.name} : ${k.fr} confectionné avec soin, alliant style et praticité.`,
        D ? `Dimensions : ${D}.` : null,
        `Pièce artisanale : les finitions et le placement du motif varient légèrement d'un exemplaire à l'autre.`,
        CARE[0],
      ]),
      de: mkDesc([
        `${p.name}: a ${k.en} made with care, combining style and practicality.`,
        D ? `Dimensions: ${D}.` : null,
        `A handcrafted piece: finishing and pattern placement vary slightly between items.`,
        CARE[1],
      ]),
      tags: [k.tag, 'sac', 'maroquinerie', color ? lc(color) : null, 'fait main', 'accessoire', V].filter(Boolean),
      specs: [
        { k: 'Type', v: cap(k.fr) },
        color ? { k: 'Coloris', v: cap(color) } : null,
        D ? { k: 'Dimensions', v: D } : null,
        { k: 'Fabrication', v: 'Artisanale, faite main' },
        { k: 'Intérieur', v: 'Doublé' },
        { k: 'Entretien', v: 'Chiffon humide en surface, protéger de la pluie' },
      ],
    })
  }

  // ---------- BIJOU ----------
  if (fam === 'bijou') {
    const k = bijouKind(p.name)
    const mat = bijouMat(p.name + ' ' + body)
    return pack({
      sf: `${cap(k.fr)}${mat ? ` en ${mat.fr}` : ''}${color ? `, ${lc(color)}` : ''}`,
      se: `${cap(k.en)}${mat ? ` in ${mat.en}` : ''}`,
      df: mkDesc([
        body || `${p.name} : bijou artisanal${mat ? ` en ${mat.fr}` : ''}, à porter seul ou associé à d'autres pièces.`,
        mat && mat.fr.includes('acier') ? `L'acier inoxydable ne noircit pas et convient aux peaux sensibles.` : null,
        CARE[0],
      ]),
      de: mkDesc([
        `${p.name}: a handcrafted piece of jewellery${mat ? ` in ${mat.en}` : ''}, worn alone or layered with other pieces.`,
        mat && mat.en.includes('steel') ? `Stainless steel does not tarnish and suits sensitive skin.` : null,
        CARE[1],
      ]),
      tags: [k.tag, 'bijou', mat ? mat.tag : null, color ? lc(color) : null, 'accessoire femme', 'fait main', V].filter(Boolean),
      specs: [
        { k: 'Type', v: cap(k.fr) },
        mat ? { k: 'Matière', v: cap(mat.fr) } : null,
        color ? { k: 'Coloris', v: cap(color) } : null,
        { k: 'Fabrication', v: 'Artisanale' },
        { k: 'Entretien', v: 'Chiffon doux, éviter eau et parfum prolongés' },
      ],
    })
  }

  // ---------- BEAUTÉ / CHEVEUX ----------
  if (fam === 'beaute' || fam === 'cheveux') {
    const k = soinKind(p.name, fam)
    const useBody = body && !FILLER.some((re) => re.test(body.slice(0, 200))) ? body : null
    return pack({
      sf: `${cap(k.fr)}${k.zoneFR ? ` — ${k.zoneFR}` : ''}`,
      se: `${cap(k.en)}${k.zoneEN ? ` — ${k.zoneEN}` : ''}`,
      df: mkDesc([
        `${p.name} : ${k.introFR}`,
        useBody,
        startsWithHeader(useBody || '') || !useBody ? `Utilisation : ${k.useFR}` : null,
        CARE[0],
      ]),
      de: mkDesc([
        `${p.name}: ${k.introEN}`,
        `Use: ${k.useEN}`,
        CARE[1],
      ]),
      tags: [k.tag, fam === 'cheveux' ? 'soin cheveux' : 'cosmétique naturel', 'soin naturel', 'fait main', V].filter(Boolean),
      specs: [
        { k: 'Type', v: cap(k.fr) },
        k.zoneFR ? { k: 'Zone', v: cap(k.zoneFR) } : null,
        { k: 'Formule', v: 'Ingrédients naturels' },
        { k: 'Usage', v: k.useShort },
        { k: 'Conservation', v: 'Au sec, à l\'abri de la lumière' },
      ],
    })
  }

  // ---------- ALIMENTATION ----------
  if (fam === 'alimentation') {
    const k = foodKind(p.name)
    const useBody = body && !FILLER.some((re) => re.test(body.slice(0, 200))) ? body : null
    return pack({
      sf: `${cap(k.fr)} — ${k.hintFR}`,
      se: `${cap(k.en)} — ${k.hintEN}`,
      df: mkDesc([
        `${p.name} : ${k.introFR}`,
        useBody,
        startsWithHeader(useBody || '') || !useBody ? `Utilisation : ${k.useFR}` : null,
        CARE[0],
      ]),
      de: mkDesc([
        `${p.name}: ${k.introEN}`,
        `Use: ${k.useEN}`,
        CARE[1],
      ]),
      tags: [k.tag, 'épicerie', 'produit naturel', 'cuisine africaine', V].filter(Boolean),
      specs: [
        { k: 'Type', v: cap(k.fr) },
        { k: 'Origine', v: 'Afrique de l\'Ouest' },
        { k: 'Usage', v: k.useShort },
        { k: 'Conservation', v: 'Au sec, à l\'abri de la lumière et de l\'humidité' },
      ],
    })
  }

  // ---------- VÊTEMENT ----------
  if (fam === 'vetement') {
    const k = vetKind(p.name)
    const szTxt = clothingSizes(p.variation_labels)
    return pack({
      sf: `${cap(k.fr)}${color ? ` ${lc(color)}` : ''}${szTxt ? ` — tailles ${szTxt}` : ''}`,
      se: `${cap(k.en)}${color ? ` ${lc(color)}` : ''}${szTxt ? ` — sizes ${szTxt}` : ''}`,
      df: mkDesc([
        body && !startsWithHeader(body)
          ? body
          : `${p.name} : ${k.fr} confectionné avec soin, alliant confort et style africain contemporain.`,
        body && startsWithHeader(body) ? body : null,
        szTxt ? `Tailles disponibles : ${szTxt}. Se référer au guide des tailles ou contacter la boutique en cas de doute.` : null,
        CARE[0],
      ]),
      de: mkDesc([
        `${p.name}: a ${k.en} made with care, combining comfort with contemporary African style.`,
        szTxt ? `Available sizes: ${szTxt}. Refer to the size guide or contact the shop if unsure.` : null,
        CARE[1],
      ]),
      tags: [k.tag, 'mode africaine', 'vêtement', color ? lc(color) : null, 'tenue africaine', V].filter(Boolean),
      specs: [
        { k: 'Type', v: cap(k.fr) },
        color ? { k: 'Coloris', v: cap(color) } : null,
        szTxt ? { k: 'Tailles', v: szTxt } : null,
        { k: 'Style', v: 'Africain contemporain' },
        { k: 'Entretien', v: 'Lavage 30 °C sur l\'envers, séchage à l\'ombre' },
      ],
    })
  }

  // ---------- MAISON ----------
  if (fam === 'maison') {
    return pack({
      sf: `${p.name} — décoration artisanale africaine`,
      se: `${p.name} — African handcrafted homeware`,
      df: mkDesc([
        body || `${p.name} : objet de décoration réalisé à la main, dans la tradition artisanale africaine.`,
        D ? `Dimensions : ${D}.` : null,
        CARE[0],
      ]),
      de: mkDesc([
        `${p.name}: a decorative homeware item, handmade in the African craft tradition.`,
        D ? `Dimensions: ${D}.` : null,
        CARE[1],
      ]),
      tags: ['décoration', 'maison', 'artisanat africain', 'fait main', 'déco africaine', V].filter(Boolean),
      specs: [
        { k: 'Type', v: 'Objet de décoration' },
        D ? { k: 'Dimensions', v: D } : null,
        { k: 'Fabrication', v: 'Faite main' },
        { k: 'Entretien', v: 'Dépoussiérer, éviter l\'humidité prolongée' },
      ],
    })
  }

  // ---------- LIVRE ----------
  if (fam === 'livre') {
    const isRelig = /coran|khassida|hadith|riyad|tafsir|mushaf|pri[eè]re|invocation|kamil|yassin|soufi/i.test(p.name + ' ' + body)
    return pack({
      sf: isRelig ? `${p.name} — ouvrage religieux` : `${p.name} — ouvrage`,
      se: isRelig ? `${p.name} — religious book` : `${p.name} — book`,
      df: mkDesc([
        body || `${p.name} : ouvrage${isRelig ? ' religieux' : ''}.`,
        CARE[0],
      ]),
      de: mkDesc([
        body ? `${p.name}: ${isRelig ? 'a religious book' : 'a book'}.` : `${p.name}.`,
        CARE[1],
      ]),
      tags: [isRelig ? 'ouvrage religieux' : 'livre', 'livre', 'lecture', isRelig ? 'islam' : null, V].filter(Boolean),
      specs: [
        { k: 'Type', v: isRelig ? 'Ouvrage religieux' : 'Livre' },
        { k: 'Conservation', v: "Au sec, à l'abri du soleil" },
      ],
    })
  }

  // ---------- TECH ----------
  if (fam === 'tech') {
    const okBody = body && !startsWithHeader(body) && !FILLER.some((re) => re.test(body.slice(0, 200))) && !/contenant scell[eé]|conservateurs artificiels|go[uû]t authentique/i.test(body.slice(0, 200)) ? body : null
    return pack({
      sf: `${p.name}`,
      se: `${p.name}`,
      df: mkDesc([
        okBody ||
          `${p.name} : ${/montre/i.test(p.name) ? 'montre électronique compacte à affichage numérique, portée au poignet' : /bague|zikr/i.test(p.name) ? 'compteur de zikr électronique porté au doigt' : /coque|iphone|t[eé]l[eé]phone/i.test(p.name) ? 'accessoire de protection pour téléphone' : 'appareil électronique'}, proposé par ${V || 'la boutique'}.`,
        `Vérifier la compatibilité et l'alimentation avant achat. Notice et garantie selon le modèle.`,
        CARE[0],
      ]),
      de: mkDesc([`${p.name}: an electronic device.`, `Check compatibility and voltage before purchase. Manual and warranty depending on the model.`, CARE[1]]),
      tags: ['électronique', 'tech', 'accessoire', V].filter(Boolean),
      specs: [{ k: 'Type', v: p.name }, { k: 'Garantie', v: 'Selon le modèle' }],
    })
  }

  // ---------- GENERIC ----------
  return pack({
    sf: `${p.name} — ${V || 'pièce artisanale'}`,
    se: `${p.name}`,
    df: mkDesc([
      body || `${p.name}. Proposé par ${V || 'la boutique'}.`,
      `Contactez la boutique pour toute précision sur les matières, dimensions ou l'entretien.`,
    ]),
    de: mkDesc([`${p.name}. Offered by ${V || 'the shop'}.`, `Contact the shop for details on materials, dimensions or care.`]),
    tags: ['artisanat', V].filter(Boolean),
    specs: [{ k: 'Type', v: p.name }, V ? { k: 'Vendu par', v: V } : null].filter(Boolean),
  })
}

// ---- petits classifieurs de sous-type -----------------------
function artType(n) {
  const t = n.toLowerCase()
  if (/sculpture|statue|statuette/.test(t)) return 'sculpture'
  if (/masque/.test(t)) return 'masque'
  if (/vannerie|panier/.test(t)) return 'panier tressé'
  return 'tableau'
}
const artTypeEN = (n) => ({ tableau: 'painting', sculpture: 'sculpture', masque: 'mask', 'panier tressé': 'woven basket' }[artType(n)])
function artSubject(n) {
  const t = n.toLowerCase()
  if (/carte d'afrique|map of africa/.test(t)) return "carte de l'Afrique"
  if (/pilant|pounding|pile le mil/.test(t)) return 'une femme pilant le mil'
  if (/calebass|calabash/.test(t)) return 'une femme à la calebasse'
  if (/goree|slaves|maison des esclaves/.test(t)) return 'la Maison des Esclaves de Gorée'
  if (/allah|calligraphie|islamique/.test(t)) return "la calligraphie du nom d'Allah"
  if (/maternit|femme.*enfant/.test(t)) return 'une scène de maternité'
  if (/baobab|arbre/.test(t)) return 'un baobab'
  return ''
}
const subjEN = (s) =>
  ({
    "carte de l'Afrique": 'a map of Africa',
    'une femme pilant le mil': 'a woman pounding millet',
    'une femme à la calebasse': 'a woman with a calabash',
    'la Maison des Esclaves de Gorée': 'the House of Slaves, Gorée',
    "la calligraphie du nom d'Allah": 'calligraphy of the name of Allah',
    'une scène de maternité': 'a motherhood scene',
    'un baobab': 'a baobab tree',
  }[s] || s)

function tissuKind(t) {
  t = t.toLowerCase()
  if (/getzner|bazin riche|bazin/.test(t)) return { fr: 'bazin riche', en: 'rich bazin fabric', tag: 'bazin' }
  if (/super wax|ankara|wax hollandais|véritable wax|vlisco/.test(t)) return { fr: 'wax / ankara', en: 'wax / ankara print', tag: 'wax' }
  if (/dentelle|swiss voil|guipure|broderie anglaise/.test(t)) return { fr: 'dentelle brodée', en: 'embroidered lace', tag: 'dentelle' }
  if (/bogolan/.test(t)) return { fr: 'bogolan', en: 'bogolan mud cloth', tag: 'bogolan' }
  if (/kente/.test(t)) return { fr: 'kente', en: 'kente cloth', tag: 'kente' }
  if (/voile|mousseline|soie|satin/.test(t)) return { fr: 'voile léger', en: 'light voile', tag: 'voile' }
  if (/coton|chemise/.test(t)) return { fr: 'coton premium', en: 'premium cotton', tag: 'coton' }
  return { fr: 'tissu africain', en: 'African fabric', tag: 'pagne' }
}
function chaussureKind(n) {
  const t = n.toLowerCase()
  if (/babouche/.test(t)) return { fr: 'babouches en cuir', en: 'leather babouches', tag: 'babouche' }
  if (/talon|escarpin/.test(t)) return { fr: 'sandales à talons', en: 'heeled sandals', tag: 'talon' }
  if (/basket|sneaker/.test(t)) return { fr: 'baskets', en: 'trainers', tag: 'basket' }
  if (/mule|claquette/.test(t)) return { fr: 'mules', en: 'mules', tag: 'mule' }
  if (/chausson|chausset|bottine|chelsea/.test(t)) return { fr: 'chaussons bottines en cuir', en: 'leather ankle boots', tag: 'bottine' }
  if (/botte/.test(t)) return { fr: 'bottes', en: 'boots', tag: 'botte' }
  if (/ballerine/.test(t)) return { fr: 'ballerines', en: 'ballet flats', tag: 'ballerine' }
  if (/padam/.test(t)) return { fr: 'sandales Padam en cuir', en: 'Padam leather sandals', tag: 'padam' }
  if (/soulier|derby|mocassin/.test(t)) return { fr: 'souliers en cuir', en: 'leather shoes', tag: 'soulier' }
  return { fr: 'sandales', en: 'sandals', tag: 'sandale' }
}
function sacKind(n) {
  const t = n.toLowerCase()
  if (/à dos|a dos|backpack/.test(t)) return { fr: 'sac à dos', en: 'backpack', tag: 'sac à dos', hintFR: 'spacieux, usage quotidien', hintEN: 'roomy, everyday use' }
  if (/ordinateur|laptop/.test(t)) return { fr: 'sac ordinateur', en: 'laptop bag', tag: 'sac ordinateur', hintFR: 'compartiment portable', hintEN: 'padded compartment' }
  if (/voyage|week-?end/.test(t)) return { fr: 'sac de voyage', en: 'travel bag', tag: 'sac de voyage', hintFR: 'grande capacité', hintEN: 'large capacity' }
  if (/pochette|clutch/.test(t)) return { fr: 'pochette', en: 'clutch', tag: 'pochette', hintFR: "l'essentiel d'une sortie", hintEN: "a night out's essentials" }
  if (/banane/.test(t)) return { fr: 'sac banane', en: 'belt bag', tag: 'sac banane', hintFR: 'taille ou bandoulière', hintEN: 'waist or crossbody' }
  if (/sacoche/.test(t)) return { fr: 'sacoche', en: 'satchel', tag: 'sacoche', hintFR: 'portée bandoulière', hintEN: 'crossbody' }
  if (/trousse|kalp/.test(t)) return { fr: 'trousse', en: 'pouch', tag: 'trousse', hintFR: 'rangement du quotidien', hintEN: 'everyday storage' }
  if (/cabas|tote/.test(t)) return { fr: 'sac cabas', en: 'tote bag', tag: 'cabas', hintFR: 'grand format, porté épaule', hintEN: 'large, shoulder-carried' }
  if (/porte-?feuille|portefeuille/.test(t)) return { fr: 'portefeuille', en: 'wallet', tag: 'portefeuille', hintFR: 'cartes et billets', hintEN: 'cards and notes' }
  return { fr: 'sac à main', en: 'handbag', tag: 'sac à main', hintFR: 'porté main ou épaule', hintEN: 'hand or shoulder carry' }
}
function bijouKind(n) {
  const t = n.toLowerCase()
  if (/parure/.test(t)) return { fr: 'parure (collier + boucles)', en: 'jewellery set (necklace + earrings)', tag: 'parure' }
  if (/collier/.test(t)) return { fr: 'collier', en: 'necklace', tag: 'collier' }
  if (/bracelet|jonc|manchette/.test(t)) return { fr: 'bracelet', en: 'bracelet', tag: 'bracelet' }
  if (/bague|anneau/.test(t)) return { fr: 'bague', en: 'ring', tag: 'bague' }
  if (/boucle|cr[eé]ole|puce/.test(t)) return { fr: "boucles d'oreilles", en: 'earrings', tag: "boucles d'oreilles" }
  if (/montre/.test(t)) return { fr: 'montre', en: 'watch', tag: 'montre' }
  if (/pendentif/.test(t)) return { fr: 'pendentif', en: 'pendant', tag: 'pendentif' }
  return { fr: 'bijou', en: 'piece of jewellery', tag: 'bijou' }
}
function bijouMat(t) {
  t = t.toLowerCase()
  if (/acier inox|stainless/.test(t)) return { fr: 'acier inoxydable', en: 'stainless steel', tag: 'acier inoxydable' }
  if (/cauris/.test(t)) return { fr: 'coquillages cauris', en: 'cowrie shells', tag: 'cauris' }
  if (/perle/.test(t)) return { fr: 'perles', en: 'beads', tag: 'perles' }
  if (/laiton|bronze/.test(t)) return { fr: 'laiton', en: 'brass', tag: 'laiton' }
  if (/argent 925|argent massif/.test(t)) return { fr: 'argent 925', en: 'sterling silver', tag: 'argent' }
  if (/or 18|plaqu[eé] or|gold-?filled/.test(t)) return { fr: 'plaqué or', en: 'gold-plated', tag: 'plaqué or' }
  return null
}
function soinKind(n, fam) {
  const t = n.toLowerCase()
  if (fam === 'cheveux') {
    if (/shampoing/.test(t)) return { fr: 'shampoing', en: 'shampoo', zoneFR: 'cuir chevelu et longueurs', zoneEN: 'scalp and lengths', tag: 'shampoing', introFR: 'shampoing doux qui nettoie sans dessécher.', introEN: 'a gentle shampoo that cleanses without drying.', useFR: 'masser sur cheveux mouillés, rincer, renouveler si besoin.', useEN: 'massage into wet hair, rinse, repeat if needed.', useShort: 'Cheveux mouillés, rincer' }
    if (/masque|après-shampoing|apres-shampoing/.test(t)) return { fr: 'masque capillaire', en: 'hair mask', zoneFR: 'longueurs et pointes', zoneEN: 'lengths and ends', tag: 'masque cheveux', introFR: 'soin nourrissant qui répare et assouplit la fibre.', introEN: 'a nourishing treatment that repairs and softens the hair.', useFR: 'appliquer sur cheveux essorés, laisser poser 5 à 15 min, rincer.', useEN: 'apply to towel-dried hair, leave 5–15 min, rinse.', useShort: 'Poser 5–15 min, rincer' }
    if (/huile/.test(t)) return { fr: 'huile capillaire', en: 'hair oil', zoneFR: 'cuir chevelu et longueurs', zoneEN: 'scalp and lengths', tag: 'huile cheveux', introFR: 'huile de soin qui nourrit et fait briller.', introEN: 'a treatment oil that nourishes and adds shine.', useFR: 'quelques gouttes sur cheveux ou cuir chevelu, masser.', useEN: 'a few drops on hair or scalp, massage in.', useShort: 'Quelques gouttes, masser' }
    return { fr: 'crème coiffante', en: 'styling cream', zoneFR: 'cheveux bouclés et texturés', zoneEN: 'curly and textured hair', tag: 'crème coiffante', introFR: 'définit les boucles, hydrate et discipline les frisottis.', introEN: 'defines curls, moisturises and tames frizz.', useFR: 'appliquer sur cheveux humides mèche par mèche, froisser, laisser sécher.', useEN: 'apply to damp hair section by section, scrunch, air-dry.', useShort: 'Cheveux humides, froisser' }
  }
  if (/savon/.test(t)) return { fr: 'savon de soin', en: 'care soap', zoneFR: 'visage et corps', zoneEN: 'face and body', tag: 'savon', introFR: 'savon fabriqué à la main aux actifs naturels, pour nettoyer et apaiser la peau.', introEN: 'a handmade soap with natural actives, to cleanse and soothe the skin.', useFR: 'faire mousser sur peau humide, laisser poser quelques minutes, rincer.', useEN: 'lather on damp skin, leave a few minutes, rinse.', useShort: 'Peau humide, rincer' }
  if (/huile/.test(t)) return { fr: 'huile de soin', en: 'body oil', zoneFR: 'corps, visage, cheveux', zoneEN: 'body, face, hair', tag: 'huile', introFR: 'huile végétale nourrissante multi-usage.', introEN: 'a nourishing multi-use plant oil.', useFR: 'appliquer sur peau légèrement humide, masser jusqu\'à absorption.', useEN: 'apply to slightly damp skin, massage until absorbed.', useShort: 'Sur peau humide, masser' }
  if (/beurre|karit[eé]/.test(t)) return { fr: 'beurre de karité', en: 'shea butter', zoneFR: 'peau et cheveux très secs', zoneEN: 'very dry skin and hair', tag: 'karité', introFR: 'beurre riche et réparateur, idéal pour les zones sèches.', introEN: 'a rich, repairing butter, ideal for dry areas.', useFR: 'réchauffer une noisette entre les doigts, appliquer sur les zones sèches.', useEN: 'warm a small amount between the fingers, apply to dry areas.', useShort: 'Réchauffer, appliquer' }
  if (/gommage|exfoliant/.test(t)) return { fr: 'gommage', en: 'body scrub', zoneFR: 'corps', zoneEN: 'body', tag: 'gommage', introFR: 'exfoliant qui lisse et affine le grain de peau.', introEN: 'an exfoliant that smooths and refines skin texture.', useFR: 'masser en mouvements circulaires sur peau humide, rincer. 1 à 2 fois par semaine.', useEN: 'massage in circular motions on damp skin, rinse. 1–2 times a week.', useShort: '1–2 fois/semaine, rincer' }
  if (/gel intime|intime/.test(t)) return { fr: 'gel nettoyant intime', en: 'intimate wash', zoneFR: 'zone externe', zoneEN: 'external area', tag: 'hygiène intime', introFR: 'gel lavant doux aux extraits de plantes, respecte l\'équilibre naturel.', introEN: 'a gentle plant-based wash that respects the natural balance.', useFR: 'une petite quantité sur zone externe, rincer à l\'eau claire. Pas d\'usage interne.', useEN: 'a small amount on the external area, rinse with clean water. Not for internal use.', useShort: 'Zone externe, rincer' }
  if (/d[eé]odorant/.test(t)) return { fr: 'déodorant naturel', en: 'natural deodorant', zoneFR: 'aisselles', zoneEN: 'underarms', tag: 'déodorant', introFR: 'déodorant sans sels d\'aluminium, neutralise les odeurs en douceur.', introEN: 'an aluminium-free deodorant that gently neutralises odour.', useFR: 'appliquer sur peau propre et sèche.', useEN: 'apply to clean, dry skin.', useShort: 'Peau propre et sèche' }
  return { fr: 'crème de soin', en: 'care cream', zoneFR: 'visage et corps', zoneEN: 'face and body', tag: 'crème', introFR: 'soin hydratant aux ingrédients naturels.', introEN: 'a moisturising treatment with natural ingredients.', useFR: 'appliquer matin et/ou soir sur peau propre.', useEN: 'apply morning and/or evening to clean skin.', useShort: 'Matin/soir sur peau propre' }
}
function foodKind(n) {
  const t = n.toLowerCase()
  if (/caf[eé] touba|caf[eé]/.test(t)) return { fr: 'café', en: 'coffee', tag: 'café', hintFR: 'à préparer chaud', hintEN: 'brew hot', introFR: 'café torréfié à préparer chaud, arôme corsé.', introEN: 'roasted coffee to brew hot, bold aroma.', useFR: 'infuser ou filtrer selon l\'habitude, doser selon le goût.', useEN: 'infuse or filter as usual, dose to taste.', useShort: 'Infuser chaud' }
  if (/th[eé]|tisane|infusion|kinkeliba|bissap|d[eé]galer/.test(t)) return { fr: 'infusion / tisane', en: 'herbal infusion', tag: 'infusion', hintFR: 'à infuser', hintEN: 'to infuse', introFR: 'plantes à infuser, sans théine ajoutée.', introEN: 'plants to infuse, no added theine.', useFR: 'une cuillère par tasse, eau frémissante, laisser infuser 5 à 10 min.', useEN: 'one spoon per cup, simmering water, steep 5–10 min.', useShort: '5–10 min dans l\'eau chaude' }
  if (/[eé]pice|piment|soumbara|n[eé]r[eé]|curry|assaisonnement|m[eé]lange/.test(t)) return { fr: 'mélange d\'épices', en: 'spice blend', tag: 'épices', hintFR: 'sauces, riz, bouillons', hintEN: 'sauces, rice, broths', introFR: 'mélange d\'épices pour rehausser sauces et plats mijotés.', introEN: 'a spice blend to lift sauces and simmered dishes.', useFR: 'ajouter en cours de cuisson, à doser selon le goût.', useEN: 'add during cooking, dose to taste.', useShort: 'En cuisson, selon le goût' }
  if (/moringa|baobab|poudre de/.test(t)) return { fr: 'poudre de plante', en: 'plant powder', tag: 'superaliment', hintFR: 'boissons, plats, soins', hintEN: 'drinks, dishes, care', introFR: 'poudre de plante à intégrer aux boissons et préparations.', introEN: 'a plant powder to add to drinks and preparations.', useFR: 'une cuillère par jour dans un jus, un yaourt ou une sauce.', useEN: 'one spoon a day in juice, yoghurt or a sauce.', useShort: 'Une cuillère/jour' }
  if (/miel/.test(t)) return { fr: 'miel', en: 'honey', tag: 'miel', hintFR: 'naturel, non chauffé', hintEN: 'natural, unheated', introFR: 'miel récolté localement, non chauffé.', introEN: 'locally harvested honey, unheated.', useFR: 'en tartine, dans les boissons ou les soins.', useEN: 'on bread, in drinks or in skincare.', useShort: 'Tel quel' }
  if (/attieke|c[eé]r[eé]ale|farine|couscous|fonio|mil|riz|ni[eé]b[eé]/.test(t)) return { fr: 'céréale / féculent', en: 'grain / staple', tag: 'céréale', hintFR: 'à cuire', hintEN: 'to cook', introFR: 'produit céréalier à cuire, base des repas.', introEN: 'a grain product to cook, a meal staple.', useFR: 'cuire à l\'eau ou à la vapeur selon l\'usage.', useEN: 'boil or steam depending on use.', useShort: 'Cuire à l\'eau/vapeur' }
  return { fr: 'produit d\'épicerie', en: 'grocery product', tag: 'épicerie', hintFR: 'produit naturel', hintEN: 'natural product', introFR: 'produit alimentaire naturel sélectionné avec soin.', introEN: 'a carefully selected natural food product.', useFR: 'consommer selon les habitudes culinaires.', useEN: 'use according to culinary habits.', useShort: 'Selon la recette' }
}
function vetKind(n) {
  const t = n.toLowerCase()
  if (/boubou|bubu|kaftan|caftan/.test(t)) return { fr: 'boubou', en: 'boubou', tag: 'boubou' }
  if (/abaya|djellaba|jilbab/.test(t)) return { fr: 'abaya', en: 'abaya', tag: 'abaya' }
  if (/hijab|voile de pri[eè]re|khimar/.test(t)) return { fr: 'hijab / voile', en: 'hijab / prayer veil', tag: 'hijab' }
  if (/robe/.test(t)) return { fr: 'robe', en: 'dress', tag: 'robe' }
  if (/ensemble|complet|tailleur|2 pi[eè]ces|3 pi[eè]ces/.test(t)) return { fr: 'ensemble', en: 'co-ord set', tag: 'ensemble' }
  if (/chemise|chemisier/.test(t)) return { fr: 'chemise', en: 'shirt', tag: 'chemise' }
  if (/pantalon|sarouel/.test(t)) return { fr: 'pantalon', en: 'trousers', tag: 'pantalon' }
  if (/jupe/.test(t)) return { fr: 'jupe', en: 'skirt', tag: 'jupe' }
  if (/short/.test(t)) return { fr: 'short', en: 'shorts', tag: 'short' }
  if (/t-?shirt|top|d[eé]bardeur/.test(t)) return { fr: 'haut', en: 'top', tag: 'haut' }
  return { fr: 'vêtement', en: 'garment', tag: 'vêtement' }
}
function clothingSizes(labels) {
  const S = new Set()
  for (const l of labels || []) {
    for (const m of String(l).matchAll(/\b(XX?X?[SL]|S|M|L)\b/g)) S.add(m[1].toUpperCase())
    for (const m of String(l).matchAll(/\b(3[4-9]|4[0-8])\b/g)) S.add(m[1])
  }
  const order = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']
  const arr = [...S].sort((a, b) => (order.indexOf(a) - order.indexOf(b)) || (+a - +b))
  return arr.length ? (arr.length > 3 ? `${arr[0]} à ${arr[arr.length - 1]}` : arr.join(', ')) : ''
}

// pack -> objet content, avec filtrage/normalisation specs
const tidySub = (s) =>
  String(s || '')
    .replace(/\s*[—–|:-]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 150)
function pack({ sf, se, df, de, tags, specs }) {
  return {
    subtitle_fr: tidySub(sf),
    subtitle_en: tidySub(se),
    description_fr: df,
    description_en: de,
    tags: [...new Set(tags.filter(Boolean).map((t) => String(t).trim().toLowerCase()))].slice(0, 12),
    specifications: specs
      .filter(Boolean)
      .map((s) => ({ k: String(s.k).trim(), v: String(s.v).trim(), source: 'vendor' }))
      .filter((s) => s.k && s.v),
  }
}

// ---- run --------------------------------------------------------
function processVendor(vendorId) {
  const pullFile = join(HERE, `${vendorId}.pull.json`)
  if (!existsSync(pullFile)) {
    execSync(`node scripts/enrich-catalog.mjs pull ${vendorId}`, { cwd: ROOT, stdio: 'inherit' })
  }
  const pull = JSON.parse(readFileSync(pullFile, 'utf8'))
  const out = {}
  let skipped = 0
  for (const p of pull) {
    if (classify(p) === 'skip') {
      skipped++
      continue
    }
    out[p.id] = gen(p)
  }
  writeFileSync(join(HERE, `${vendorId}.content.json`), JSON.stringify(out, null, 2))
  console.log(`#${vendorId} : ${Object.keys(out).length} produits générés${skipped ? `, ${skipped} ignorés` : ''}`)
  return Object.keys(out).length
}

const args = process.argv.slice(2)
if (args[0] === '--all') {
  const list = JSON.parse(readFileSync(join(HERE, '_remaining.json'), 'utf8'))
  let total = 0
  for (const v of list) {
    // le nom de boutique est injecté à partir du pull (store dans les items ? sinon vide)
    VENDOR_NAME.current = ''
    total += processVendor(v)
  }
  console.log(`\nTotal : ${total} produits générés pour ${list.length} boutiques.`)
} else if (args[0]) {
  processVendor(Number(args[0]))
} else {
  console.log('usage : node scripts/catalog-enrich/enrich-generic.mjs <vendorId> | --all')
}

export { gen, classify }

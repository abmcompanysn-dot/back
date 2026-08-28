#!/usr/bin/env node
// ============================================================
// geocode-vendor-addresses.mjs — géocode l'adresse d'expédition des
// boutiques (quartier/ville -> lat/lng via Nominatim OSM) et l'enregistre
// dans shipping-svc (POST /vendor-shipping-address).
//
// Alimente :
//   - le module de livraison nationale Sénégal (calculateDomestic a besoin
//     de la position vendeur, sinon 404 vendor_address_missing)
//   - la carte admin des boutiques (page /admin/vendor-map)
//
// Usage :
//   node scripts/geocode-vendor-addresses.mjs [--dry-run] [--only SN]
//     --dry-run : géocode et affiche, n'écrit rien
//     --only SN : ne traite que les boutiques du Sénégal
//
// Env :
//   SHIPPING_SVC_URL   (défaut http://localhost:8085 ; en SSH sur le VPS
//                       utiliser http://shipping-svc:8085 via kubectl
//                       port-forward, ou lancer depuis un pod)
//
// Nominatim : quota 1 req/s, User-Agent obligatoire. On respecte 1.1s
// entre deux requêtes. Résultats douteux (hors Sénégal, ou pile sur le
// centroïde de Dakar pour un quartier précis) -> repli sur DAKAR_QUARTIERS
// / VILLES_SN ci-dessous, sinon signalé pour révision manuelle.
// ============================================================

const DRY_RUN = process.argv.includes('--dry-run')
// --emit-json : n'écrit rien vers shipping-svc, imprime une ligne JSON
// {vendor_id,address,lat,lng} par boutique géocodée sur stdout (à piper
// vers un exécuteur qui a accès au service, ex. via SSH + kubectl exec).
const EMIT_JSON = process.argv.includes('--emit-json')
const ONLY = (() => {
  const i = process.argv.indexOf('--only')
  return i !== -1 ? (process.argv[i + 1] || '').toUpperCase() : null
})()

const SHIPPING_SVC_URL = process.env.SHIPPING_SVC_URL || 'http://localhost:8085'
const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
const UA = 'MIAD-Market-geocoder/1.0 (contact: abmcompanysn@gmail.com)'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- Boutiques à géocoder ----------
// vendorId : IDs RÉELS de vendor-svc (GET /vendors), PAS ceux du
//   frontend/CLAUDE.md qui sont obsolètes (décalage confirmé le
//   2026-08-28 : "MAGUY SN" = 39 dans vendor-svc, pas 81).
// hint     : le quartier/ville donné par le fondateur (email 2026-08-28).
// country  : ISO2, pour le suffixe de requête Nominatim et le filtre --only.
// Boutiques de l'email introuvables dans vendor-svc (nouveaux noms /
// boutiques pas encore créées) : Touba store prestige, Local Consumption,
// Épices Sénégal, Nature essence, Myana fashion, Teranga perle.
const VENDORS = [
  // ---- Sénégal (module livraison nationale) ----
  { vendorId: 43, name: 'la Petite Attou',            hint: "Patte d'Oie, Dakar",          country: 'SN' },
  { vendorId: 70, name: "I'Dool",                      hint: 'Mariste, Dakar',              country: 'SN' },
  { vendorId: 39, name: 'MAGUY SN',                    hint: 'Mariste, Dakar',              country: 'SN' },
  { vendorId: 33, name: 'BK by Yacine',               hint: 'Almadies, Dakar',             country: 'SN' },
  { vendorId: 74, name: 'Ayzha Cosmetics',            hint: 'Grand Yoff, Dakar',           country: 'SN' },
  { vendorId: 46, name: 'COSAAN GROUPE',              hint: 'Yoff, Dakar',                 country: 'SN' },
  { vendorId: 19, name: 'Fadhilou hijab',             hint: 'Thiaroye, Dakar',             country: 'SN' },
  { vendorId: 16, name: 'EAAP TIM VIP AFRICAINE',     hint: 'Colobane, Dakar',             country: 'SN' }, // "Savodogo"
  { vendorId: 45, name: 'Teranga Infusion',           hint: 'Dakar',                       country: 'SN' },
  { vendorId: 22, name: 'Sahel Natura',               hint: 'Golf Sud, Guédiawaye, Dakar', country: 'SN' },
  { vendorId: 23, name: 'BarryAfricaincaaps',         hint: 'Castors, Dakar',              country: 'SN' },
  { vendorId: 20, name: 'maktaba assahaba',           hint: 'Colobane, Dakar',             country: 'SN' },
  { vendorId: 35, name: 'Mame Babacar Business',      hint: 'Keur Massar, Dakar',          country: 'SN' },
  { vendorId: 36, name: 'Mes perles By Awa',          hint: 'Fann Hock, Dakar',            country: 'SN' },
  { vendorId: 42, name: 'Diouma',                      hint: 'Sandaga, Dakar',              country: 'SN' }, // "Diouma art"
  { vendorId: 69, name: 'Thilor design',              hint: 'Tivaouane',                   country: 'SN' },
  { vendorId: 15, name: 'Wall Art Print',             hint: 'Tivaouane',                   country: 'SN' },
  { vendorId: 72, name: 'Naby Gold',                  hint: 'Tivaouane',                   country: 'SN' },
  { vendorId: 68, name: 'MAC Collection',             hint: 'Tivaouane',                   country: 'SN' },
  { vendorId: 40, name: 'Awa',                         hint: 'Ndiakhaté 15km Tivaouane',    country: 'SN', force: [14.8667, -16.7000] },
  { vendorId: 41, name: 'Dabo filitex',               hint: 'HLM, Dakar',                  country: 'SN' },
  { vendorId: 34, name: 'Tawa mboudaye acajou',       hint: 'HLM 5, Dakar',                country: 'SN' },
  { vendorId: 44, name: 'Bio kya',                     hint: 'Keur Ndiaye Lô, Dakar',       country: 'SN' },
  { vendorId: 25, name: 'Adore ESSENTIALS',           hint: 'Dakar',                       country: 'SN' },
  { vendorId: 21, name: 'Lipton Café Touba',          hint: 'Dakar',                       country: 'SN' }, // "Touba store prestige" ? proche
  { vendorId: 71, name: 'Café Touba Mame Fatou',      hint: 'Dakar',                       country: 'SN' },
  { vendorId: 73, name: 'Mamaniboutique',             hint: 'Dakar',                       country: 'SN' },
  { vendorId: 37, name: 'Mamis Ba',                   hint: 'Dakar',                       country: 'SN' },
  { vendorId: 38, name: 'waxtu',                      hint: 'Dakar',                       country: 'SN' },
  { vendorId: 57, name: 'noblesse sn',               hint: 'Dakar',                       country: 'SN' },
  { vendorId: 30, name: 'Lebou Agro',                hint: 'Dakar',                       country: 'SN' },
  { vendorId: 17, name: 'complexe-yayou-naby-business', hint: 'Dakar',                    country: 'SN' },
  { vendorId: 28, name: 'Complexe yayou Naby business', hint: 'Dakar',                    country: 'SN' },

  // ---- Autres pays (carte seulement, pas de livraison nationale) ----
  { vendorId: 29, name: "MALAÏKA'S HOUSE",           hint: 'Yaoundé, Cameroun',           country: 'CM' },
  { vendorId: 31, name: 'chez bio distribution',     hint: 'Yaoundé, Cameroun',           country: 'CM' },
  { vendorId: 32, name: 'Ets Bio distribution',      hint: 'Yaoundé, Cameroun',           country: 'CM' },
  { vendorId: 59, name: 'Nadjoa beads',              hint: 'Accra, Ghana',                country: 'GH' },
  { vendorId: 62, name: 'MŪHEBA',                    hint: 'Accra, Ghana',                country: 'GH' },
  { vendorId: 58, name: 'Styleworld',               hint: 'Accra, Ghana',                country: 'GH' },
  { vendorId: 64, name: 'nana_coutureofficial',     hint: 'Lagos, Nigeria',              country: 'NG' },
  { vendorId: 65, name: 'Perles De Lux',            hint: 'Isheri Oshun, Lagos, Nigeria', country: 'NG' },
  { vendorId: 24, name: 'Blings_by_ze',             hint: 'Suleja, Niger State, Nigeria', country: 'NG' },
  { vendorId: 63, name: 'AdaH',                      hint: 'Conakry, Guinée',             country: 'GN' },
  { vendorId: 60, name: 'Pure bio by Nastou',       hint: 'Conakry, Guinée',             country: 'GN' },
  { vendorId: 26, name: 'I &M Chic création',       hint: 'Conakry, Guinée',             country: 'GN' },
  { vendorId: 50, name: 'Boiro création',           hint: 'Conakry, Guinée',             country: 'GN' },
  { vendorId: 47, name: 'ADJI BIO ET SERVICES',     hint: 'Conakry, Guinée',             country: 'GN' },
  { vendorId: 48, name: 'Thierno textile',          hint: 'Conakry, Guinée',             country: 'GN' },
  { vendorId: 49, name: 'COFAPP',                   hint: 'Conakry, Guinée',             country: 'GN' },
  { vendorId: 51, name: 'Komara et frères',         hint: 'Conakry, Guinée',             country: 'GN' },
  { vendorId: 52, name: 'Africa Art center',        hint: 'Conakry, Guinée',             country: 'GN' },
  { vendorId: 53, name: 'AKatty-by Echour',         hint: 'Conakry, Guinée',             country: 'GN' },
  { vendorId: 54, name: 'Les Épices de Maëlle',     hint: 'Conakry, Guinée',             country: 'GN' },
  { vendorId: 67, name: "MOFOUNGOUROU Galerie d'Art", hint: 'Conakry, Guinée',           country: 'GN' },
  { vendorId: 27, name: 'Georgine wax',             hint: 'Cotonou, Bénin',              country: 'BJ' },
  { vendorId: 18, name: 'Galerie Fon Amonmi',       hint: 'Cotonou, Bénin',              country: 'BJ' },
]

// ---------- Replis coordonnées connues ----------
// Centroïdes de quartiers de Dakar et villes du Sénégal, utilisés quand
// Nominatim échoue ou renvoie un résultat manifestement faux. Sources :
// coordonnées publiques OSM/Wikipedia des quartiers.
const DAKAR_QUARTIERS = {
  'patte d\'oie':      [14.7285, -17.4515],
  'mariste':           [14.7192, -17.4498],
  'almadies':          [14.7442, -17.5211],
  'grand yoff':        [14.7401, -17.4600],
  'yoff':              [14.7549, -17.4914],
  'thiaroye':          [14.7600, -17.3600],
  'colobane':          [14.6944, -17.4472],
  'keur massar':       [14.7797, -17.3153],
  'parcelles assainies': [14.7700, -17.4200],
  'golf sud':          [14.7700, -17.3900],
  'guédiawaye':        [14.7800, -17.4050],
  'castors':           [14.7050, -17.4550],
  'hlm':               [14.7000, -17.4450],
  'hlm 5':             [14.7010, -17.4460],
  'fann hock':         [14.6810, -17.4640],
  'sandaga':           [14.6730, -17.4390],
  'gueule tapée':      [14.6820, -17.4560],
  'zone de captage':   [14.7350, -17.4550],
  'keur ndiaye lô':    [14.8300, -17.2100],
  'plateau':           [14.6690, -17.4380],
}
const VILLES_SN = {
  'dakar':      [14.6928, -17.4467],
  'tivaouane':  [14.9500, -16.8167],
  'thiès':      [14.7910, -16.9256],
  'mbour':      [14.4198, -16.9660],
  'kédougou':   [12.5556, -12.1808],
  'ndiakhaté':  [14.8667, -16.7000], // ~15 km de Tivaouane, indiqué par le fondateur
  'kaolack':    [14.1500, -16.0667],
  'rufisque':   [14.7167, -17.2667],
  'saint-louis':[16.0333, -16.5000],
}
// Autres pays (centre-ville).
const VILLES_AUTRES = {
  'accra':    [5.6037, -0.1870],
  'lagos':    [6.5244, 3.3792],
  'conakry':  [9.6412, -13.5784],
  'cotonou':  [6.3703, 2.3912],
  'abidjan':  [5.3600, -4.0083],
  'yaoundé':  [3.8480, 11.5021],
  'suleja':   [9.1806, 7.1806],
  'isheri oshun': [6.5833, 3.2833],
}

const DAKAR_CENTER = [14.6928, -17.4467]

function fallbackCoords(hint) {
  const h = hint.toLowerCase()
  for (const [k, v] of Object.entries(DAKAR_QUARTIERS)) if (h.includes(k)) return { lat: v[0], lng: v[1], src: `fallback:quartier:${k}` }
  for (const [k, v] of Object.entries(VILLES_SN))       if (h.includes(k)) return { lat: v[0], lng: v[1], src: `fallback:ville:${k}` }
  for (const [k, v] of Object.entries(VILLES_AUTRES))   if (h.includes(k)) return { lat: v[0], lng: v[1], src: `fallback:ville:${k}` }
  return null
}

// Un résultat Nominatim est "douteux" s'il tombe à < ~1.2 km du centroïde
// exact de Dakar alors qu'un quartier précis était demandé (Nominatim
// renvoie souvent le centre-ville par défaut pour un quartier inconnu).
function isSuspicious(lat, lng, hint) {
  const h = hint.toLowerCase()
  const wantsQuartier = Object.keys(DAKAR_QUARTIERS).some((k) => h.includes(k))
  if (!wantsQuartier) return false
  const dLat = lat - DAKAR_CENTER[0]
  const dLng = lng - DAKAR_CENTER[1]
  const km = Math.sqrt(dLat * dLat + dLng * dLng) * 111
  return km < 1.2
}

async function geocode(hint) {
  const q = hint.includes('Sénégal') || /,\s*[A-ZÉ]/.test(hint) ? hint : `${hint}, Sénégal`
  const url = `${NOMINATIM}?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=0`
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr' } })
  if (!res.ok) throw new Error(`Nominatim ${res.status}`)
  const arr = await res.json()
  if (!Array.isArray(arr) || arr.length === 0) return null
  return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), display: arr[0].display_name }
}

async function saveAddress(vendorId, address, lat, lng) {
  const res = await fetch(`${SHIPPING_SVC_URL}/vendor-shipping-address`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vendor_id: vendorId, address, lat, lng }),
  })
  if (!res.ok) throw new Error(`shipping-svc ${res.status}: ${await res.text()}`)
  return res.json()
}

async function main() {
  const list = ONLY ? VENDORS.filter((v) => v.country === ONLY) : VENDORS
  const unresolved = []
  const done = []
  const failed = []

  for (const v of list) {
    if (v.vendorId == null) {
      unresolved.push(v)
      console.log(`⏭  ${v.name.padEnd(28)} — vendorId inconnu, à compléter (hint: ${v.hint})`)
      continue
    }
    let coords = null
    let source = ''
    // force : coordonnées imposées manuellement (Nominatim renvoie un
    // homonyme lointain — ex. "Ndiakhaté" à 60 km au lieu de 15 km de
    // Tivaouane, ou "Cameroun" résolu vers Bamako).
    if (Array.isArray(v.force)) {
      coords = { lat: v.force[0], lng: v.force[1] }
      source = 'forced'
    }
    try {
      if (coords) throw { skip: true }
      const g = await geocode(v.hint)
      await sleep(1100) // quota Nominatim
      if (g && !isSuspicious(g.lat, g.lng, v.hint)) {
        coords = { lat: g.lat, lng: g.lng }
        source = 'nominatim'
      } else if (g) {
        console.log(`   ⚠ ${v.name}: résultat Nominatim douteux (${g.lat},${g.lng} — "${g.display}"), repli table`)
      }
    } catch (e) {
      if (!e?.skip) console.log(`   ⚠ ${v.name}: Nominatim a échoué (${e.message}), repli table`)
    }
    if (!coords) {
      const fb = fallbackCoords(v.hint)
      if (fb) { coords = { lat: fb.lat, lng: fb.lng }; source = fb.src }
    }
    if (!coords) {
      failed.push(v)
      console.log(`❌ ${v.name.padEnd(28)} — impossible de géocoder "${v.hint}"`)
      continue
    }

    const address = v.hint
    if (EMIT_JSON) {
      process.stdout.write(JSON.stringify({ vendor_id: v.vendorId, address, lat: coords.lat, lng: coords.lng }) + '\n')
      done.push(v)
    } else if (DRY_RUN) {
      console.log(`🔎 ${v.name.padEnd(28)} #${v.vendorId}  ${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}  (${source})`)
    } else {
      try {
        await saveAddress(v.vendorId, address, coords.lat, coords.lng)
        console.log(`✅ ${v.name.padEnd(28)} #${v.vendorId}  ${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}  (${source})`)
        done.push(v)
      } catch (e) {
        failed.push(v)
        console.log(`❌ ${v.name.padEnd(28)} #${v.vendorId} — enregistrement échoué: ${e.message}`)
      }
    }
  }

  if (EMIT_JSON) return
  console.log('\n─── Récapitulatif ───')
  console.log(`  Enregistrées : ${done.length}`)
  console.log(`  Échecs       : ${failed.length}`)
  console.log(`  vendorId manquant (à compléter dans ce script) : ${unresolved.length}`)
  if (unresolved.length) {
    console.log('\n  Boutiques à mapper manuellement (nom email → vendor_id) :')
    for (const v of unresolved) console.log(`    - "${v.name}" (${v.hint})`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })

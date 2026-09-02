// product-taxonomy — correspondance catégorie MIAD → taxonomie produit
// Google (g:google_product_category) et Facebook (fb_product_category).
//
// Google recommande l'ID numérique de sa taxonomie officielle
// (https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt).
// Facebook accepte le même chemin en texte. On mappe par mot-clé du nom de
// catégorie MIAD (slug ou nom), avec un repli générique.

interface TaxoEntry {
  googleId: number
  fbPath: string
}

// Repli : "Apparel & Accessories" (large, accepté par les deux).
const FALLBACK: TaxoEntry = { googleId: 166, fbPath: 'apparel & accessories' }

// clé = fragment recherché (minuscule, sans accent) dans le nom/slug catégorie.
const MAP: { match: RegExp; entry: TaxoEntry }[] = [
  { match: /sac|maroquinerie|pochette|bagage/, entry: { googleId: 6551, fbPath: 'apparel & accessories > handbags & wallets > handbags' } },
  { match: /chaussure|sandale|basket/, entry: { googleId: 187, fbPath: 'apparel & accessories > shoes' } },
  { match: /bijou|collier|bracelet|bague|boucle|parure/, entry: { googleId: 188, fbPath: 'apparel & accessories > jewelry' } },
  { match: /montre/, entry: { googleId: 201, fbPath: 'apparel & accessories > jewelry > watches' } },
  { match: /pagne|tissu|wax|bogolan|bazin|kente/, entry: { googleId: 505378, fbPath: 'arts & entertainment > hobbies & creative arts > arts & crafts > art & crafting materials > textiles' } },
  { match: /robe|ensemble|boubou|tenue|vetement|chemise|jupe|pantalon|caftan|kaftan/, entry: { googleId: 1604, fbPath: 'apparel & accessories > clothing' } },
  { match: /beaute|soin|creme|savon|huile|cosmetiqu|parfum|serum|masque|gommage/, entry: { googleId: 469, fbPath: 'health & beauty > personal care > cosmetics' } },
  { match: /cheveux|capillair|shampoing|apres-shampoing/, entry: { googleId: 484, fbPath: 'health & beauty > personal care > hair care' } },
  { match: /epice|condiment|piment|the|cafe|infusion|tisane|cereale|legumineuse|alimentation|epiceri/, entry: { googleId: 422, fbPath: 'food, beverages & tobacco > food items' } },
  { match: /decoration|maison|deco|panier|vannerie|ustensile|bougie/, entry: { googleId: 696, fbPath: 'home & garden > decor' } },
  { match: /tableau|peinture|sculpture|statuette|art africain|artisanat/, entry: { googleId: 500044, fbPath: 'home & garden > decor > artwork' } },
  { match: /bebe|enfant|jouet|puericultur/, entry: { googleId: 5394, fbPath: 'baby & toddler' } },
]

export function taxonomyFor(categoryNameOrSlug: string | undefined | null): TaxoEntry {
  if (!categoryNameOrSlug) return FALLBACK
  const key = categoryNameOrSlug
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
  for (const { match, entry } of MAP) {
    if (match.test(key)) return entry
  }
  return FALLBACK
}

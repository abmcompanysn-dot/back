import { NextResponse } from 'next/server'
import { countries } from '@/lib/woocommerce'
import { COUNTRY_TO_ZONE } from '@/lib/shipping-utils'
import { getCloudflareBindings, embedOne } from '@/lib/cloudflare-ai'
import { searchWooProducts, fetchWooProductsByIds, mapWooProduct, type CatalogProduct } from '@/lib/woo-catalog'

export const runtime = 'edge';

const SYSTEM_PROMPT = `Tu es MIAD, l'assistant IA officiel de MIAD Market — la première marketplace africaine Made in Africa, Shared with the World.

Tu aides UNIQUEMENT pour les sujets liés à MIAD Market. Pour toute autre question, réponds poliment que tu ne peux t'exprimer que sur MIAD Market.

Tu aides les clients à :
- Trouver des produits disponibles sur MIAD Market
- Répondre aux questions sur les commandes, la livraison, les paiements
- Suggérer des produits selon les besoins
- Expliquer le fonctionnement de la plateforme

Quand l'utilisateur cherche un produit ou demande une recommandation, appelle TOUJOURS la fonction search_products.

Règles STRICTES :
- Réponds en Français sauf si l'utilisateur écrit en Anglais
- Max 2-3 phrases de texte, chaleureux et professionnel
- Ne mentionne jamais de concurrents
- Ne divulgue aucune donnée sur les utilisateurs
- Si on demande ton modèle ou ta technologie, réponds que tu es MIAD l'assistant de MIAD Market
- Pour les questions de livraison ou paiement, utilise UNIQUEMENT les informations du contexte client ci-dessous`

// Tarifs livraison par zone (prix par kg, minimum $25 hors continent Afrique)
const SHIPPING_BY_ZONE: Record<string, { express: string; standard: string; delaiExpress: string; delaiStandard: string; note: string }> = {
  AF: { express: '$30 – $55', standard: '$12 – $22', delaiExpress: '3 à 5 jours ouvrés', delaiStandard: '3 à 4 semaines', note: 'Tarif par kg, minimum $12 intra-Afrique.' },
  EU: { express: '$45 – $70', standard: '$25 – $45', delaiExpress: '3 à 5 jours ouvrés', delaiStandard: '3 à 4 semaines', note: 'Tarif par kg, minimum $25 hors Afrique.' },
  NA: { express: '$50 – $75', standard: '$25 – $50', delaiExpress: '3 à 5 jours ouvrés', delaiStandard: '3 à 4 semaines', note: 'Tarif par kg, minimum $25 hors Afrique.' },
  SA: { express: '$55 – $80', standard: '$25 – $50', delaiExpress: '5 à 7 jours ouvrés', delaiStandard: '3 à 4 semaines', note: 'Tarif par kg, minimum $25 hors Afrique.' },
  AS: { express: '$55 – $85', standard: '$25 – $55', delaiExpress: '5 à 7 jours ouvrés', delaiStandard: '3 à 4 semaines', note: 'Tarif par kg, minimum $25 hors Afrique.' },
  OC: { express: '$60 – $90', standard: '$30 – $60', delaiExpress: '5 à 7 jours ouvrés', delaiStandard: '3 à 4 semaines', note: 'Tarif par kg, minimum $30 hors Afrique.' },
}

// Méthodes de paiement par pays
const PAYMENT_BY_COUNTRY: Record<string, string[]> = {
  SN: ['Wave ✅', 'Orange Money ✅', 'Djamo ✅', 'Carte Visa/Mastercard ✅'],
  CI: ['Wave ✅', 'Orange Money ✅', 'MTN Mobile Money ✅', 'Djamo ✅', 'Carte Visa/Mastercard ✅'],
  CM: ['MTN Mobile Money ✅', 'Orange Money ✅', 'Carte Visa/Mastercard ✅'],
  GN: ['Orange Money ✅', 'Wave ✅', 'MTN Mobile Money ✅', 'Carte Visa/Mastercard ✅'],
  ML: ['Orange Money ✅', 'Wave ✅', 'Carte Visa/Mastercard ✅'],
  BF: ['Orange Money ✅', 'Wave ✅', 'Carte Visa/Mastercard ✅'],
  NE: ['Orange Money ✅', 'Carte Visa/Mastercard ✅'],
  BJ: ['MTN Mobile Money ✅', 'Orange Money ✅', 'Carte Visa/Mastercard ✅'],
  TG: ['Flooz ✅', 'T-Money ✅', 'Carte Visa/Mastercard ✅'],
  GH: ['MTN Mobile Money ✅', 'Vodafone Cash ✅', 'AirtelTigo Money ✅', 'Carte Visa/Mastercard ✅'],
  NG: ['Carte Visa/Mastercard ✅', 'Virement bancaire ✅'],
  CD: ['Airtel Money ✅', 'M-Pesa ✅', 'Carte Visa/Mastercard ✅'],
  GA: ['Airtel Money ✅', 'Carte Visa/Mastercard ✅'],
  CG: ['Airtel Money ✅', 'Carte Visa/Mastercard ✅'],
  KE: ['M-Pesa ✅', 'Carte Visa/Mastercard ✅'],
  UG: ['MTN Mobile Money ✅', 'Airtel Money ✅', 'Carte Visa/Mastercard ✅'],
  RW: ['MTN Mobile Money ✅', 'Carte Visa/Mastercard ✅'],
  MA: ['Carte Visa/Mastercard ✅', 'Wave ✅'],
  DZ: ['Carte Visa/Mastercard ✅'],
  EG: ['Carte Visa/Mastercard ✅'],
  FR: ['Carte Visa/Mastercard ✅', 'PayPal ✅'],
  BE: ['Carte Visa/Mastercard ✅', 'PayPal ✅'],
  DE: ['Carte Visa/Mastercard ✅', 'PayPal ✅'],
  GB: ['Carte Visa/Mastercard ✅', 'PayPal ✅'],
  US: ['Carte Visa/Mastercard ✅', 'PayPal ✅'],
  CA: ['Carte Visa/Mastercard ✅', 'PayPal ✅'],
}

function buildClientContext(countryCode: string, countryName: string | null): string {
  const code = countryCode.toUpperCase()
  const zone = COUNTRY_TO_ZONE[code] || 'AF'
  const shipping = SHIPPING_BY_ZONE[zone] || SHIPPING_BY_ZONE.AF
  const payments = PAYMENT_BY_COUNTRY[code] || ['Carte Visa/Mastercard ✅', 'Wave ✅', 'Orange Money ✅']
  const name = countryName || code
  return `
=== CONTEXTE CLIENT ===
Pays détecté : ${name} (${code}) — Zone livraison : ${zone}

📦 OPTIONS DE LIVRAISON MIAD Express (via DHL) vers ${name} :
• Express DHL : ${shipping.express} — Délai : ${shipping.delaiExpress} (suivi en temps réel inclus)
• Standard économique : ${shipping.standard} — Délai : ${shipping.delaiStandard}
• ⚠️ ${shipping.note}
• Livraison locale (même pays que le vendeur) : ~$3 fixe.
• Le prix final est calculé au poids réel ou volumétrique (selon le plus élevé).
• Un numéro de suivi DHL est envoyé par email dès expédition.
• Garantie MIAD Protection : remboursement complet si problème avec le vendeur.

💳 MÉTHODES DE PAIEMENT DISPONIBLES EN ${code} :
${payments.map(p => `• ${p}`).join('\n')}
• Tous les paiements sont cryptés et sécurisés (SSL + MIAD Protection).
• En cas de paiement Mobile Money : le client reçoit un code USSD ou un lien de confirmation sur son téléphone.
• Délai de remboursement en cas de litige : 48h à 72h.
======================`
}

function filterCatalogProducts(results: CatalogProduct[], category?: string, country?: string): CatalogProduct[] {
  if (category) {
    const cat = category.toLowerCase()
    results = results.filter(p => p.categorySlug.includes(cat) || p.category.toLowerCase().includes(cat))
  }
  if (country) {
    const ctr = country.toLowerCase()
    results = results.filter(p => p.countryCode === ctr || p.country.toLowerCase().includes(ctr))
  }
  return results
}

// Recherche mot-clé directe sur le vrai catalogue WooCommerce (remplace
// l'ancien filtrage sur des données générées localement — voir
// lib/woocommerce.ts `allProducts`). Utilisée en repli si la recherche
// sémantique est indisponible (local dev) ou ne renvoie aucun résultat.
async function keywordSearch(query: string, category?: string, country?: string, limit = 4): Promise<CatalogProduct[]> {
  try {
    const raw = await searchWooProducts(query, limit)
    const results = filterCatalogProducts(raw.map(mapWooProduct), category, country)
    return results.slice(0, Math.min(limit, 6))
  } catch {
    return []
  }
}

// Recherche sémantique (Vectorize + Workers AI bge-m3) — comprend les
// requêtes en langage naturel ("un cadeau pour ma mère qui aime le thé")
// bien mieux qu'un simple filtrage mot-clé. No-op si les bindings AI/
// VECTORIZE sont indisponibles (local dev, voir lib/cloudflare-ai.ts).
async function semanticSearch(query: string, category?: string, country?: string, limit = 4): Promise<CatalogProduct[]> {
  if (!query) return []
  const bindings = await getCloudflareBindings()
  if (!bindings) return []

  try {
    const vector = await embedOne(bindings.ai, query)
    const result = await bindings.vectorize.query(vector, { topK: Math.min(limit, 6) * 4, returnMetadata: 'none' })
    if (!result.matches.length) return []

    const ids = result.matches.map(m => m.id)
    const raw = await fetchWooProductsByIds(ids)
    const order = new Map(ids.map((id, i) => [id, i]))
    raw.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0))

    const results = filterCatalogProducts(raw.map(mapWooProduct), category, country)
    return results.slice(0, Math.min(limit, 6))
  } catch {
    return []
  }
}

async function searchProducts(query: string, category?: string, country?: string, limit = 4): Promise<CatalogProduct[]> {
  const semantic = await semanticSearch(query, category, country, limit)
  if (semantic.length) return semantic
  return keywordSearch(query, category, country, limit)
}

// ─── Groq API (OpenAI-compatible, no SDK needed) ──────────────────────────────

const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama3-70b-8192',
  'llama3-8b-8192',
]

const searchTool = {
  type: 'function',
  function: {
    name: 'search_products',
    description: 'Recherche des produits disponibles sur MIAD Market',
    parameters: {
      type: 'object',
      properties: {
        query:    { type: 'string', description: 'Mots-clés : ex. tissu wax, bijoux, café, sac cuir, beurre karité' },
        category: { type: 'string', description: 'Catégorie : alimentation, mode, artisanat, beaute, maison, electronique' },
        country:  { type: 'string', description: "Code ou nom du pays africain : sn, ci, gh, sénégal, côte d'ivoire..." },
        limit:    { type: 'number', description: 'Nombre de produits (défaut 4, max 6)' },
      },
      required: ['query'],
    },
  },
}

async function groqChat(
  apiKey: string,
  model: string,
  messages: object[],
): Promise<{ content: string | null; toolCall?: { name: string; args: string; id: string } }> {
  const res = await fetch(GROQ_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, tools: [searchTool], tool_choice: 'auto', max_tokens: 1024 }),
  })

  if (!res.ok) {
    const err = await res.text()
    const error = new Error(`Groq ${res.status}: ${err}`) as any
    error.status = res.status
    throw error
  }

  const data = await res.json()
  const choice = data.choices?.[0]?.message
  const toolCall = choice?.tool_calls?.[0]

  if (toolCall?.function?.name) {
    return { content: null, toolCall: { name: toolCall.function.name, args: toolCall.function.arguments, id: toolCall.id } }
  }
  return { content: choice?.content || '' }
}

function isRetryable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.includes('429') || msg.includes('503') || (e as any)?.status === 429 || (e as any)?.status === 503
}

// ─── Rate limiting (in-memory, par instance serverless) ──────────────────────

const RL_MAP = new Map<string, { count: number; reset: number }>()
const RL_LIMIT = 8   // requêtes max
const RL_WINDOW = 60_000 // par minute

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = RL_MAP.get(ip)
  if (!entry || now > entry.reset) {
    RL_MAP.set(ip, { count: 1, reset: now + RL_WINDOW })
    return true
  }
  if (entry.count >= RL_LIMIT) return false
  entry.count++
  return true
}

// ─── API route ────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const { messages, userCountry } = await request.json()

    // Rate limiting
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || request.headers.get('cf-connecting-ip')
      || 'unknown'
    if (!checkRateLimit(ip)) {
      return NextResponse.json({ reply: 'Trop de messages envoyés. Veuillez patienter une minute.', products: [] }, { status: 429 })
    }

    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) {
      console.error('[chat/ai] GROQ_API_KEY manquante dans les variables d\'environnement Vercel')
      return NextResponse.json({ reply: 'L\'assistant est temporairement indisponible.', products: [] }, { status: 200 })
    }

    // Détection pays : body en priorité, sinon header Cloudflare/Vercel automatique
    const cfCountry = request.headers.get('cf-ipcountry') || request.headers.get('x-vercel-ip-country')
    const rawCountry = (typeof userCountry === 'string' && userCountry.length === 2)
      ? userCountry
      : (cfCountry || 'SN')
    const countryCode = rawCountry.toLowerCase()
    const countryName = countries.find(c => c.code === countryCode)?.name || null
    const fullSystemPrompt = `${SYSTEM_PROMPT}\n\n${buildClientContext(countryCode, countryName)}`

    // Build OpenAI-format history — skip leading assistant message (Groq requires user first)
    const history = (messages as { role: string; content: string }[])
      .slice(0, -1)
      .reduce<{ role: string; content: string }[]>((acc, m, i) => {
        if (i === 0 && m.role === 'assistant') return acc
        acc.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })
        return acc
      }, [])

    const lastMessage = messages[messages.length - 1]?.content || ''
    const chatMessages = [
      { role: 'system', content: fullSystemPrompt },
      ...history,
      { role: 'user', content: lastMessage },
    ]

    const preferred = process.env.GROQ_MODEL || GROQ_MODELS[0]
    const modelQueue = [preferred, ...GROQ_MODELS.filter(m => m !== preferred)]

    let reply = ''
    let foundProducts: Awaited<ReturnType<typeof searchProducts>> = []
    let lastError: unknown

    for (const model of modelQueue) {
      try {
        console.log(`[chat/ai] Trying model: ${model}`)
        const first = await groqChat(apiKey, model, chatMessages)

        if (first.toolCall?.name === 'search_products') {
          const args = JSON.parse(first.toolCall.args) as { query: string; category?: string; country?: string; limit?: number }
          foundProducts = await searchProducts(args.query, args.category, args.country || countryCode, args.limit)

          const toolMessages = [
            ...chatMessages,
            { role: 'assistant', content: null, tool_calls: [{ id: first.toolCall.id, type: 'function', function: { name: first.toolCall.name, arguments: first.toolCall.args } }] },
            {
              role: 'tool',
              tool_call_id: first.toolCall.id,
              content: JSON.stringify({
                count: foundProducts.length,
                products: foundProducts.map(p => ({ id: p.id, name: p.name, price: `${p.price} ${p.currency}`, category: p.category, vendor: p.vendor.name, country: p.country, inStock: p.inStock })),
              }),
            },
          ]

          const second = await groqChat(apiKey, model, toolMessages)
          reply = second.content || ''
        } else {
          reply = first.content || ''
        }

        break
      } catch (e) {
        if (isRetryable(e)) {
          const code = (e as any)?.status ?? 'err'
          console.warn(`[chat/ai] ${model} → ${code}, trying next model`)
          lastError = e
          continue
        }
        throw e
      }
    }

    if (!reply) throw lastError ?? new Error('No model responded')

    // Log structuré → visible dans Vercel Logs (filtrable par MIAD_SEARCH)
    console.log(JSON.stringify({
      event: 'MIAD_SEARCH',
      query: lastMessage.slice(0, 200),
      country: countryCode.toUpperCase(),
      ip,
      productsFound: foundProducts.length,
      productNames: foundProducts.map(p => p.name),
      ts: new Date().toISOString(),
    }))

    const products = foundProducts.map(p => ({
      id: p.id, name: p.name, image: p.image, price: p.price, regularPrice: p.regularPrice,
      currency: p.currency, slug: p.slug, vendor: p.vendor.name, vendorSlug: p.vendor.slug,
      country: p.country, countryCode: p.countryCode, inStock: p.inStock, category: p.category, type: p.type,
    }))

    return NextResponse.json({ reply, products })
  } catch (e) {
    console.error('[chat/ai] Erreur:', e instanceof Error ? e.message : e)
    return NextResponse.json({ reply: 'Une erreur est survenue. Veuillez réessayer.', products: [] }, { status: 200 })
  }
}

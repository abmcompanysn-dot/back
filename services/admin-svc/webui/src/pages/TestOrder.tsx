import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'

// TestOrder — page "Commande de test" du back-office (2026-09-05),
// demande explicite du fondateur : tester le VRAI parcours de paiement de
// bout en bout (jusqu'à un vrai paiement réel) sans dépendre du catalogue
// ni du calcul automatique de livraison — l'admin saisit lui-même le nom
// des articles, leur prix (en FCFA — converti en USD automatiquement,
// comme tout le catalogue), et le montant de livraison.
//
// Révisé le même jour, deuxième version : au lieu de créer la commande
// directement depuis le back-office et d'initier le paiement ici,
// construit un PANIER PARTAGÉ (même mécanisme que "partager mon panier"
// côté client, /api/cart-share) et redirige vers le vrai checkout du
// site public (miadmarket.ca/?cart=<id>) — le fondateur choisit ensuite
// le moyen de paiement exactement comme un vrai client, sur la vraie
// page de paiement, pas un flux séparé dans le back-office.
//
// Le vendor_id saisi est résolu en un vrai objet boutique (GET
// /admin/api/vendors/{id}) pour construire un WooProduct cohérent —
// jamais un objet vendeur vide/inventé, qui casserait l'affichage du
// panier ou la répartition commission côté order-svc.

interface TestLine {
  vendorId: string
  name: string
  quantity: string
  unitPriceFcfa: string
}

function emptyLine(): TestLine {
  return { vendorId: '', name: '', quantity: '1', unitPriceFcfa: '' }
}

interface VendorInfo {
  id: string
  name: string
  slug: string
  logo?: string
  country?: string
  countryCode?: string
}

export function TestOrder() {
  const [customerEmail, setCustomerEmail] = useState('')
  const [lines, setLines] = useState<TestLine[]>([emptyLine()])
  const [forcedShippingFcfa, setForcedShippingFcfa] = useState('')
  const [xofRate, setXofRate] = useState<number | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [shareUrl, setShareUrl] = useState<string | null>(null)

  // Taux XOF (FCFA) — même source que la page Devises (shipping-svc, via
  // admin-svc). Le catalogue MIAD Market est en USD réel — jamais de
  // conversion codée en dur ici (voir CLAUDE.md frontend, section "Prix
  // des produits").
  useEffect(() => {
    api.get<{ rates: Array<{ currency: string; rate_per_usd: number }> }>('/admin/api/exchange-rates')
      .then((data) => {
        const xof = data.rates?.find((r) => r.currency === 'XOF')
        if (xof) setXofRate(xof.rate_per_usd)
      })
      .catch(() => { /* le formulaire affiche un message si le taux manque au moment de soumettre */ })
  }, [])

  function updateLine(i: number, patch: Partial<TestLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }
  function addLine() {
    setLines((prev) => [...prev, emptyLine()])
  }
  function removeLine(i: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))
  }

  async function resolveVendor(vendorId: string): Promise<VendorInfo> {
    const v = await api.get<any>(`/admin/api/vendors/${vendorId}`)
    return {
      id: String(v.id ?? vendorId),
      name: v.store_name || v.name || `Boutique #${vendorId}`,
      slug: v.slug || '',
      logo: v.gravatar || v.logo_url || '',
      country: v.address?.country || v.country || '',
      countryCode: v.address?.country || v.country || '',
    }
  }

  async function submit() {
    setMsg(null)
    setShareUrl(null)

    if (!customerEmail.trim()) {
      setMsg({ kind: 'err', text: 'Email du client obligatoire (pour info seulement — le panier partagé ne demande pas de connexion, le client se connecte lui-même sur le checkout).' })
    }
    if (xofRate === null) {
      setMsg({ kind: 'err', text: 'Taux FCFA pas encore chargé — réessaie dans un instant.' })
      return
    }
    const parsed: Array<{ vendorId: string; name: string; quantity: number; unitPriceUsd: number }> = []
    for (const l of lines) {
      const quantity = parseInt(l.quantity, 10)
      const priceFcfa = parseFloat(l.unitPriceFcfa)
      if (!l.vendorId.trim() || !l.name.trim() || !(quantity >= 1) || !(priceFcfa > 0)) {
        setMsg({ kind: 'err', text: 'Chaque ligne doit avoir : boutique (ID), nom, quantité ≥ 1, prix en FCFA > 0.' })
        return
      }
      parsed.push({ vendorId: l.vendorId.trim(), name: l.name.trim(), quantity, unitPriceUsd: priceFcfa / xofRate })
    }
    const distinctVendors = new Set(parsed.map((l) => l.vendorId))
    if (distinctVendors.size > 1) {
      setMsg({ kind: 'err', text: 'Une seule boutique à la fois pour ce test (simplifie la répartition par commission).' })
      return
    }

    setSubmitting(true)
    try {
      const vendor = await resolveVendor(parsed[0].vendorId)

      // Format WooProduct minimal mais cohérent (voir toCartProduct côté
      // frontend public) — un "produit" fictif par ligne, id négatif pour
      // ne jamais collisionner avec un vrai product_id du catalogue.
      const items = parsed.map((l, i) => ({
        product: {
          id: -1000 - i, // jamais un vrai produit du catalogue
          name: l.name,
          slug: `test-${Date.now()}-${i}`,
          price: Math.round(l.unitPriceUsd * 100) / 100,
          regularPrice: Math.round(l.unitPriceUsd * 100) / 100,
          currency: '$',
          type: 'simple',
          image: '',
          category: '',
          categories: [],
          categorySlug: '',
          vendor: { id: vendor.id, name: vendor.name, slug: vendor.slug, logo: vendor.logo, country: vendor.country, countryCode: vendor.countryCode },
          country: vendor.country,
          countryCode: vendor.countryCode,
          stock: 999,
          inStock: true,
          description: '',
          lang: 'fr',
        },
        quantity: l.quantity,
      }))

      // forcedShippingUsd transmis DANS le panier partagé (pas par l'URL) —
      // MiadMarketClient.tsx retire ?cart=<id> de l'URL dès la
      // restauration, un paramètre porté par l'URL n'atteindrait jamais
      // CheckoutPage.
      const forcedShippingUsd = forcedShippingFcfa ? parseFloat(forcedShippingFcfa) / xofRate : 0

      // /api/cart-share vit sur le site public (Next.js), pas sur ce
      // back-office (admin-svc, autre origine) — appelé en absolu.
      const shareRes = await fetch('https://miadmarket.ca/api/cart-share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, forcedShippingUsd: forcedShippingUsd > 0 ? forcedShippingUsd : undefined }),
      })
      if (!shareRes.ok) throw new Error('Échec de la création du panier partagé')
      const { id } = await shareRes.json()

      // v=checkout n'existe pas comme vue accessible directement par URL
      // (voir app/page.tsx — seuls product/vendor/category le sont) : le
      // lien restaure le panier sur l'accueil (comme "partager mon panier"
      // pour un vrai client), puis il suffit de cliquer sur le panier pour
      // aller au checkout.
      const url = `https://miadmarket.ca/?cart=${id}`
      setShareUrl(url)
      setMsg({ kind: 'ok', text: 'Panier de test créé — ouvre le lien, le panier se restaure automatiquement, puis clique sur le panier pour aller au vrai checkout.' })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : (e instanceof Error ? e.message : 'Échec de la création') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Commande de test</h2>
          <p className="subtitle">
            Prépare un panier avec des articles et un prix que tu choisis toi-même (en FCFA),
            puis ouvre un lien qui t'amène directement sur le VRAI checkout du site — tu y
            choisis le moyen de paiement et tu payes comme un vrai client. Utile pour tester le
            parcours de bout en bout sans dépendre du catalogue.
          </p>
        </div>
      </div>

      {msg && (
        <div className={`alert ${msg.kind === 'ok' ? 'alert-green' : 'alert-red'}`} style={{ marginBottom: 16 }}>
          {msg.text}
        </div>
      )}

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div>
          <h3 style={{ marginBottom: 8 }}>Client (informatif)</h3>
          <input
            placeholder="Email du client (pour t'y retrouver — pas transmis au panier)"
            style={{ width: 340 }}
            value={customerEmail}
            onChange={(e) => setCustomerEmail(e.target.value)}
          />
          <p className="subtitle" style={{ fontSize: 12, marginTop: 4 }}>
            Le lien ci-dessous mène au checkout public : la personne qui l'ouvre se connecte
            (ou crée un compte) elle-même, comme n'importe quel client.
          </p>
        </div>

        <div>
          <h3 style={{ marginBottom: 8 }}>Articles (prix en FCFA)</h3>
          {lines.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
              <input
                placeholder="ID boutique (vendor_id)"
                style={{ width: 160 }}
                value={l.vendorId}
                onChange={(e) => updateLine(i, { vendorId: e.target.value })}
              />
              <input
                placeholder="Nom de l'article"
                style={{ width: 220 }}
                value={l.name}
                onChange={(e) => updateLine(i, { name: e.target.value })}
              />
              <input
                type="number" min="1" placeholder="Qté"
                style={{ width: 80 }}
                value={l.quantity}
                onChange={(e) => updateLine(i, { quantity: e.target.value })}
              />
              <input
                type="number" step="1" min="0" placeholder="Prix (FCFA)"
                style={{ width: 140 }}
                value={l.unitPriceFcfa}
                onChange={(e) => updateLine(i, { unitPriceFcfa: e.target.value })}
              />
              {xofRate && l.unitPriceFcfa && (
                <span className="subtitle" style={{ fontSize: 12 }}>
                  ≈ {(parseFloat(l.unitPriceFcfa) / xofRate).toFixed(2)} $
                </span>
              )}
              <button className="btn btn-sm" onClick={() => removeLine(i)} disabled={lines.length === 1}>
                Retirer
              </button>
            </div>
          ))}
          <button className="btn btn-sm" onClick={addLine}>+ Ajouter un article</button>
        </div>

        <div>
          <h3 style={{ marginBottom: 8 }}>Livraison</h3>
          <input
            type="number" step="1" min="0"
            placeholder="Montant de livraison forcé (FCFA) — laisser vide pour le calcul normal"
            style={{ width: 380 }}
            value={forcedShippingFcfa}
            onChange={(e) => setForcedShippingFcfa(e.target.value)}
          />
          {xofRate && forcedShippingFcfa && (
            <p className="subtitle" style={{ fontSize: 12, marginTop: 4 }}>
              ≈ {(parseFloat(forcedShippingFcfa) / xofRate).toFixed(2)} $
            </p>
          )}
        </div>

        <div>
          <button className="btn btn-primary" onClick={submit} disabled={submitting || xofRate === null}>
            {submitting ? 'Préparation…' : 'Créer le panier de test'}
          </button>
          {xofRate === null && <p className="subtitle" style={{ fontSize: 12 }}>Chargement du taux FCFA…</p>}
        </div>

        {shareUrl && (
          <div style={{ paddingTop: 12, borderTop: '1px solid var(--border, #e5e7eb)' }}>
            <p><strong>Lien vers le vrai checkout :</strong></p>
            <p>
              <a href={shareUrl} target="_blank" rel="noreferrer">{shareUrl}</a>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { api, ApiError } from '../lib/api'

// TestOrder — page "Commande de test" du back-office (2026-09-05),
// demande explicite du fondateur : tester le VRAI parcours de paiement de
// bout en bout (jusqu'à un vrai paiement réel s'il le choisit) sans
// dépendre du catalogue ni du calcul automatique de livraison — l'admin
// saisit lui-même le nom des articles, leur prix, et le montant de
// livraison. Choix explicite du fondateur : la commande créée est une
// commande RÉELLE normale (pas de marquage "test", pas d'exclusion des
// statistiques) — voir POST /admin/api/test-order (admin-svc,
// createTestOrder) qui enchaîne création de commande + initiation du
// paiement, exactement comme le checkout normal du site.
//
// Le client doit déjà EXISTER (résolu par email) — jamais de compte
// fabriqué à la volée, pour ne jamais polluer la base de vrais clients.

interface TestLine {
  vendorId: string
  name: string
  quantity: string
  unitPriceUsd: string
}

function emptyLine(): TestLine {
  return { vendorId: '', name: '', quantity: '1', unitPriceUsd: '' }
}

interface Result {
  order_id: number
  customer_id: number
  payment: {
    redirect_url?: string
    client_secret?: string
    payment?: { provider_ref?: string }
  } | null
}

export function TestOrder() {
  const [customerEmail, setCustomerEmail] = useState('')
  const [lines, setLines] = useState<TestLine[]>([emptyLine()])
  const [forcedShippingUsd, setForcedShippingUsd] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'stripe' | 'paydunya' | 'pawapay'>('pawapay')

  // Adresse minimale — suffisante pour que shipping_address soit un JSON
  // valide côté order-svc (destCountryFrom() n'a besoin que de "country").
  const [country, setCountry] = useState('SN')
  const [city, setCity] = useState('Dakar')
  const [address1, setAddress1] = useState('Adresse de test')
  const [phone, setPhone] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [result, setResult] = useState<Result | null>(null)

  function updateLine(i: number, patch: Partial<TestLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }
  function addLine() {
    setLines((prev) => [...prev, emptyLine()])
  }
  function removeLine(i: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))
  }

  async function submit() {
    setMsg(null)
    setResult(null)

    if (!customerEmail.trim()) {
      setMsg({ kind: 'err', text: 'Email du client obligatoire (le client doit déjà exister sur le site).' })
      return
    }
    const parsedLines = []
    for (const l of lines) {
      const vendorId = parseInt(l.vendorId, 10)
      const quantity = parseInt(l.quantity, 10)
      const unitPrice = parseFloat(l.unitPriceUsd)
      if (!vendorId || !l.name.trim() || !(quantity >= 1) || !(unitPrice > 0)) {
        setMsg({ kind: 'err', text: 'Chaque ligne doit avoir : boutique (ID), nom, quantité ≥ 1, prix > 0.' })
        return
      }
      parsedLines.push({
        vendor_id: vendorId,
        product_id: 0,
        name: l.name.trim(),
        quantity,
        unit_price_usd: unitPrice,
      })
    }
    // Toutes les lignes doivent porter le même vendor_id — le montant de
    // livraison forcé ne s'applique qu'à la 1ère sous-commande créée côté
    // order-svc (voir son commentaire) : avec plusieurs boutiques dans un
    // même test, seule une recevrait le montant forcé, ce qui prêterait à
    // confusion. Gardé simple : un vendeur à la fois pour cet outil.
    const distinctVendors = new Set(parsedLines.map((l) => l.vendor_id))
    if (distinctVendors.size > 1) {
      setMsg({ kind: 'err', text: 'Une seule boutique à la fois pour ce test (le montant de livraison forcé ne s’applique qu’à une commande).' })
      return
    }

    setSubmitting(true)
    try {
      const data = await api.post<Result>('/admin/api/test-order', {
        customer_email: customerEmail.trim(),
        lines: parsedLines,
        shipping_address: { country, city, address_1: address1, phone },
        billing_address: { country, city, address_1: address1, phone },
        forced_shipping_usd: forcedShippingUsd ? parseFloat(forcedShippingUsd) : 0,
        payment_method: paymentMethod,
      })
      setResult(data)
      setMsg({ kind: 'ok', text: `Commande #${data.order_id} créée et paiement initié.` })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : 'Échec de la création' })
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
            Crée une VRAIE commande (comme un vrai achat sur le site) pour un client déjà
            existant, avec des articles et un montant de livraison que tu saisis toi-même —
            utile pour tester le parcours de paiement de bout en bout sans dépendre du
            catalogue. Le paiement se termine ensuite normalement (redirection, ou le client
            reçoit le lien).
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
          <h3 style={{ marginBottom: 8 }}>Client</h3>
          <input
            placeholder="Email du client (doit déjà avoir un compte)"
            style={{ width: 340 }}
            value={customerEmail}
            onChange={(e) => setCustomerEmail(e.target.value)}
          />
        </div>

        <div>
          <h3 style={{ marginBottom: 8 }}>Articles</h3>
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
                type="number" step="0.01" min="0" placeholder="Prix (USD)"
                style={{ width: 120 }}
                value={l.unitPriceUsd}
                onChange={(e) => updateLine(i, { unitPriceUsd: e.target.value })}
              />
              <button className="btn btn-sm" onClick={() => removeLine(i)} disabled={lines.length === 1}>
                Retirer
              </button>
            </div>
          ))}
          <button className="btn btn-sm" onClick={addLine}>+ Ajouter un article</button>
        </div>

        <div>
          <h3 style={{ marginBottom: 8 }}>Livraison</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <input placeholder="Pays (ex. SN)" style={{ width: 100 }} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} maxLength={2} />
            <input placeholder="Ville" style={{ width: 140 }} value={city} onChange={(e) => setCity(e.target.value)} />
            <input placeholder="Adresse" style={{ width: 220 }} value={address1} onChange={(e) => setAddress1(e.target.value)} />
            <input placeholder="Téléphone (mobile money)" style={{ width: 180 }} value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <input
            type="number" step="0.01" min="0"
            placeholder="Montant de livraison forcé (USD) — laisser vide pour 0"
            style={{ width: 320 }}
            value={forcedShippingUsd}
            onChange={(e) => setForcedShippingUsd(e.target.value)}
          />
        </div>

        <div>
          <h3 style={{ marginBottom: 8 }}>Paiement</h3>
          <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)} style={{ width: 200 }}>
            <option value="pawapay">Mobile Money (PawaPay)</option>
            <option value="paydunya">Mobile Money (PayDunya)</option>
            <option value="stripe">Carte bancaire (Stripe)</option>
          </select>
        </div>

        <div>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Création…' : 'Créer la commande et lancer le paiement'}
          </button>
        </div>

        {result && (
          <div style={{ paddingTop: 12, borderTop: '1px solid var(--border, #e5e7eb)' }}>
            <p><strong>Commande créée : #{result.order_id}</strong> (client #{result.customer_id})</p>
            {result.payment?.redirect_url && (
              <p>
                Lien de paiement :{' '}
                <a href={result.payment.redirect_url} target="_blank" rel="noreferrer">
                  {result.payment.redirect_url}
                </a>
              </p>
            )}
            {result.payment?.client_secret && (
              <p className="subtitle">Paiement Stripe initié (client_secret reçu) — à finaliser côté client.</p>
            )}
            {!result.payment?.redirect_url && !result.payment?.client_secret && (
              <p className="subtitle">Paiement initié — voir la commande dans Commandes pour son statut.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

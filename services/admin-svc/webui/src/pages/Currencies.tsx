import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'

// Currencies — page Devises du back-office (2026-09-03). Édite la config
// UNIQUE des taux de change (shipping-svc /exchange-rates) que le
// frontend public consomme via /api/exchange-rates pour AFFICHER les prix
// dans la devise choisie par le visiteur, et que payment-svc consomme en
// interne pour CONVERTIR les montants au moment du paiement mobile money
// — même source pour les deux, plus de désynchronisation possible.
//
// Rafraîchi automatiquement chaque jour depuis une API gratuite
// (open.er-api.com, voir shipping-svc/exchange-rates-refresh.go) — cette
// page permet de forcer une valeur manuelle si besoin (ex. taux parallèle
// différent du taux officiel), qui sera écrasée au prochain rafraîchissement
// automatique sauf si la devise est retirée de la liste suivie côté code.

interface Rate {
  currency: string
  rate_per_usd: number
  updated_at: string
}

// Libellés lisibles — la table peut contenir n'importe quelle devise
// suivie côté backend (voir trackedCurrencies dans
// exchange-rates-refresh.go) ; repli sur le code brut si absent d'ici.
const LABELS: Record<string, string> = {
  XOF: 'Franc CFA Ouest-Africain (Sénégal, Côte d’Ivoire, Bénin…)',
  XAF: 'Franc CFA Central (Cameroun, Gabon…)',
  CAD: 'Dollar canadien',
  GHS: 'Cedi ghanéen',
  KES: 'Shilling kenyan',
  NGN: 'Naira nigérian',
  TZS: 'Shilling tanzanien',
  UGX: 'Shilling ougandais',
  RWF: 'Franc rwandais',
  ZMW: 'Kwacha zambien',
  MWK: 'Kwacha malawite',
  MZN: 'Metical mozambicain',
  CDF: 'Franc congolais',
  SLE: 'Leone sierra-léonais',
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}

export function Currencies() {
  const [rates, setRates] = useState<Rate[]>([])
  const [loading, setLoading] = useState(true)
  const [savingCurrency, setSavingCurrency] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})

  // Nouvelle devise (pas encore dans la table)
  const [newCode, setNewCode] = useState('')
  const [newRate, setNewRate] = useState('')

  async function load() {
    setLoading(true)
    try {
      const data = await api.get<{ rates: Rate[] }>('/admin/api/exchange-rates')
      const sorted = (data.rates || []).slice().sort((a, b) => a.currency.localeCompare(b.currency))
      setRates(sorted)
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : 'Chargement impossible' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function saveRate(currency: string, rateStr: string) {
    const rate = parseFloat(rateStr)
    if (!(rate > 0)) {
      setMsg({ kind: 'err', text: 'Le taux doit être un nombre positif.' })
      return
    }
    setSavingCurrency(currency)
    setMsg(null)
    try {
      await api.post('/admin/api/exchange-rates', { currency, rate_per_usd: rate })
      await load()
      setEdits((e) => { const n = { ...e }; delete n[currency]; return n })
      setMsg({ kind: 'ok', text: `Taux ${currency} enregistré. Le site s’aligne dans les 5 min (cache).` })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : 'Enregistrement impossible' })
    } finally {
      setSavingCurrency(null)
    }
  }

  async function addCurrency() {
    const code = newCode.trim().toUpperCase()
    const rate = parseFloat(newRate)
    if (!/^[A-Z]{3}$/.test(code)) {
      setMsg({ kind: 'err', text: 'Code devise invalide (3 lettres, ex. XOF).' })
      return
    }
    if (!(rate > 0)) {
      setMsg({ kind: 'err', text: 'Le taux doit être un nombre positif.' })
      return
    }
    await saveRate(code, String(rate))
    setNewCode('')
    setNewRate('')
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Devises</h2>
          <p className="subtitle">
            Taux de change utilisés à la fois pour l’affichage des prix sur le site et pour
            les paiements mobile money — une seule source, rafraîchie automatiquement chaque
            jour. Modifier un taux ici l’écrase manuellement jusqu’au prochain rafraîchissement.
          </p>
        </div>
      </div>

      {msg && (
        <div className={`alert ${msg.kind === 'ok' ? 'alert-green' : 'alert-red'}`} style={{ marginBottom: 16 }}>
          {msg.text}
        </div>
      )}

      {loading && <p className="subtitle">Chargement…</p>}

      {!loading && (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Devise</th>
                <th>1 USD =</th>
                <th>Dernière mise à jour</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rates.map((r) => {
                const editValue = edits[r.currency] ?? String(r.rate_per_usd)
                const dirty = edits[r.currency] !== undefined && edits[r.currency] !== String(r.rate_per_usd)
                return (
                  <tr key={r.currency}>
                    <td>
                      <strong>{r.currency}</strong>
                      <div className="subtitle" style={{ fontSize: 12 }}>{LABELS[r.currency] || ''}</div>
                    </td>
                    <td>
                      <input
                        type="number" step="0.01" min="0"
                        style={{ width: 140 }}
                        value={editValue}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [r.currency]: e.target.value }))}
                      />
                    </td>
                    <td className="subtitle">{formatDate(r.updated_at)}</td>
                    <td>
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={!dirty || savingCurrency === r.currency}
                        onClick={() => saveRate(r.currency, editValue)}
                      >
                        {savingCurrency === r.currency ? 'Enregistrement…' : 'Enregistrer'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border, #e5e7eb)' }}>
            <h3 style={{ marginBottom: 8 }}>Ajouter une devise</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                placeholder="Code (ex. XOF)"
                style={{ width: 120 }}
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                maxLength={3}
              />
              <input
                type="number" step="0.01" min="0"
                placeholder="1 USD = ?"
                style={{ width: 140 }}
                value={newRate}
                onChange={(e) => setNewRate(e.target.value)}
              />
              <button className="btn btn-primary" onClick={addCurrency} disabled={savingCurrency !== null}>
                Ajouter
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

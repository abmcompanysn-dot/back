import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api } from '../lib/api'

// PaymentRouting — écran admin "Mobile Money" (2026-08-28) : liste,
// pays par pays et opérateur par opérateur, ce que chaque agrégateur
// (PawaPay/PayDunya) supporte, et permet de choisir MANUELLEMENT lequel
// des deux traite un opérateur donné quand les deux le supportent.
// Décision fondateur explicite : pas de logique automatique cachée.
//
// Une ligne sans override utilise le défaut global (le seul agrégateur
// actif en Configuration → Paiements) — voir payment-routing.go côté Go
// pour la logique de résolution complète.

interface RouteRow {
  country_iso2: string
  country_name: string
  operator_label: string
  pawapay_code: string | null
  pawapay_auth_type: string | null
  paydunya_code: string | null
  paydunya_behavior: string | null
  active_aggregator: 'pawapay' | 'paydunya'
  is_override: boolean
}

function supportBadge(supported: boolean, detail?: string | null) {
  if (!supported) return <span className="badge" style={{ opacity: 0.4 }}>—</span>
  return (
    <span className="badge badge-green" title={detail || undefined}>
      Oui{detail ? ` (${detail})` : ''}
    </span>
  )
}

export function PaymentRouting() {
  const [rows, setRows] = useState<RouteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null) // clé de la ligne en cours de sauvegarde

  function load() {
    setLoading(true)
    setError(null)
    api
      .get<{ routes: RouteRow[] }>('/admin/api/payments/routing')
      .then((body) => {
        const sorted = [...(body.routes || [])].sort((a, b) =>
          a.country_name.localeCompare(b.country_name) || a.operator_label.localeCompare(b.operator_label)
        )
        setRows(sorted)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'échec du chargement'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  async function setAggregator(row: RouteRow, aggregator: 'pawapay' | 'paydunya') {
    const key = row.country_iso2 + '|' + row.operator_label
    setSaving(key)
    try {
      await api.put('/admin/api/payments/routing', {
        country_iso2: row.country_iso2,
        pawapay_code: row.pawapay_code || '',
        paydunya_code: row.paydunya_code || '',
        aggregator,
      })
      load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de l’enregistrement')
    } finally {
      setSaving(null)
    }
  }

  async function resetToDefault(row: RouteRow) {
    const key = row.country_iso2 + '|' + row.operator_label
    setSaving(key)
    try {
      await api.delete('/admin/api/payments/routing', {
        country_iso2: row.country_iso2,
        pawapay_code: row.pawapay_code || '',
        paydunya_code: row.paydunya_code || '',
      })
      load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de la réinitialisation')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Mobile Money — Routage par opérateur</h2>
          <p className="subtitle">
            Pour chaque pays/opérateur, choisissez quel agrégateur (PawaPay ou PayDunya) traite le
            paiement — utile seulement quand les deux le supportent. Sans choix explicite, le seul
            agrégateur actif en <Link to="/admin/configuration">Configuration → Paiements</Link> est
            utilisé par défaut.
          </p>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      {loading ? (
        <p className="hint">Chargement…</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Pays</th>
                <th>Opérateur</th>
                <th>PawaPay</th>
                <th>PayDunya</th>
                <th>Agrégateur actif</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const key = row.country_iso2 + '|' + row.operator_label
                const bothSupported = !!row.pawapay_code && !!row.paydunya_code
                return (
                  <tr key={key}>
                    <td>{row.country_name}</td>
                    <td>{row.operator_label}</td>
                    <td>{supportBadge(!!row.pawapay_code, row.pawapay_auth_type)}</td>
                    <td>{supportBadge(!!row.paydunya_code, row.paydunya_behavior)}</td>
                    <td>
                      {bothSupported ? (
                        <select
                          value={row.active_aggregator}
                          disabled={saving === key}
                          onChange={(e) => setAggregator(row, e.target.value as 'pawapay' | 'paydunya')}
                          style={{ width: 130 }}
                        >
                          <option value="pawapay">PawaPay</option>
                          <option value="paydunya">PayDunya</option>
                        </select>
                      ) : (
                        <span className="badge">{row.active_aggregator === 'pawapay' ? 'PawaPay' : 'PayDunya'}</span>
                      )}
                    </td>
                    <td>
                      {row.is_override && (
                        <button className="btn-link" disabled={saving === key} onClick={() => resetToDefault(row)}>
                          Réinitialiser
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length === 0 && <p className="hint">Aucun opérateur trouvé.</p>}
        </div>
      )}
    </div>
  )
}

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
  operator_enabled: boolean
  country_enabled: boolean
}

// Logos réels fournis par le fondateur (2026-08-28), même dossier que le
// checkout public (frontend/public/logo/mobile-money/, dupliqué ici pour
// le webui admin) — clé = premier mot du libellé en majuscules, même
// convention que normalizeOperatorLabel côté Go.
const OPERATOR_LOGOS: Record<string, string> = {
  ORANGE: '/logo/mobile-money/orange-money.png',
  WAVE: '/logo/mobile-money/wave.png',
  MTN: '/logo/mobile-money/mtn-momo.png',
  MOOV: '/logo/mobile-money/moov-money.png',
  VODACOM: '/logo/mobile-money/vodacom.png',
  AIRTEL: '/logo/mobile-money/at-money.png',
  MPESA: '/logo/mobile-money/mpesa.png',
  HALOPESA: '/logo/mobile-money/halopesa.png',
  ZAMTEL: '/logo/mobile-money/zamtel.png',
  TNM: '/logo/mobile-money/tnm.png',
  MOVITEL: '/logo/mobile-money/movitel.png',
  DJAMO: '/logo/mobile-money/djamo.png',
  CELTIIS: '/logo/mobile-money/celtiis-cash.jpg',
  MIXX: '/logo/mobile-money/mixx-yas.png',
  YAS: '/logo/mobile-money/mixx-yas.png',
  TELECEL: '/logo/mobile-money/telecel-cash.png',
  EXPRESSO: '/logo/mobile-money/expresso.png',
  FREE: '/logo/mobile-money/orange-money.png', // pas de logo dédié fourni — repli texte géré par logoFor()
}

function logoFor(operatorLabel: string): string | undefined {
  const key = operatorLabel.split(/\s+/)[0]?.toUpperCase()
  return key ? OPERATOR_LOGOS[key] : undefined
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

  async function toggleOperator(row: RouteRow, enabled: boolean) {
    const key = row.country_iso2 + '|' + row.operator_label
    setSaving(key)
    try {
      await api.put('/admin/api/payments/operator-enabled', {
        country_iso2: row.country_iso2,
        operator_label: row.operator_label,
        enabled,
      })
      load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec du changement')
    } finally {
      setSaving(null)
    }
  }

  async function toggleCountry(countryIso2: string, enabled: boolean) {
    setSaving(countryIso2)
    try {
      await api.put('/admin/api/payments/country-enabled', { country_iso2: countryIso2, enabled })
      load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec du changement')
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
        <>
          <div className="form-card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginTop: 0, fontSize: 14 }}>Pays proposés au checkout</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              Décocher un pays le retire entièrement du sélecteur mobile money du checkout, quel que
              soit l'agrégateur.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {[...new Map(rows.map((r) => [r.country_iso2, r])).values()]
                .sort((a, b) => a.country_name.localeCompare(b.country_name))
                .map((r) => (
                  <label
                    key={r.country_iso2}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: saving === r.country_iso2 ? 'default' : 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={r.country_enabled}
                      disabled={saving === r.country_iso2}
                      onChange={(e) => toggleCountry(r.country_iso2, e.target.checked)}
                    />
                    {r.country_name}
                  </label>
                ))}
            </div>
          </div>
          <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Pays</th>
                <th>Opérateur</th>
                <th>PawaPay</th>
                <th>PayDunya</th>
                <th>Agrégateur actif</th>
                <th>Proposé au checkout</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const key = row.country_iso2 + '|' + row.operator_label
                const bothSupported = !!row.pawapay_code && !!row.paydunya_code
                const logo = logoFor(row.operator_label)
                const rowDisabled = !row.operator_enabled || !row.country_enabled
                return (
                  <tr key={key} style={rowDisabled ? { opacity: 0.5 } : undefined}>
                    <td>
                      {row.country_name}
                      {!row.country_enabled && <span className="badge" style={{ marginLeft: 6 }}>Pays désactivé</span>}
                    </td>
                    <td>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {logo && (
                          <img src={logo} alt="" style={{ width: 24, height: 24, objectFit: 'contain', borderRadius: 4 }} />
                        )}
                        {row.operator_label}
                      </span>
                    </td>
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
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: saving === key ? 'default' : 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={row.operator_enabled}
                          disabled={saving === key || !row.country_enabled}
                          onChange={(e) => toggleOperator(row, e.target.checked)}
                        />
                        {row.operator_enabled ? 'Actif' : 'Masqué'}
                      </label>
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
        </>
      )}
    </div>
  )
}

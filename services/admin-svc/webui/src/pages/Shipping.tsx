import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'

// Shipping — page Livraison du back-office. Édite la config UNIQUE de
// livraison (shipping-svc /shipping/config) que le frontend consomme via
// /api/shipping-rates. Fin du calcul en dur : useShippingRates.ts,
// app/page.tsx et CheckoutPage lisaient auparavant des constantes figées.
//
// Deux blocs :
//  1. Tarifs internationaux par zone continentale (standard / express) +
//     3 scalaires (tarif local même-pays, tarif Afrique↔Afrique, seuil
//     livraison offerte).
//  2. Grille livraison nationale Sénégal par distance (domestic_tiers) +
//     le repli utilisé quand le calcul par distance échoue.

const ZONES: { code: string; label: string }[] = [
  { code: 'AF', label: 'Afrique' },
  { code: 'EU', label: 'Europe' },
  { code: 'NA', label: 'Amérique du Nord' },
  { code: 'SA', label: 'Amérique du Sud' },
  { code: 'AS', label: 'Asie / Moyen-Orient' },
  { code: 'OC', label: 'Océanie' },
]

interface ShippingConfig {
  local: number
  zone_africa: number
  free_threshold: number
  domestic_fallback_usd: number
  zones: Record<string, { standard: number; express: number }>
}

interface DomesticTier {
  id: number
  max_distance_km: number
  price_usd: number
}

export function Shipping() {
  const [cfg, setCfg] = useState<ShippingConfig | null>(null)
  const [tiers, setTiers] = useState<DomesticTier[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // Nouvelle tranche à ajouter
  const [newTier, setNewTier] = useState({ max_distance_km: '', price_usd: '' })

  async function load() {
    setLoading(true)
    try {
      const [c, t] = await Promise.all([
        api.get<ShippingConfig>('/admin/api/shipping-config'),
        api.get<{ tiers: DomesticTier[] }>('/admin/api/domestic-tiers'),
      ])
      setCfg(c)
      setTiers((t.tiers || []).slice().sort((a, b) => a.max_distance_km - b.max_distance_km))
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : 'Chargement impossible' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  function setScalar(key: keyof ShippingConfig, value: number) {
    setCfg((c) => (c ? { ...c, [key]: value } : c))
  }
  function setZone(code: string, field: 'standard' | 'express', value: number) {
    setCfg((c) =>
      c ? { ...c, zones: { ...c.zones, [code]: { ...c.zones[code], [field]: value } } } : c
    )
  }

  async function saveConfig() {
    if (!cfg) return
    setSaving(true)
    setMsg(null)
    try {
      await api.post('/admin/api/shipping-config', {
        local: cfg.local,
        zone_africa: cfg.zone_africa,
        free_threshold: cfg.free_threshold,
        domestic_fallback_usd: cfg.domestic_fallback_usd,
        zones: cfg.zones,
      })
      setMsg({ kind: 'ok', text: 'Tarifs enregistrés. Le checkout s’aligne dans les 5 min (cache).' })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : 'Enregistrement impossible' })
    } finally {
      setSaving(false)
    }
  }

  async function addTier() {
    const km = parseFloat(newTier.max_distance_km)
    const price = parseFloat(newTier.price_usd)
    if (!(km > 0) || !(price >= 0)) {
      setMsg({ kind: 'err', text: 'Distance (> 0) et prix (≥ 0) requis pour la tranche.' })
      return
    }
    setSaving(true)
    setMsg(null)
    try {
      await api.post('/admin/api/domestic-tiers', { max_distance_km: km, price_usd: price })
      setNewTier({ max_distance_km: '', price_usd: '' })
      await load()
      setMsg({ kind: 'ok', text: 'Tranche ajoutée.' })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : 'Ajout impossible' })
    } finally {
      setSaving(false)
    }
  }

  async function removeTier(id: number) {
    setSaving(true)
    setMsg(null)
    try {
      await api.delete(`/admin/api/domestic-tiers/${id}`)
      await load()
      setMsg({ kind: 'ok', text: 'Tranche supprimée.' })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : 'Suppression impossible' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Livraison</h2>
          <p className="subtitle">
            Tarifs internationaux par zone + livraison nationale Sénégal par distance.
            Source unique du checkout (fin des tarifs codés en dur).
          </p>
        </div>
        <button className="btn btn-primary" onClick={saveConfig} disabled={saving || loading || !cfg}>
          {saving ? 'Enregistrement…' : 'Enregistrer les tarifs'}
        </button>
      </div>

      {msg && (
        <div
          className={`alert ${msg.kind === 'ok' ? 'alert-green' : 'alert-red'}`}
          style={{ marginBottom: 16 }}
        >
          {msg.text}
        </div>
      )}

      {loading && <p className="subtitle">Chargement…</p>}

      {cfg && (
        <>
          {/* ── Scalaires ─────────────────────────────────────────── */}
          <div className="card" style={{ marginBottom: 20 }}>
            <h3>Règles générales</h3>
            <div className="form-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 16, marginTop: 12 }}>
              <label>
                <span>Tarif local (même pays), $</span>
                <input
                  type="number" step="0.01" min="0"
                  value={cfg.local}
                  onChange={(e) => setScalar('local', parseFloat(e.target.value) || 0)}
                />
              </label>
              <label>
                <span>Afrique → Afrique, $</span>
                <input
                  type="number" step="0.01" min="0"
                  value={cfg.zone_africa}
                  onChange={(e) => setScalar('zone_africa', parseFloat(e.target.value) || 0)}
                />
              </label>
              <label>
                <span>Livraison offerte dès un sous-total de $ (0 = jamais)</span>
                <input
                  type="number" step="1" min="0"
                  value={cfg.free_threshold}
                  onChange={(e) => setScalar('free_threshold', parseFloat(e.target.value) || 0)}
                />
              </label>
            </div>
          </div>

          {/* ── Zones internationales ─────────────────────────────── */}
          <div className="card" style={{ marginBottom: 20 }}>
            <h3>Tarifs par zone continentale, $</h3>
            <table className="data-table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Zone</th>
                  <th>Standard</th>
                  <th>Express</th>
                </tr>
              </thead>
              <tbody>
                {ZONES.map((z) => (
                  <tr key={z.code}>
                    <td>{z.label} <span className="badge">{z.code}</span></td>
                    <td>
                      <input
                        type="number" step="0.01" min="0" style={{ width: 100 }}
                        value={cfg.zones[z.code]?.standard ?? 0}
                        onChange={(e) => setZone(z.code, 'standard', parseFloat(e.target.value) || 0)}
                      />
                    </td>
                    <td>
                      <input
                        type="number" step="0.01" min="0" style={{ width: 100 }}
                        value={cfg.zones[z.code]?.express ?? 0}
                        onChange={(e) => setZone(z.code, 'express', parseFloat(e.target.value) || 0)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="subtitle" style={{ marginTop: 8 }}>
              Le tarif « Standard » de la zone Afrique et de l’Europe pilote aussi les
              zones internes agrégées utilisées par le calcul de commande.
            </p>
          </div>

          {/* ── Livraison nationale Sénégal ───────────────────────── */}
          <div className="card">
            <h3>Livraison nationale Sénégal (par distance)</h3>
            <div style={{ maxWidth: 260, marginTop: 12 }}>
              <label>
                <span>Repli quand le calcul par distance échoue, $</span>
                <input
                  type="number" step="0.01" min="0"
                  value={cfg.domestic_fallback_usd}
                  onChange={(e) => setScalar('domestic_fallback_usd', parseFloat(e.target.value) || 0)}
                />
              </label>
            </div>

            <table className="data-table" style={{ marginTop: 16 }}>
              <thead>
                <tr>
                  <th>Jusqu’à (km)</th>
                  <th>Prix, $</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {tiers.map((t) => (
                  <tr key={t.id}>
                    <td>{t.max_distance_km >= 99999 ? 'au-delà' : t.max_distance_km}</td>
                    <td>{t.price_usd.toFixed(2)}</td>
                    <td>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => removeTier(t.id)}
                        disabled={saving || tiers.length <= 1}
                      >
                        Supprimer
                      </button>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <input
                      type="number" step="1" min="1" style={{ width: 100 }}
                      placeholder="km"
                      value={newTier.max_distance_km}
                      onChange={(e) => setNewTier((s) => ({ ...s, max_distance_km: e.target.value }))}
                    />
                  </td>
                  <td>
                    <input
                      type="number" step="0.01" min="0" style={{ width: 100 }}
                      placeholder="$"
                      value={newTier.price_usd}
                      onChange={(e) => setNewTier((s) => ({ ...s, price_usd: e.target.value }))}
                    />
                  </td>
                  <td>
                    <button className="btn btn-sm btn-primary" onClick={addTier} disabled={saving}>
                      Ajouter
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="subtitle" style={{ marginTop: 8 }}>
              La tranche la plus haute (ex. « au-delà », 999999 km) sert de plafond —
              aucune commande n’est jamais refusée pour distance.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

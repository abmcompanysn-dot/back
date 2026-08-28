import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { ApiError, api } from '../../lib/api'
import { VendorNav } from './VendorNav'

// ============================================================
// VendorMap — carte des boutiques (adresse d'expédition).
//
// Affiche chaque boutique ayant une adresse d'expédition géocodée
// (shipping-svc, table vendor_shipping_addresses) sur une carte Leaflet
// (tuiles OpenStreetMap). Un marqueur par boutique ; clic sur un marqueur
// OU sur une ligne de la liste -> panneau d'édition (adresse + lat/lng),
// marqueur déplaçable pour ajuster la position, enregistrement via
// POST /admin/api/vendor-shipping-address.
//
// La position vendeur alimente le calcul de livraison nationale Sénégal
// (shipping-svc calculateDomestic : distance Haversine vendeur -> client
// -> tranche tarifaire). Une boutique sans adresse ici fait échouer ce
// calcul (repli forfaitaire côté frontend).
//
// Leaflet vanilla (pas react-leaflet) piloté par useEffect, cohérent avec
// le parti pris "pas de grosse dépendance" du reste de la webui admin.
// ============================================================

interface VendorAddr {
  vendor_id: number
  address: string
  lat: number
  lng: number
  updated_at?: string
}

interface Vendor {
  id: number
  name: string
  country: string
  city: string
}

// Vue par défaut : Sénégal (Dakar-Tambacounda), zoom pays.
const SENEGAL_CENTER: [number, number] = [14.5, -14.5]
const DEFAULT_ZOOM = 7

// Icône marqueur — les assets PNG de Leaflet ne se résolvent pas via le
// bundler sans config ; on utilise un divIcon CSS simple à la place.
function pinIcon(active: boolean) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:18px;height:18px;border-radius:50% 50% 50% 0;
      background:${active ? '#b42318' : '#005826'};
      transform:rotate(-45deg);border:2px solid #fff;
      box-shadow:0 1px 4px rgba(0,0,0,.4);"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 18],
  })
}

export function VendorMap() {
  const mapEl = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<Map<number, L.Marker>>(new Map())

  const [addresses, setAddresses] = useState<VendorAddr[]>([])
  const [vendors, setVendors] = useState<Record<number, Vendor>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState<{ address: string; lat: string; lng: string }>({ address: '', lat: '', lng: '' })
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // ---------- Chargement ----------
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      api.get<{ items: VendorAddr[] }>('/admin/api/vendor-shipping-addresses'),
      api.get<{ items: Vendor[] }>('/admin/api/vendors?page_size=200'),
    ])
      .then(([addrRes, vendRes]) => {
        if (cancelled) return
        setAddresses(addrRes.items || [])
        const byId: Record<number, Vendor> = {}
        for (const v of vendRes.items || []) byId[v.id] = v
        setVendors(byId)
      })
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'échec du chargement'))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [])

  // ---------- Init carte (une fois) ----------
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return
    const map = L.map(mapEl.current).setView(SENEGAL_CENTER, DEFAULT_ZOOM)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19,
    }).addTo(map)
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      markersRef.current.clear()
    }
  }, [])

  // ---------- (Re)pose des marqueurs quand les adresses changent ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    // Purge
    for (const m of markersRef.current.values()) m.remove()
    markersRef.current.clear()

    const bounds: [number, number][] = []
    for (const a of addresses) {
      if (!a.lat && !a.lng) continue
      const name = vendors[a.vendor_id]?.name || `Boutique #${a.vendor_id}`
      const marker = L.marker([a.lat, a.lng], {
        icon: pinIcon(a.vendor_id === selectedId),
        draggable: a.vendor_id === selectedId,
      })
        .addTo(map)
        .bindTooltip(`${name}${a.address ? ' — ' + a.address : ''}`, { direction: 'top' })
      marker.on('click', () => selectVendor(a.vendor_id))
      marker.on('dragend', () => {
        const p = marker.getLatLng()
        setDraft((d) => ({ ...d, lat: p.lat.toFixed(6), lng: p.lng.toFixed(6) }))
      })
      markersRef.current.set(a.vendor_id, marker)
      bounds.push([a.lat, a.lng])
    }
    if (bounds.length > 0 && selectedId === null) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses, vendors, selectedId])

  function selectVendor(vendorId: number) {
    setSelectedId(vendorId)
    setNotice(null)
    const a = addresses.find((x) => x.vendor_id === vendorId)
    setDraft({
      address: a?.address || '',
      lat: a ? String(a.lat) : '',
      lng: a ? String(a.lng) : '',
    })
    const map = mapRef.current
    if (map && a && (a.lat || a.lng)) {
      map.setView([a.lat, a.lng], Math.max(map.getZoom(), 13))
    }
  }

  async function save() {
    if (selectedId == null) return
    const lat = parseFloat(draft.lat)
    const lng = parseFloat(draft.lng)
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      setError('Latitude / longitude invalides')
      return
    }
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await api.post('/admin/api/vendor-shipping-address', {
        vendor_id: selectedId,
        address: draft.address,
        lat,
        lng,
      })
      // Mise à jour locale
      setAddresses((prev) => {
        const next = prev.filter((x) => x.vendor_id !== selectedId)
        next.push({ vendor_id: selectedId, address: draft.address, lat, lng })
        return next.sort((a, b) => a.vendor_id - b.vendor_id)
      })
      setNotice('Adresse enregistrée.')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "échec de l'enregistrement")
    } finally {
      setSaving(false)
    }
  }

  // Boutiques sans adresse géocodée — listées pour information (à traiter
  // via le script scripts/geocode-vendor-addresses.mjs ou en saisissant
  // lat/lng à la main ici après avoir sélectionné la boutique).
  const missing = useMemo(() => {
    const withAddr = new Set(addresses.map((a) => a.vendor_id))
    return Object.values(vendors).filter((v) => !withAddr.has(v.id))
  }, [addresses, vendors])

  const selectedVendorName =
    selectedId != null ? vendors[selectedId]?.name || `Boutique #${selectedId}` : null

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Carte des boutiques</h2>
          <p className="subtitle">
            Adresses d’expédition — alimente le calcul de livraison nationale Sénégal (distance vendeur → client).
          </p>
        </div>
      </div>

      <VendorNav />

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="hint" style={{ color: '#1a7f37', fontWeight: 600 }}>{notice}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 16, alignItems: 'start' }}>
        {/* Carte */}
        <div
          ref={mapEl}
          style={{ height: 560, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border, #e5e7eb)' }}
        />

        {/* Panneau latéral */}
        <div className="form-card" style={{ maxHeight: 560, overflowY: 'auto' }}>
          {loading && <p>Chargement…</p>}

          {!loading && selectedId == null && (
            <p className="hint" style={{ marginTop: 0 }}>
              Cliquez un marqueur sur la carte ou une boutique dans la liste ci-dessous pour voir / modifier
              son adresse d’expédition.
            </p>
          )}

          {!loading && selectedId != null && (
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ marginTop: 0, fontSize: 14 }}>{selectedVendorName}</h3>
              <div className="form-field full">
                <label>Adresse (quartier / ville)</label>
                <input
                  type="text"
                  value={draft.address}
                  onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))}
                  placeholder="Ex : Mariste, Dakar"
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div className="form-field" style={{ flex: 1 }}>
                  <label>Latitude</label>
                  <input
                    type="text"
                    value={draft.lat}
                    onChange={(e) => setDraft((d) => ({ ...d, lat: e.target.value }))}
                    placeholder="14.7192"
                  />
                </div>
                <div className="form-field" style={{ flex: 1 }}>
                  <label>Longitude</label>
                  <input
                    type="text"
                    value={draft.lng}
                    onChange={(e) => setDraft((d) => ({ ...d, lng: e.target.value }))}
                    placeholder="-17.4498"
                  />
                </div>
              </div>
              <p className="hint" style={{ marginTop: 4 }}>
                Astuce : quand une boutique est sélectionnée, son marqueur devient déplaçable — glissez-le pour
                ajuster la position, lat/lng se mettent à jour.
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn-primary" disabled={saving} onClick={save}>
                  {saving ? 'Enregistrement…' : 'Enregistrer'}
                </button>
                <button className="btn-ghost" onClick={() => setSelectedId(null)}>
                  Fermer
                </button>
              </div>
            </div>
          )}

          {/* Liste géocodées */}
          {!loading && (
            <>
              <h4 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: '#6b7280', margin: '12px 0 6px' }}>
                Boutiques géolocalisées ({addresses.length})
              </h4>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {addresses.map((a) => (
                  <li key={a.vendor_id}>
                    <button
                      type="button"
                      onClick={() => selectVendor(a.vendor_id)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px',
                        border: 'none', background: a.vendor_id === selectedId ? '#eef2ff' : 'transparent',
                        borderRadius: 6, cursor: 'pointer', fontSize: 13,
                      }}
                    >
                      <strong>{vendors[a.vendor_id]?.name || `#${a.vendor_id}`}</strong>
                      <span style={{ color: '#6b7280' }}> — {a.address || `${a.lat.toFixed(3)}, ${a.lng.toFixed(3)}`}</span>
                    </button>
                  </li>
                ))}
              </ul>

              {missing.length > 0 && (
                <>
                  <h4 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: '#b45309', margin: '14px 0 6px' }}>
                    Sans adresse ({missing.length})
                  </h4>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {missing.map((v) => (
                      <li key={v.id}>
                        <button
                          type="button"
                          onClick={() => selectVendor(v.id)}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px',
                            border: 'none', background: v.id === selectedId ? '#eef2ff' : 'transparent',
                            borderRadius: 6, cursor: 'pointer', fontSize: 13, color: '#92400e',
                          }}
                        >
                          {v.name} <span style={{ color: '#b45309' }}>({v.country || '—'})</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

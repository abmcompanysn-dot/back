"use client"

import { useState } from 'react'
import useSWR from 'swr'
import { Plus, Trash2, Save, Loader2, CheckCircle2, AlertCircle, MapPin } from 'lucide-react'

interface Tier {
  id: number
  min_km: number
  max_km: number | null
  price: number
  eta_label: string
  active: boolean
}

interface TiersResponse {
  ok: boolean
  tiers: Tier[]
  free_threshold: number
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('miad_token')
  return { Authorization: `Bearer ${token}` }
}

const fetcher = (url: string) =>
  fetch(url, { headers: authHeaders(), cache: 'no-store' }).then(r => r.json())

export function DomesticShippingPanel() {
  const { data, mutate, isLoading } = useSWR<TiersResponse>('/api/admin/shipping-domestic', fetcher)

  const [tiers, setTiers] = useState<Tier[] | null>(null)
  const [freeThreshold, setFreeThreshold] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<boolean | null>(null)

  // On garde une copie locale editable des qu'on a recu la premiere reponse,
  // sans re-ecraser les modifications en cours a chaque revalidation SWR.
  const activeTiers = tiers ?? data?.tiers ?? []
  const activeThreshold = freeThreshold ?? data?.free_threshold ?? 0

  const ensureLocal = () => {
    if (tiers === null && data) setTiers(data.tiers)
    if (freeThreshold === null && data) setFreeThreshold(data.free_threshold)
  }

  const updateTier = (id: number, patch: Partial<Tier>) => {
    ensureLocal()
    setTiers((prev) => (prev ?? data?.tiers ?? []).map(t => t.id === id ? { ...t, ...patch } : t))
  }

  const removeTier = (id: number) => {
    ensureLocal()
    setTiers((prev) => (prev ?? data?.tiers ?? []).filter(t => t.id !== id))
  }

  const addTier = () => {
    ensureLocal()
    const list = tiers ?? data?.tiers ?? []
    const lastMax = list.length ? (list[list.length - 1].max_km ?? list[list.length - 1].min_km + 50) : 0
    const nextId = list.length ? Math.max(...list.map(t => t.id)) + 1 : 1
    setTiers([...list, { id: nextId, min_km: lastMax, max_km: null, price: 0, eta_label: '', active: true }])
  }

  const handleSave = async () => {
    setSaving(true)
    setSaved(null)
    try {
      const res = await fetch('/api/admin/shipping-domestic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ tiers: activeTiers, free_threshold: activeThreshold }),
      })
      const ok = res.ok
      setSaved(ok)
      if (ok) await mutate()
    } catch {
      setSaved(false)
    }
    setSaving(false)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-3" /> Chargement des tranches tarifaires…
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-border bg-background text-xs">
        <MapPin size={14} className="text-primary shrink-0" />
        <span>
          <span className="font-bold">Distance vendeur → client, à vol d'oiseau</span>
          <span className="block text-[10px] text-muted-foreground mt-0.5">
            Approximation par ville tant qu'aucune API d'itinéraire routier n'est branchée — suffisant pour une tarification par tranche.
          </span>
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs font-bold text-muted-foreground uppercase tracking-wider border-b border-border">
              <th className="py-2 pr-3">Actif</th>
              <th className="py-2 pr-3">Min (km)</th>
              <th className="py-2 pr-3">Max (km)</th>
              <th className="py-2 pr-3">Prix (FCFA)</th>
              <th className="py-2 pr-3">Délai</th>
              <th className="py-2 pr-3" />
            </tr>
          </thead>
          <tbody>
            {activeTiers.map((t) => (
              <tr key={t.id} className="border-b border-border/50">
                <td className="py-2 pr-3">
                  <input
                    type="checkbox"
                    checked={t.active}
                    onChange={e => updateTier(t.id, { active: e.target.checked })}
                    className="w-4 h-4"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    type="number"
                    value={t.min_km}
                    onChange={e => updateTier(t.id, { min_km: Number(e.target.value) })}
                    className="w-20 h-9 px-2 border border-border rounded-lg bg-background text-sm"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    type="number"
                    value={t.max_km ?? ''}
                    placeholder="∞"
                    onChange={e => updateTier(t.id, { max_km: e.target.value === '' ? null : Number(e.target.value) })}
                    className="w-20 h-9 px-2 border border-border rounded-lg bg-background text-sm"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    type="number"
                    value={t.price}
                    onChange={e => updateTier(t.id, { price: Number(e.target.value) })}
                    className="w-24 h-9 px-2 border border-border rounded-lg bg-background text-sm"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    type="text"
                    value={t.eta_label}
                    onChange={e => updateTier(t.id, { eta_label: e.target.value })}
                    placeholder="24-48h"
                    className="w-28 h-9 px-2 border border-border rounded-lg bg-background text-sm"
                  />
                </td>
                <td className="py-2 pr-3">
                  <button type="button" onClick={() => removeTier(t.id)} className="text-red-600 hover:bg-red-50 p-1.5 rounded-lg">
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        onClick={addTier}
        className="text-xs font-bold text-primary flex items-center gap-1.5 hover:underline"
      >
        <Plus size={14} /> Ajouter une tranche
      </button>

      <div className="flex items-end gap-4 pt-2 border-t border-border">
        <div>
          <label htmlFor="free-shipping-threshold" className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-1.5">
            Livraison gratuite à partir de (USD, 0 = désactivé)
          </label>
          <input
            id="free-shipping-threshold"
            type="number"
            value={activeThreshold}
            onChange={e => { ensureLocal(); setFreeThreshold(Number(e.target.value)) }}
            className="w-48 h-10 px-3 border border-border rounded-xl bg-background text-sm"
          />
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="h-10 px-5 bg-primary text-primary-foreground rounded-xl font-bold text-sm flex items-center gap-2 disabled:opacity-40 hover:bg-primary/90 transition-colors"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          Enregistrer
        </button>

        {saved === true && (
          <span className="flex items-center gap-1.5 text-xs font-bold text-green-700">
            <CheckCircle2 size={14} /> Grille tarifaire enregistrée
          </span>
        )}
        {saved === false && (
          <span className="flex items-center gap-1.5 text-xs font-bold text-red-700">
            <AlertCircle size={14} /> Erreur lors de l'enregistrement
          </span>
        )}
      </div>
    </div>
  )
}

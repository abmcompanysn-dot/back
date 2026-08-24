"use client"

import { useEffect, useState } from 'react'
import { Loader2, Save, MapPin, CheckCircle2, AlertCircle, LocateFixed } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { SENEGAL_CITIES } from '@/lib/geo-senegal'

interface VendorAddress {
  region: string
  city: string
  quartier: string
  address: string
  phone: string
  lat: number | null
  lng: number | null
}

const EMPTY: VendorAddress = { region: '', city: '', quartier: '', address: '', phone: '', lat: null, lng: null }

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('miad_token')
  return { Authorization: `Bearer ${token}` }
}

export function VendorShippingAddressForm() {
  const [form, setForm] = useState<VendorAddress>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<boolean | null>(null)
  const [locating, setLocating] = useState(false)
  const [locateError, setLocateError] = useState('')

  useEffect(() => {
    fetch('/api/vendor/shipping-address', { headers: authHeaders(), cache: 'no-store' })
      .then(r => r.json())
      .then(data => { if (data?.address) setForm({ ...EMPTY, ...data.address }) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleLocate = () => {
    if (!navigator.geolocation) {
      setLocateError("Ce navigateur ne permet pas la géolocalisation.")
      return
    }
    setLocating(true)
    setLocateError('')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setForm(f => ({ ...f, lat: position.coords.latitude, lng: position.coords.longitude }))
        setLocating(false)
      },
      () => {
        setLocateError("Position refusée ou indisponible.")
        setLocating(false)
      },
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  const handleSave = async () => {
    if (!form.city) return
    setSaving(true)
    setSaved(null)
    try {
      const res = await fetch('/api/vendor/shipping-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(form),
      })
      setSaved(res.ok)
    } catch {
      setSaved(false)
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" /> Chargement…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-blue-50 rounded-xl">
        <MapPin size={18} className="text-blue-500 mt-0.5 shrink-0" />
        <p className="text-sm text-blue-700">
          Cette adresse sert à calculer les frais de livraison nationale (Sénégal) affichés à vos clients au moment du paiement, selon la distance jusqu'à chez eux.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label htmlFor="vendor-ship-city" className="text-sm font-medium block mb-1.5">Ville</label>
          <Input
            id="vendor-ship-city"
            list="miad-senegal-cities"
            value={form.city}
            onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
            placeholder="Dakar"
          />
          <datalist id="miad-senegal-cities">
            {SENEGAL_CITIES.map(c => <option key={c} value={c} />)}
          </datalist>
        </div>
        <div>
          <label htmlFor="vendor-ship-quartier" className="text-sm font-medium block mb-1.5">Quartier</label>
          <Input
            id="vendor-ship-quartier"
            value={form.quartier}
            onChange={e => setForm(f => ({ ...f, quartier: e.target.value }))}
            placeholder="Sacré-Cœur 3"
          />
        </div>
      </div>

      <div>
        <label htmlFor="vendor-ship-address" className="text-sm font-medium block mb-1.5">Adresse précise</label>
        <Input
          id="vendor-ship-address"
          value={form.address}
          onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
          placeholder="Rue, numéro, point de repère…"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label htmlFor="vendor-ship-phone" className="text-sm font-medium block mb-1.5">Téléphone pour la récupération</label>
          <Input
            id="vendor-ship-phone"
            type="tel"
            value={form.phone}
            onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
            placeholder="+221 77 000 00 00"
          />
        </div>
        <div className="flex flex-col justify-end">
          <button
            type="button"
            onClick={handleLocate}
            disabled={locating}
            className="h-11 px-4 border border-border rounded-xl text-sm font-bold flex items-center justify-center gap-2 hover:bg-muted transition-colors disabled:opacity-50"
          >
            {locating ? <Loader2 size={15} className="animate-spin" /> : <LocateFixed size={15} />}
            {form.lat ? 'Position enregistrée — actualiser' : 'Utiliser ma position GPS'}
          </button>
          {locateError && <p className="text-xs text-red-600 mt-1">{locateError}</p>}
          {form.lat && form.lng && !locateError && (
            <p className="text-xs text-muted-foreground mt-1">
              {form.lat.toFixed(4)}, {form.lng.toFixed(4)} — précision optimale pour le calcul de distance
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <Button onClick={handleSave} disabled={saving || !form.city} className="bg-accent text-white h-11 rounded-xl font-bold">
          {saving ? <Loader2 className="animate-spin" size={18} /> : <><Save size={16} className="mr-2" /> Enregistrer l'adresse</>}
        </Button>
        {saved === true && (
          <span className="flex items-center gap-1.5 text-sm font-bold text-green-700">
            <CheckCircle2 size={16} /> Enregistré
          </span>
        )}
        {saved === false && (
          <span className="flex items-center gap-1.5 text-sm font-bold text-red-700">
            <AlertCircle size={16} /> Erreur, réessayez
          </span>
        )}
      </div>
    </div>
  )
}

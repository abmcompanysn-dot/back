'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MapPin, Loader2, CheckCircle2 } from 'lucide-react'

interface Props {
  orderId: string
  token: string
}

export function ScanCheckpointButton({ orderId, token }: Props) {
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'locating' | 'sending' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')

  const confirmCheckpoint = () => {
    if (!navigator.geolocation) {
      setState('error')
      setError("Ce téléphone/navigateur ne permet pas la géolocalisation.")
      return
    }
    setState('locating')
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        setState('sending')
        try {
          const res = await fetch('/api/scan-checkpoint', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              orderId,
              token,
              lat: position.coords.latitude,
              lng: position.coords.longitude,
            }),
          })
          const data = await res.json()
          if (!res.ok || !data.ok) throw new Error(data.error || 'Échec de l\'enregistrement')
          setState('done')
          router.refresh()
        } catch (e) {
          setState('error')
          setError(e instanceof Error ? e.message : 'Erreur réseau')
        }
      },
      () => {
        setState('error')
        setError('Position refusée ou indisponible — autorisez la géolocalisation puis réessayez.')
      },
      { enableHighAccuracy: true, timeout: 15000 }
    )
  }

  if (state === 'done') {
    return (
      <div className="flex items-center gap-2 text-sm font-bold text-green-700 bg-green-50 rounded-xl px-3 py-2.5 justify-center">
        <CheckCircle2 size={16} /> Point de passage enregistré
      </div>
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={confirmCheckpoint}
        disabled={state === 'locating' || state === 'sending'}
        className="w-full flex items-center justify-center gap-2 text-sm font-bold px-4 py-2.5 rounded-xl bg-accent text-white disabled:opacity-60 transition-colors"
      >
        {state === 'locating' || state === 'sending' ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <MapPin size={16} />
        )}
        {state === 'locating' ? 'Localisation…' : state === 'sending' ? 'Enregistrement…' : 'Confirmer mon passage ici'}
      </button>
      <p className="text-[11px] text-muted-foreground mt-1.5 text-center">
        À utiliser par la personne qui a le colis en main à chaque étape (vendeur, représentant, transporteur).
      </p>
      {state === 'error' && <p className="text-xs text-red-600 mt-1.5 text-center">{error}</p>}
    </div>
  )
}

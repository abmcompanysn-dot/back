"use client"

import { useEffect } from 'react'
import Image from 'next/image'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[MIAD] Client error:', error)
  }, [error])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-6 text-center">
      <Image src="/logo/logo.png" alt="MIAD Market" width={64} height={64} className="object-contain mb-6" />
      <h1 className="text-xl font-bold text-foreground mb-2">Une erreur est survenue</h1>
      <p className="text-muted-foreground text-sm mb-8 max-w-xs">
        Un problème inattendu s&apos;est produit. Vos données sont sauvegardées.
      </p>
      <div className="flex flex-col gap-3 w-full max-w-xs">
        <button
          type="button"
          onClick={reset}
          className="w-full py-3 bg-accent text-white font-bold rounded-xl text-sm"
        >
          Réessayer
        </button>
        <button
          type="button"
          onClick={() => { window.location.href = '/' }}
          className="w-full py-3 border border-border text-foreground font-medium rounded-xl text-sm"
        >
          Retour à l&apos;accueil
        </button>
      </div>
    </div>
  )
}

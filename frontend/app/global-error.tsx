"use client"

import { useEffect } from 'react'
import Image from 'next/image'
// Sentry frontend désactivé le 2026-08-29 (voir next.config.mjs) — l'erreur
// globale est loguée en console ; le suivi backend Go reste actif.

const primaryButtonStyle: React.CSSProperties = {
  width: '100%', padding: '14px', background: '#e85d04',
  color: '#fff', fontWeight: 700, borderRadius: 12,
  border: 'none', fontSize: 14, cursor: 'pointer',
}

const secondaryButtonStyle: React.CSSProperties = {
  width: '100%', padding: '14px', background: '#fff',
  color: '#111', fontWeight: 500, borderRadius: 12,
  border: '1px solid #e0e0e0', fontSize: 14, cursor: 'pointer',
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[MIAD] Global error:', error)
  }, [error])

  return (
    <html lang="fr">
      <body style={{ margin: 0, fontFamily: 'Arial, sans-serif', background: '#f9fafb' }}>
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          textAlign: 'center',
        }}>
          <Image
            src="/logo/logo.png"
            alt="MIAD Market"
            width={64}
            height={64}
            style={{ objectFit: 'contain', marginBottom: 24 }}
          />
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111', marginBottom: 8 }}>
            Une erreur est survenue
          </h1>
          <p style={{ fontSize: 14, color: '#666', marginBottom: 32, maxWidth: 300 }}>
            Un problème inattendu s&apos;est produit. Vos données sont sauvegardées.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 300 }}>
            <button
              type="button"
              onClick={reset}
              style={primaryButtonStyle}
            >
              Réessayer
            </button>
            <button
              type="button"
              onClick={() => { window.location.href = '/' }}
              style={secondaryButtonStyle}
            >
              Retour à l&apos;accueil
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}

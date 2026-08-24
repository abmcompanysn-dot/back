"use client"

import { useEffect, useState } from 'react'
import { ArrowUp } from 'lucide-react'

// Bouton flottant "remonter en haut" — demandé le 2026-07-29 pour l'accueil,
// qui peut devenir long une fois toutes les sections pays/produits chargées.
// Apparaît seulement après un scroll significatif pour ne pas encombrer
// l'écran sur les pages courtes.
export function ScrollToTopButton() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 600)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  if (!visible) return null

  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="Remonter en haut"
      className="fixed bottom-20 sm:bottom-6 right-4 z-50 w-11 h-11 rounded-full bg-accent text-white shadow-lg flex items-center justify-center hover:bg-accent/90 transition-colors animate-in fade-in slide-in-from-bottom-2 duration-200"
    >
      <ArrowUp size={20} />
    </button>
  )
}

"use client"

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

// Coquille de défilement horizontal (flèches + scroll-snap) réutilisée par
// les sections streamées de l'accueil — reçoit les cartes déjà rendues côté
// serveur en children, ne gère que l'interactivité de scroll (impossible à
// faire dans un Server Component). Mêmes classes/comportement que les
// scrolls "à la main" déjà présents dans FlashSalesSection.tsx / HomePage.tsx.
interface ScrollRowProps {
  children: ReactNode
  arrowClassName?: string
}

export function ScrollRow({ children, arrowClassName }: ScrollRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isAtStart, setIsAtStart] = useState(true)
  const [isAtEnd, setIsAtEnd] = useState(false)

  const checkScrollPosition = () => {
    if (scrollRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current
      setIsAtStart(scrollLeft === 0)
      setIsAtEnd(scrollLeft + clientWidth >= scrollWidth)
    }
  }

  useEffect(() => {
    checkScrollPosition()
    const currentRef = scrollRef.current
    currentRef?.addEventListener('scroll', checkScrollPosition)
    window.addEventListener('resize', checkScrollPosition)
    return () => {
      currentRef?.removeEventListener('scroll', checkScrollPosition)
      window.removeEventListener('resize', checkScrollPosition)
    }
  }, [])

  const scroll = (dir: 'left' | 'right') => {
    scrollRef.current?.scrollBy({ left: dir === 'left' ? -300 : 300, behavior: 'smooth' })
  }

  return (
    <div>
      <div className="flex justify-end gap-1 mb-2">
        <button
          type="button"
          onClick={() => scroll('left')}
          disabled={isAtStart}
          aria-label="Défiler vers la gauche"
          className={arrowClassName ?? 'w-8 h-8 rounded-full border border-border bg-white flex items-center justify-center hover:bg-accent hover:text-white hover:border-accent transition-colors disabled:opacity-30'}
        >
          <ChevronLeft size={15} />
        </button>
        <button
          type="button"
          onClick={() => scroll('right')}
          disabled={isAtEnd}
          aria-label="Défiler vers la droite"
          className={arrowClassName ?? 'w-8 h-8 rounded-full border border-border bg-white flex items-center justify-center hover:bg-accent hover:text-white hover:border-accent transition-colors disabled:opacity-30'}
        >
          <ChevronRight size={15} />
        </button>
      </div>
      <div
        ref={scrollRef}
        onScroll={checkScrollPosition}
        className="flex gap-2 overflow-x-auto scrollbar-hide pb-1"
      >
        {children}
      </div>
    </div>
  )
}

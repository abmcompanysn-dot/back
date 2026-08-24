"use client"

import { useRef, useState } from 'react'
import Image from 'next/image'
import { ChevronLeft, ChevronRight, ShoppingBag, Shirt, Palette, Sparkles, Home, Smartphone, Coffee, Utensils } from 'lucide-react'
import { translations } from '@/lib/woocommerce'

/** * Mapping des icônes (Slugs WooCommerce)
 * Assure-toi que les slugs correspondent à ceux de ton admin WordPress
 */
const categoryIcons: Record<string, any> = {
  'alimentation': Utensils,
  'mode': Shirt,
  'vetements': Shirt,
  'artisanat': Palette,
  'beaute-cosmetique': Sparkles,
  'maison-bureau': Home,
  'electronique': Smartphone,
  'thes-tisanes': Coffee,
}

// Assuming WooCategory (from lib/woocommerce.ts) has an 'image' property.
// If not, you would need to add `image?: string;` to your WooCategory type definition in lib/woocommerce.ts.
interface Category {
  id: string
  name: string
  slug: string
  image?: string // Added for category photos
  count?: number
}

function CategoryImage({ src, alt, FallbackIcon }: { src?: string; alt: string; FallbackIcon: React.ElementType }) {
  const [errored, setErrored] = useState(false)
  const valid = src && src !== '/placeholder.jpg' && !src.includes('placeholder') && !errored
  return valid ? (
    <Image src={src} alt={alt} fill sizes="64px" className="object-cover" onError={() => setErrored(true)} />
  ) : (
    <div className="w-full h-full flex items-center justify-center bg-muted text-muted-foreground opacity-20"><FallbackIcon size={32} /></div>
  )
}

interface CategoriesSectionProps {
  categories: Category[] // Doit être la liste déjà filtrée par ton Client.tsx
  selectedCategory: string | null
  onSelectCategory: (slug: string) => void
  language?: 'fr' | 'en'
}

export function CategoriesSection({ categories, selectedCategory, onSelectCategory, language = 'fr' }: CategoriesSectionProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const t = translations[language]
  
  const scroll = (direction: 'left' | 'right') => {
    if (!scrollRef.current) return
    const scrollAmount = 300
    scrollRef.current.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth'
    })
  }

  // --- SÉCURITÉ ---
  // Si aucune catégorie n'a de produits après le filtrage, on cache toute la section
  if (!categories || categories.length === 0) return null

  return (
    <section id="categories-section" className="py-8 bg-white border-b border-border shadow-sm">
      <div className="container mx-auto px-4">
        {/* En-tête avec navigation */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-black uppercase tracking-tight text-foreground">{t.ourDepartments}</h2>
            <p className="text-xs text-muted-foreground font-medium">{t.onlyAvailable}</p>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => scroll('left')}
              aria-label={language === 'en' ? 'Scroll left' : 'Défiler vers la gauche'}
              className="w-10 h-10 rounded-full border border-border flex items-center justify-center hover:bg-accent hover:text-white transition-all shadow-sm active:scale-90"
            >
              <ChevronLeft size={20} />
            </button>
            <button
              type="button"
              onClick={() => scroll('right')}
              aria-label={language === 'en' ? 'Scroll right' : 'Défiler vers la droite'}
              className="w-10 h-10 rounded-full border border-border flex items-center justify-center hover:bg-accent hover:text-white transition-all shadow-sm active:scale-90"
            >
              <ChevronRight size={20} />
            </button>
          </div>
        </div>
        
        {/* Liste Horizontale Dynamique */}
        <div 
          ref={scrollRef}
          className="flex gap-6 overflow-x-auto scrollbar-hide pb-4 snap-x"
        >
          {/* Bouton "Tout le marché" */}
          <button
            type="button"
            onClick={() => onSelectCategory('')}
            className={`flex flex-col items-center gap-3 min-w-25 transition-all snap-start ${
              !selectedCategory ? 'scale-110' : 'opacity-60 hover:opacity-100'
            }`}
          >
            <div className={`w-16 h-16 rounded-2xl flex items-center justify-center transition-all duration-300 ${
              !selectedCategory ? 'bg-accent text-white shadow-xl rotate-3' : 'bg-muted'
            }`}>
              <ShoppingBag className="w-8 h-8" />
            </div>
            <span className={`text-[11px] font-black uppercase tracking-tighter ${!selectedCategory ? 'text-accent' : 'text-muted-foreground'}`}>
              {t.all}
            </span>
          </button>
          
          {/* Mapping des catégories qui ONT des produits */}
          {categories.map((cat) => {
            const Icon = categoryIcons[cat.slug.toLowerCase()] || ShoppingBag
            const isSelected = selectedCategory === cat.slug
            
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => onSelectCategory(cat.slug)}
                className={`flex flex-col items-center gap-3 min-w-25 transition-all snap-start ${
                  isSelected ? 'scale-110' : 'opacity-60 hover:opacity-100'
                }`}
              >
                <div className={`w-16 h-16 rounded-2xl flex items-center justify-center transition-all duration-300 relative ${
                  isSelected ? 'bg-accent text-white shadow-xl -rotate-3' : 'bg-muted'
                }`}>
                  {cat.image ? (
                    <CategoryImage src={cat.image} alt={cat.name} FallbackIcon={Icon} />
                  ) : (
                    <Icon className="w-8 h-8" />
                  )}
                  {/* Badge discret du nombre de produits */}
                  <span className="absolute -top-2 -right-1 bg-primary text-white text-[9px] font-black px-1.5 py-0.5 rounded-full border-2 border-white">
                    {cat.count}
                  </span>
                </div>
                <span className={`text-[11px] font-black uppercase tracking-tighter text-center line-clamp-1 w-full ${
                  isSelected ? 'text-accent' : 'text-muted-foreground'
                }`}>
                  {cat.name}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
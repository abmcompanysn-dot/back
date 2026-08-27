"use client"

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import { ChevronLeft, ChevronRight, Truck, Shield, Clock, Headphones } from 'lucide-react'

// ─── Ajoute tes bannières ici ──────────────────────────────────────────────
// Pour ajouter une nouvelle bannière :
// 1. Mets ton image dans le dossier /public/banners/
// 2. Ajoute un objet { id, image, title, highlight, subtitle, cta } dans ce tableau
//
// Les 3 slides pointent vers la même image (miad-delivery-banner.webp,
// visuel de marque MIAD) — remplace 2026.webp le 2026-08-27 : son fond en
// larges touches de peinture rouge/jaune/vert (couleurs panafricaines)
// gênait la lisibilité, signalé par le fondateur. bgTint/mix-blend-multiply
// (qui teintait cette image différemment par slide, seul moyen de les
// distinguer visuellement tant qu'un seul vrai visuel existe) retiré en
// même temps — sans plus de raison d'être, et la teinte perturbait aussi
// les couleurs de la nouvelle image.
const SLIDES_BY_LANG = {
  fr: [
    {
      id: 'made-in-africa',
      image: '/promo/miad-delivery-banner.webp',
      title: 'MADE IN AFRICA',
      highlight: '',
      subtitle: 'Produits authentiques du continent africain',
      cta: 'EXPLORER',
    },
    {
      id: 'livraison',
      image: '/promo/miad-delivery-banner.webp',
      title: 'LIVRAISON',
      highlight: 'MIAD Express',
      subtitle: 'Expédition rapide vers plus de 220 pays',
      cta: 'EN SAVOIR PLUS',
    },
    {
      id: 'vendeurs-verifies',
      image: '/promo/miad-delivery-banner.webp',
      title: 'VENDEURS VÉRIFIÉS',
      highlight: '100%',
      subtitle: 'Des milliers de boutiques africaines certifiées MIAD',
      cta: 'VOIR LES BOUTIQUES',
    },
  ],
  en: [
    {
      id: 'made-in-africa',
      image: '/promo/miad-delivery-banner.webp',
      title: 'MADE IN AFRICA',
      highlight: '',
      subtitle: 'Authentic products from the African continent',
      cta: 'EXPLORE',
    },
    {
      id: 'livraison',
      image: '/promo/miad-delivery-banner.webp',
      title: 'SHIPPING',
      highlight: 'MIAD Express',
      subtitle: 'Fast shipping to more than 220 countries',
      cta: 'LEARN MORE',
    },
    {
      id: 'vendeurs-verifies',
      image: '/promo/miad-delivery-banner.webp',
      title: 'VERIFIED VENDORS',
      highlight: '100%',
      subtitle: 'Thousands of certified African stores on MIAD',
      cta: 'SEE STORES',
    },
  ],
}

const FEATURES_BY_LANG = {
  fr: [
    { icon: Truck,       label: 'Livraison Express' },
    { icon: Shield,      label: 'Paiement Sécurisé' },
    { icon: Clock,       label: 'Support 24/7'       },
    { icon: Headphones,  label: 'Service Client'      },
  ],
  en: [
    { icon: Truck,       label: 'Express Delivery' },
    { icon: Shield,      label: 'Secure Payment' },
    { icon: Clock,       label: 'Support 24/7'       },
    { icon: Headphones,  label: 'Customer Service'      },
  ],
}

// Reste fixe sur la première image quelques minutes après le chargement ;
// le défilement automatique ne démarre qu'une fois ce délai écoulé.
const INITIAL_DELAY_MS = 3 * 60 * 1000
const ROTATE_INTERVAL_MS = 4500

interface HeroSectionProps {
  onExplore?: () => void
  onLearnMore?: () => void
  onViewStores?: () => void
  language?: 'fr' | 'en'
}

// Chaque slide a sa propre action — corrige un bug ou les 3 boutons faisaient
// tous "défiler vers les catégories" quel que soit leur libellé (ex:
// "VOIR LES BOUTIQUES" ne menait jamais aux boutiques).
function ctaHandlerFor(slideId: string, props: HeroSectionProps): (() => void) | undefined {
  if (slideId === 'vendeurs-verifies') return props.onViewStores
  if (slideId === 'livraison') return props.onLearnMore
  return props.onExplore
}

export function HeroSection(props: HeroSectionProps) {
  const { language = 'fr' } = props
  const [current, setCurrent] = useState(0)
  const [paused,  setPaused]  = useState(false)
  const SLIDES = SLIDES_BY_LANG[language]
  const FEATURES = FEATURES_BY_LANG[language]
  const total = SLIDES.length

  const next = useCallback(() => setCurrent(c => (c + 1) % total), [total])
  const prev = useCallback(() => setCurrent(c => (c - 1 + total) % total), [total])

  const [rotating, setRotating] = useState(false)

  useEffect(() => {
    const timeout = setTimeout(() => setRotating(true), INITIAL_DELAY_MS)
    return () => clearTimeout(timeout)
  }, [])

  useEffect(() => {
    if (paused || !rotating) return
    const interval = setInterval(next, ROTATE_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [paused, next, rotating])

  return (
    <section>
      {/* ── Banner slider ─────────────────────────────────────────── */}
      <div
        className="relative w-full h-[160px] sm:h-[240px] lg:h-[340px] overflow-hidden bg-[#7a3a1e] select-none"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        {SLIDES.map((slide, idx) => (
          <div
            key={slide.id}
            className={`absolute inset-0 transition-opacity duration-700 ${
              idx === current ? 'opacity-100 z-10' : 'opacity-0 z-0'
            }`}
          >
            {/* Background image — les 3 slides partagent la même image
                (voir commentaire plus haut). */}
            <Image
              src={slide.image}
              alt=""
              fill
              sizes="100vw"
              priority={idx === 0}
              className="object-cover"
              draggable={false}
            />
            {/* Dark gradient overlay on the left for text readability */}
            <div className="absolute inset-0 bg-gradient-to-r from-black/65 via-black/30 to-transparent" />

            {/* Text content — left side */}
            <div className="relative z-10 h-full flex items-center px-6 sm:px-10 lg:px-16">
              <div className="text-white max-w-xs sm:max-w-sm lg:max-w-lg">
                <p className="text-[10px] sm:text-xs uppercase tracking-[0.25em] text-white/70 mb-1 sm:mb-2 font-medium">
                  MIAD Market
                </p>
                <h2 className="text-xl sm:text-3xl lg:text-5xl font-black leading-tight mb-1 sm:mb-2">
                  {slide.title}{' '}
                  {slide.highlight && (
                    <span className="text-green-400">{slide.highlight}</span>
                  )}
                </h2>
                <p className="text-white/80 text-[11px] sm:text-sm lg:text-base mb-3 sm:mb-5 leading-snug">
                  {slide.subtitle}
                </p>
                <button
                  type="button"
                  onClick={ctaHandlerFor(slide.id, props)}
                  className="inline-block bg-white text-black text-[10px] sm:text-xs lg:text-sm font-black px-4 sm:px-6 py-2 sm:py-2.5 uppercase tracking-widest hover:bg-white/90 transition-colors rounded-sm"
                >
                  {slide.cta}
                </button>
              </div>
            </div>
          </div>
        ))}

        {/* ── Arrows ── */}
        <button
          type="button"
          onClick={prev}
          aria-label={language === 'en' ? 'Previous' : 'Précédent'}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-20 w-7 h-7 sm:w-9 sm:h-9 rounded-full bg-black/30 hover:bg-black/50 flex items-center justify-center text-white transition-colors"
        >
          <ChevronLeft size={18} />
        </button>
        <button
          type="button"
          onClick={next}
          aria-label={language === 'en' ? 'Next' : 'Suivant'}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-20 w-7 h-7 sm:w-9 sm:h-9 rounded-full bg-black/30 hover:bg-black/50 flex items-center justify-center text-white transition-colors"
        >
          <ChevronRight size={18} />
        </button>

        {/* ── Dots ── */}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex gap-1.5">
          {SLIDES.map((slide, idx) => (
            <button
              type="button"
              key={slide.id}
              onClick={() => setCurrent(idx)}
              aria-label={`Slide ${idx + 1}`}
              className={`rounded-full transition-all ${
                idx === current
                  ? 'w-5 h-2 bg-white'
                  : 'w-2 h-2 bg-white/40 hover:bg-white/60'
              }`}
            />
          ))}
        </div>
      </div>

      {/* ── Features bar ──────────────────────────────────────────── */}
      <div id="hero-features" className="bg-card border-b border-border">
        <div className="container mx-auto px-4">
          <div className="flex overflow-x-auto scrollbar-hide py-3 gap-6 lg:gap-0 lg:justify-between">
            {FEATURES.map(({ icon: Icon, label }) => (
              <div key={label} className="flex items-center gap-2.5 whitespace-nowrap px-3 first:pl-0 last:pr-0">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Icon className="w-4 h-4 text-primary" />
                </div>
                <span className="text-xs font-medium text-foreground">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

"use client"

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { Search, ShoppingCart, User, ArrowLeft } from 'lucide-react'
import { CurrencySelector } from '@/components/miad/CurrencySelector'

/**
 * En-tête du site pour les pages autonomes rendues côté serveur (fiche
 * produit d'abord). Reproduit à l'identique l'en-tête de la page d'accueil
 * (`components/miad/Header.tsx`) — logo, sélecteur TOUT, barre de recherche
 * avec suggestions, bascule FR/EN, sélecteur de devise, Compte, Panier —
 * mais câblé sur `next/navigation` au lieu des callbacks de
 * `MiadMarketClient` (absent de ces pages). Aucune prop : totalement
 * autonome.
 */
interface SearchSuggestion {
  id: number
  name: string
  slug: string
  price: number
  image: string
  category: string
}

interface Cat {
  id: string
  name: string
  slug: string
}

function getInitialCartCount(): number {
  if (typeof window === 'undefined') return 0
  try {
    const raw = localStorage.getItem('miad_cart')
    const cart = raw ? JSON.parse(raw) : []
    return cart.reduce((s: number, i: any) => s + (i.quantity || 0), 0)
  } catch {
    return 0
  }
}

export function SiteHeaderStandalone() {
  const router = useRouter()

  const [cartCount, setCartCount] = useState(getInitialCartCount)
  const [lang, setLang] = useState<'fr' | 'en'>('fr')
  const [categories, setCategories] = useState<Cat[]>([])
  const [searchCategory, setSearchCategory] = useState('')
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestLoading, setSuggestLoading] = useState(false)

  const searchDesktopRef = useRef<HTMLDivElement>(null)
  const searchMobileRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search)
      if (p.get('lang') === 'en') setLang('en')
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    const sync = () => setCartCount(getInitialCartCount())
    window.addEventListener('storage', sync)
    window.addEventListener('miad-cart-change', sync as EventListener)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('miad-cart-change', sync as EventListener)
    }
  }, [])

  useEffect(() => {
    let alive = true
    fetch(`/api/categories?lang=${lang}`)
      .then((r) => (r.ok ? r.json() : { categories: [] }))
      .then((d) => {
        if (alive && Array.isArray(d.categories)) {
          setCategories(d.categories.map((c: any) => ({ id: String(c.id), name: c.name, slug: c.slug })))
        }
      })
      .catch(() => {})
    return () => { alive = false }
  }, [lang])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setSuggestions([])
      setSuggestLoading(false)
      return
    }
    setSuggestLoading(true)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/search/suggestions?q=${encodeURIComponent(q)}&limit=6&lang=${lang}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : { products: [] }))
        .then((d) => setSuggestions(Array.isArray(d.products) ? d.products : []))
        .catch(() => {})
        .finally(() => setSuggestLoading(false))
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, lang])

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      const t = e.target as Node
      if (!searchDesktopRef.current?.contains(t) && !searchMobileRef.current?.contains(t)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const t = {
    search: lang === 'fr' ? 'Rechercher sur MIAD Market...' : 'Search on MIAD Market...',
    all: lang === 'fr' ? 'TOUT' : 'ALL',
    cart: lang === 'fr' ? 'PANIER' : 'CART',
    account: lang === 'fr' ? 'COMPTE' : 'ACCOUNT',
    searching: lang === 'fr' ? 'Recherche…' : 'Searching…',
    back: lang === 'fr' ? 'Retour' : 'Back',
  }

  const runSearch = (e?: React.FormEvent) => {
    e?.preventDefault()
    setShowSuggestions(false)
    const q = query.trim()
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (searchCategory) params.set('category', searchCategory)
    if (lang === 'en') params.set('lang', 'en')
    router.push(`/${params.toString() ? `?${params}` : ''}`)
  }

  const goToSuggestion = (s: SearchSuggestion) => {
    setShowSuggestions(false)
    setQuery(s.name)
    router.push(`/product/${encodeURIComponent(s.slug)}`)
  }

  const switchLang = (next: 'fr' | 'en') => {
    setLang(next)
    const p = new URLSearchParams(window.location.search)
    if (next === 'en') p.set('lang', 'en')
    else p.delete('lang')
    router.replace(`${window.location.pathname}${p.toString() ? `?${p}` : ''}`)
  }

  const handleBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) window.history.back()
    else router.push('/')
  }

  const SuggestionsPanel =
    showSuggestions && query.trim().length >= 2 && (suggestions.length > 0 || suggestLoading) ? (
      <div className="absolute left-0 right-0 top-full mt-2 bg-white rounded-2xl shadow-2xl border border-border overflow-hidden z-[70] animate-in fade-in slide-in-from-top-2 duration-150">
        {suggestLoading && suggestions.length === 0 ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">{t.searching}</div>
        ) : (
          <ul>
            {suggestions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => goToSuggestion(s)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-accent/10 transition-colors text-left"
                >
                  <Image src={s.image || '/placeholder.svg'} alt="" width={36} height={36} className="w-9 h-9 rounded-lg object-cover shrink-0 border border-border" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-foreground truncate">{s.name}</span>
                    {s.category && <span className="block text-[11px] text-muted-foreground truncate">{s.category}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    ) : null

  return (
    <header className="sticky top-0 z-[60] w-full bg-white/80 backdrop-blur-md border-b border-border/40 shadow-xs">
      <div className="bg-white">
        <div className="container mx-auto px-4">
          <div className="flex items-center h-16 gap-2 md:gap-4">
            {/* Retour (mobile) */}
            <button
              type="button"
              onClick={handleBack}
              aria-label={t.back}
              className="lg:hidden shrink-0 w-9 h-9 flex items-center justify-center text-foreground rounded-full hover:bg-muted transition-colors"
            >
              <ArrowLeft size={22} />
            </button>

            {/* Logo */}
            <Link href="/" className="flex-shrink-0 flex items-center h-10 md:h-12 transition-transform active:scale-95">
              <Image src="/logo/logo.png" alt="MIAD Market" width={180} height={48} priority className="h-full w-auto object-contain brightness-100 contrast-125" />
            </Link>

            {/* Recherche desktop */}
            <div ref={searchDesktopRef} className="relative flex-1 hidden sm:flex max-w-2xl mx-4">
              <form onSubmit={runSearch} className="flex w-full">
                <div className="flex w-full rounded-full bg-slate-100/80 border border-transparent focus-within:bg-white focus-within:border-accent/50 focus-within:ring-4 focus-within:ring-accent/10 overflow-hidden transition-all duration-300">
                  <select
                    value={searchCategory}
                    onChange={(e) => setSearchCategory(e.target.value)}
                    aria-label={t.all}
                    className="hidden md:block px-4 py-2 bg-transparent text-muted-foreground text-[11px] font-black border-r border-gray-300 focus:outline-none cursor-pointer uppercase"
                  >
                    <option value="">{t.all}</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.slug}>{cat.name}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={query}
                    onFocus={() => { if (suggestions.length) setShowSuggestions(true) }}
                    onChange={(e) => { setQuery(e.target.value); setShowSuggestions(true) }}
                    placeholder={t.search}
                    className="flex-1 px-4 py-2 text-sm text-foreground bg-transparent focus:outline-none min-w-0"
                  />
                  <button
                    type="submit"
                    aria-label={t.search}
                    className="px-6 py-2 bg-accent hover:bg-accent/90 text-white transition-all active:scale-95"
                  >
                    <Search size={20} />
                  </button>
                </div>
              </form>
              {SuggestionsPanel}
            </div>

            {/* Icônes droite */}
            <div className="flex items-center gap-1 md:gap-4 ml-auto">
              <div className="flex items-center rounded-full border border-border overflow-hidden text-[10px] font-black">
                <button
                  type="button"
                  onClick={() => switchLang('fr')}
                  className={`px-2 py-1 transition-colors ${lang === 'fr' ? 'bg-accent text-white' : 'text-foreground/60 hover:text-accent'}`}
                >
                  FR
                </button>
                <button
                  type="button"
                  onClick={() => switchLang('en')}
                  className={`px-2 py-1 transition-colors ${lang === 'en' ? 'bg-accent text-white' : 'text-foreground/60 hover:text-accent'}`}
                >
                  EN
                </button>
              </div>

              <CurrencySelector />

              <button
                type="button"
                onClick={() => router.push('/?v=clientDashboard')}
                className="flex flex-col items-center gap-0.5 p-1 hover:text-accent transition-colors text-foreground/70"
                title={t.account}
              >
                <User size={22} />
                <span className="text-[10px] font-black uppercase hidden sm:block">{t.account}</span>
              </button>

              <button
                type="button"
                onClick={() => router.push('/?v=cart')}
                className="flex flex-col items-center gap-0.5 p-1 hover:text-accent transition-colors text-foreground/70 relative"
              >
                <div className="relative">
                  <ShoppingCart size={28} />
                  {cartCount > 0 && (
                    <span className="absolute -top-2 -right-2 bg-accent text-accent-foreground text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                      {cartCount > 9 ? '9+' : cartCount}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-black uppercase">{t.cart}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Recherche mobile */}
      <div ref={searchMobileRef} className="relative bg-white px-4 py-2 sm:hidden">
        <form onSubmit={runSearch}>
          <div className="flex rounded-full bg-[#f2f2f2] items-center px-4 py-1.5 border border-transparent focus-within:bg-white focus-within:border-accent">
            <Search size={18} className="text-muted-foreground mr-2" />
            <input
              type="text"
              value={query}
              onFocus={() => { if (suggestions.length) setShowSuggestions(true) }}
              onChange={(e) => { setQuery(e.target.value); setShowSuggestions(true) }}
              placeholder={t.search}
              className="flex-1 text-sm text-foreground bg-transparent focus:outline-none"
            />
          </div>
        </form>
        {SuggestionsPanel}
      </div>
    </header>
  )
}

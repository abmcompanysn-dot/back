"use client"

import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { Search, ShoppingCart, User, Menu, X, ChevronDown, Globe, HelpCircle, MessageCircle, LayoutDashboard, Package, Star, QrCode, BarChart2, Settings, Heart, MapPin, Tag, LogIn } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { countries, type WooCategory, translations } from '@/lib/woocommerce'
import { Skeleton } from '@/components/ui/skeleton'
import { CurrencySelector } from '@/components/miad/CurrencySelector'

interface SearchSuggestion {
  id: number
  name: string
  slug: string
  price: number
  image: string
  category: string
}

interface HeaderProps {
  cartCount: number
  selectedCountry?: string
  isLoggedIn?: boolean
  userType?: 'buyer' | 'vendor'
  categories: WooCategory[]
  isLoadingCategories?: boolean
  language: 'fr' | 'en'
  onLanguageChange: (lang: 'fr' | 'en') => void
  onCartClick: () => void
  onHomeClick: () => void
  onCategoryClick: (slug: string) => void
  onCountryClick?: (code: string, view?: any) => void
  onSearch: (query: string) => void
  // Terme de recherche piloté par le parent (MiadMarketClient) : sans ça le
  // Header gardait son propre useState local, jamais remis à jour quand le
  // parent restaure searchQuery au retour arrière → le champ revenait vide
  // en revenant sur des résultats de recherche (signalé le 2026-08-31).
  searchQuery?: string
  onLoginClick: () => void
  onDashboardClick: () => void
  onDashboardSectionClick?: (section: string) => void
  onHelpClick: (topic?: string) => void
  unreadMessages?: number
  isProductView?: boolean
}

const VENDOR_SECTIONS = [
  { id: 'overview',  label: 'Aperçu',       icon: LayoutDashboard },
  { id: 'products',  label: 'Produits',      icon: Package },
  { id: 'orders',    label: 'Commandes',     icon: ShoppingCart },
  { id: 'reviews',   label: 'Avis Clients',  icon: Star },
  { id: 'vitrine',   label: 'Vitrine / QR',  icon: QrCode },
  { id: 'analytics', label: 'Analytiques',   icon: BarChart2 },
  { id: 'settings',  label: 'Paramètres',    icon: Settings },
]

const CLIENT_SECTIONS = [
  { id: 'overview',   label: 'Aperçu',           icon: LayoutDashboard },
  { id: 'orders',     label: 'Mes commandes',     icon: Package },
  { id: 'wishlist',   label: 'Liste de souhaits', icon: Heart },
  { id: 'messages',   label: 'Messages',          icon: MessageCircle },
  { id: 'addresses',  label: 'Mes adresses',      icon: MapPin },
  { id: 'coupons',    label: 'Coupons & Points',  icon: Tag },
  { id: 'settings',   label: 'Paramètres',        icon: Settings },
  { id: 'qrcode',     label: 'Mon QR Code',       icon: QrCode },
]

export function Header({
  cartCount,
  isLoggedIn = false,
  userType = 'buyer',
  categories,
  isLoadingCategories,
  language,
  onLanguageChange,
  onCartClick,
  onHomeClick,
  onCategoryClick,
  onSearch,
  searchQuery: searchQueryProp,
  onLoginClick,
  onDashboardClick,
  onDashboardSectionClick,
  isProductView = false,
}: HeaderProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [helpMenuOpen, setHelpMenuOpen] = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  // Contrôlé par le parent quand searchQueryProp est fourni ; sinon état
  // local (Header réutilisé hors MiadMarketClient). setSearchQuery met à
  // jour le local ET remonte au parent via onSearch pour rester synchrones.
  const [searchQueryLocal, setSearchQueryLocal] = useState('')
  const searchQuery = searchQueryProp ?? searchQueryLocal
  const setSearchQuery = (v: string) => {
    setSearchQueryLocal(v)
    if (searchQueryProp !== undefined) onSearch(v)
  }
  const [searchCategory, setSearchCategory] = useState('')
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestLoading, setSuggestLoading] = useState(false)
  const flagsRef = useRef<HTMLDivElement>(null)
  const accountRef = useRef<HTMLDivElement>(null)
  const searchDesktopRef = useRef<HTMLDivElement>(null)
  const searchMobileRef = useRef<HTMLDivElement>(null)
  const searchProductMobileRef = useRef<HTMLFormElement>(null)
  const router = useRouter()

  // Suggestions "as you type" (style grands sites e-commerce) — debounce 250ms
  // pour ne pas spammer l'API à chaque frappe, requête annulée si l'utilisateur
  // continue de taper avant la fin du délai.
  useEffect(() => {
    const query = searchQuery.trim()
    if (query.length < 2) {
      setSuggestions([])
      setSuggestLoading(false)
      return
    }
    setSuggestLoading(true)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/search/suggestions?q=${encodeURIComponent(query)}&limit=6&lang=${language}`, { signal: controller.signal })
        .then(r => r.ok ? r.json() : { products: [] })
        .then(data => setSuggestions(Array.isArray(data.products) ? data.products : []))
        .catch(() => {})
        .finally(() => setSuggestLoading(false))
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [searchQuery, language])

  useEffect(() => {
    function handleClickOutsideSearch(e: MouseEvent) {
      const target = e.target as Node
      const insideDesktop = searchDesktopRef.current?.contains(target)
      const insideMobile = searchMobileRef.current?.contains(target)
      const insideProductMobile = searchProductMobileRef.current?.contains(target)
      if (!insideDesktop && !insideMobile && !insideProductMobile) setShowSuggestions(false)
    }
    document.addEventListener('mousedown', handleClickOutsideSearch)
    return () => document.removeEventListener('mousedown', handleClickOutsideSearch)
  }, [])

  const goToSuggestion = (s: SearchSuggestion) => {
    setShowSuggestions(false)
    setSearchQuery(s.name)
    // Même mécanisme que les <Link v=product&slug=...> rendus par les sections
    // serveur streamées : MiadMarketClient a déjà un effet qui réagit aux
    // changements de searchParams et charge le produit (fetch de secours par
    // slug si besoin) — pas besoin de callback dédié ici.
    router.push(`/?v=product&slug=${encodeURIComponent(s.slug)}`, { scroll: false })
  }

  const sections = userType === 'vendor' ? VENDOR_SECTIONS : CLIENT_SECTIONS

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const t = translations[language]

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setShowSuggestions(false)
    onSearch(searchQuery)
  }

  return (
    // isProductView sur mobile : la version complète (logo/devise/compte/panier)
    // reste masquée pour laisser l'image produit prendre tout le haut de l'écran
    // (demandé le 2026-07-23, ProductDetail a ses propres boutons partager/panier
    // flottants sur l'image). Une barre minimale (hamburger + recherche) est
    // affichée à la place plutôt que de masquer le header en entier — sans elle
    // la recherche et l'accès aux catégories devenaient impossibles depuis la
    // fiche produit sur mobile (signalé le 2026-07-30).
    <header className="sticky top-0 z-[60] w-full bg-white/80 backdrop-blur-md border-b border-border/40 shadow-xs">
      {isProductView && (
        <div className="sm:hidden flex items-center gap-3 h-14 px-4 bg-white text-foreground">
          <Menu
            size={24}
            className="shrink-0 cursor-pointer"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Menu"
          />
          <form onSubmit={handleSearch} className="flex-1 min-w-0" ref={searchProductMobileRef}>
            <div className="relative flex rounded-full bg-[#f2f2f2] items-center px-4 py-1.5 border border-transparent focus-within:bg-white focus-within:border-accent">
              <Search size={18} className="text-muted-foreground mr-2 shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onFocus={() => { if (suggestions.length) setShowSuggestions(true) }}
                onChange={(e) => { setSearchQuery(e.target.value); setShowSuggestions(true) }}
                placeholder={t.search}
                className="flex-1 min-w-0 text-sm text-foreground bg-transparent focus:outline-none"
              />
              {showSuggestions && searchQuery.trim().length >= 2 && (suggestions.length > 0 || suggestLoading) && (
                <div className="absolute left-0 right-0 top-full mt-2 bg-white rounded-2xl shadow-2xl border border-border overflow-hidden z-[70] animate-in fade-in slide-in-from-top-2 duration-150">
                  {suggestLoading && suggestions.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-muted-foreground">{language === 'fr' ? 'Recherche…' : 'Searching…'}</div>
                  ) : (
                    <ul>
                      {suggestions.map(s => (
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
              )}
            </div>
          </form>
        </div>
      )}
      <div className={`bg-white ${isProductView ? 'hidden sm:block' : ''}`}>
        <div className="container mx-auto px-4">
          <div className="flex items-center h-16 gap-2 md:gap-4">
            {/* Mobile Menu Button */}
            <Menu 
              size={24} 
              className="lg:hidden cursor-pointer text-foreground"
              onClick={() => setMobileMenuOpen(true)} 
            />

            {/* Logo */}
            <button type="button" onClick={onHomeClick} className="flex-shrink-0 flex items-center h-10 md:h-12 transition-transform active:scale-95">
              <Image src="/logo/logo.png" alt="MIAD Market" width={180} height={48} priority className="h-full w-auto object-contain brightness-100 contrast-125" />
            </button>

            {/* Search Bar - Allégée Style 2024 */}
            <div ref={searchDesktopRef} className="relative flex-1 hidden sm:flex max-w-2xl mx-4">
              <form onSubmit={handleSearch} className="flex w-full">
                <div className="flex w-full rounded-full bg-slate-100/80 border border-transparent focus-within:bg-white focus-within:border-accent/50 focus-within:ring-4 focus-within:ring-accent/10 overflow-hidden transition-all duration-300">
                  <select
                    value={searchCategory}
                    onChange={(e) => setSearchCategory(e.target.value)}
                    aria-label={t.categories}
                    className="hidden md:block px-4 py-2 bg-transparent text-muted-foreground text-[11px] font-black border-r border-gray-300 focus:outline-none cursor-pointer uppercase"
                  >
                    <option value="">{t.all}</option>
                    {Array.isArray(categories) && categories.map(cat => (
                      <option key={cat.id} value={cat.slug}>{cat.name}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={searchQuery}
                    onFocus={() => { if (suggestions.length) setShowSuggestions(true) }}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSearchQuery(val);
                      setShowSuggestions(true);
                      if (val.length > 2 || val.length === 0) {
                        onSearch(val); // Recherche dynamique
                      }
                    }}
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
              {showSuggestions && searchQuery.trim().length >= 2 && (suggestions.length > 0 || suggestLoading) && (
                <div className="absolute left-0 right-0 top-full mt-2 bg-white rounded-2xl shadow-2xl border border-border overflow-hidden z-[70] animate-in fade-in slide-in-from-top-2 duration-150">
                  {suggestLoading && suggestions.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-muted-foreground">{language === 'fr' ? 'Recherche…' : 'Searching…'}</div>
                  ) : (
                    <ul>
                      {suggestions.map(s => (
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
              )}
            </div>

            {/* Right Icons */}
            <div className="flex items-center gap-1 md:gap-4 ml-auto">
              {/* Switcher FR / EN — réactivé le 2026-07-16, défaut reste français (voir useState('fr') dans MiadMarketClient.tsx) */}
              <div className="flex items-center rounded-full border border-border overflow-hidden text-[10px] font-black">
                <button
                  type="button"
                  onClick={() => onLanguageChange('fr')}
                  className={`px-2 py-1 transition-colors ${language === 'fr' ? 'bg-accent text-white' : 'text-foreground/60 hover:text-accent'}`}
                >
                  FR
                </button>
                <button
                  type="button"
                  onClick={() => onLanguageChange('en')}
                  className={`px-2 py-1 transition-colors ${language === 'en' ? 'bg-accent text-white' : 'text-foreground/60 hover:text-accent'}`}
                >
                  EN
                </button>
              </div>

              {/* Currency Selector */}
              <CurrencySelector />

              {/* Account icon with hover/click dropdown */}
              <div
                ref={accountRef}
                className="relative"
                onMouseEnter={() => isLoggedIn && setAccountMenuOpen(true)}
                onMouseLeave={() => setAccountMenuOpen(false)}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (isLoggedIn) setAccountMenuOpen(o => !o)
                    else onLoginClick()
                  }}
                  className="flex flex-col items-center gap-0.5 p-1 hover:text-accent transition-colors text-foreground/70"
                  title={isLoggedIn ? 'Mon espace' : 'Connexion'}
                >
                  <User size={22} />
                  <span className="text-[10px] font-black uppercase hidden sm:block">{isLoggedIn ? 'Compte' : 'Connexion'}</span>
                </button>

                {/* Dropdown */}
                {isLoggedIn && accountMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 w-52 bg-white rounded-2xl shadow-2xl border border-border overflow-hidden z-[70] animate-in fade-in slide-in-from-top-2 duration-150">
                    <div className="px-4 py-2.5 bg-slate-50 border-b border-border">
                      <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Mon espace</p>
                    </div>
                    {sections.map(section => (
                      <button
                        type="button"
                        key={section.id}
                        onClick={() => {
                          setAccountMenuOpen(false)
                          if (onDashboardSectionClick) onDashboardSectionClick(section.id)
                          else onDashboardClick()
                        }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-accent/10 hover:text-accent transition-colors text-left text-sm text-foreground"
                      >
                        <section.icon size={14} className="shrink-0 text-muted-foreground" />
                        <span className="font-medium">{section.label}</span>
                      </button>
                    ))}
                    <div className="border-t border-border">
                      <button
                        type="button"
                        onClick={() => { setAccountMenuOpen(false); onDashboardClick() }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-accent/10 hover:text-accent transition-colors text-left text-sm text-foreground font-bold"
                      >
                        <LayoutDashboard size={14} className="shrink-0 text-accent" />
                        <span>Tableau de bord</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Cart */}
              <button
                type="button"
                onClick={onCartClick}
                className="flex flex-col items-center gap-0.5 p-1 hover:text-accent transition-colors text-foreground/70 relative"
              >
                <div className="relative">
                  <ShoppingCart size={28} />
                  {cartCount > 0 && (
                    <span className="absolute -top-2 -right-2 bg-accent text-accent-foreground text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                      {cartCount}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-black uppercase">{t.cart}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div ref={searchMobileRef} className={`relative bg-white px-4 py-2 ${isProductView ? 'hidden' : 'sm:hidden'}`}>
        <form onSubmit={handleSearch}>
          <div className="flex rounded-full bg-[#f2f2f2] items-center px-4 py-1.5 border border-transparent focus-within:bg-white focus-within:border-accent">
            <Search size={18} className="text-muted-foreground mr-2" />
            <input
              type="text"
              value={searchQuery}
              onFocus={() => { if (suggestions.length) setShowSuggestions(true) }}
              onChange={(e) => { setSearchQuery(e.target.value); setShowSuggestions(true) }}
              placeholder={t.search}
              className="flex-1 text-sm text-foreground bg-transparent focus:outline-none"
            />
          </div>
        </form>
        {showSuggestions && searchQuery.trim().length >= 2 && (suggestions.length > 0 || suggestLoading) && (
          <div className="absolute left-4 right-4 top-full mt-1 bg-white rounded-2xl shadow-2xl border border-border overflow-hidden z-[70] animate-in fade-in slide-in-from-top-2 duration-150">
            {suggestLoading && suggestions.length === 0 ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">{language === 'fr' ? 'Recherche…' : 'Searching…'}</div>
            ) : (
              <ul>
                {suggestions.map(s => (
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
        )}
      </div>

      {/* Mobile Menu Overlay — rendu via portail (document.body) : imbriqué
          dans <header> (sticky + z-[60]), il crée son propre contexte
          d'empilement, donc son z-[999]/z-[1000] ne comptait que face aux
          autres éléments DANS ce header, pas face au reste de la page —
          le menu se déroulait sous le contenu de l'accueil au lieu de
          par-dessus (signalé le 2026-07-30). Un portail vers document.body
          échappe complètement à ce contexte. */}
      {mobileMenuOpen && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[999] lg:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            role="button"
            tabIndex={0}
            aria-label={language === 'fr' ? 'Fermer' : 'Close'}
            onClick={() => setMobileMenuOpen(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setMobileMenuOpen(false) }}
          />
          <div className="absolute left-0 top-0 bottom-0 w-80 bg-background shadow-xl overflow-y-auto z-[1000]">
            {/* Menu Header */}
            <div className="bg-primary text-primary-foreground p-4 flex items-center gap-3">
              <User size={32} />
              <div>
                <p className="font-bold">{t.hello}</p>
                <button type="button" onClick={() => { onLoginClick(); setMobileMenuOpen(false) }} className="text-sm text-primary-foreground/70 hover:text-accent">
                  {t.identify}
                </button>
              </div>
            </div>

            {/* Categories */}
            <div className="p-4 border-b border-border">
              <h3 className="font-bold text-foreground mb-3 text-sm uppercase tracking-wide">{t.categories}</h3>
              {Array.isArray(categories) && categories.map(cat => (
                <button
                  type="button"
                  key={cat.id}
                  onClick={() => {
                    onCategoryClick(cat.slug)
                    setMobileMenuOpen(false)
                  }}
                  className="block w-full text-left py-2 px-3 hover:bg-muted rounded text-foreground transition-colors"
                >
                  {cat.name}
                </button>
              ))}
            </div>

            {/* Account Links */}
            <div className="p-4">
              <button
                type="button"
                onClick={() => { onDashboardClick(); setMobileMenuOpen(false) }}
                className="block w-full text-left py-2 px-3 hover:bg-muted rounded text-foreground"
              >
                {t.vendorSpace}
              </button>
            </div>

            {/* Close Button */}
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              aria-label={language === 'fr' ? 'Fermer' : 'Close'}
              className="absolute top-4 right-4 text-primary-foreground p-1 hover:bg-white/10 rounded"
            >
              <X size={24} />
            </button>
          </div>
        </div>,
        document.body
      )}
    </header>
  )
}

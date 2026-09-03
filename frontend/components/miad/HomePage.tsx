"use client"

import { useEffect, useMemo, useRef, useState } from 'react'
import Image from 'next/image'
import { mutate } from 'swr'
import { HeroSection } from './HeroSection'
import { CategoriesSection } from './CategoriesSection'
import { CountrySection } from './CountrySection'
import { LazyImage } from './LazyImage'
import { Skeleton } from '@/components/ui/skeleton'
import { countries, type WooProduct, type WooVendor, translations } from '@/lib/woocommerce'
import { proxyIfLocalWp } from '@/lib/image-utils'
import { useCurrency } from '@/contexts/CurrencyContext'
import { Store, Truck, ShieldCheck, Headphones, ChevronLeft, ChevronRight } from 'lucide-react'

interface HomePageProps {
  language: 'fr' | 'en'
  selectedCountry: string
  selectedCategory: string | null
  categories: any[]
  searchQuery: string
  onCountryChange: (code: string) => void
  onCategoryChange: (slug: string | null) => void
  onProductClick: (product: WooProduct) => void
  onAddToCart: (product: WooProduct) => void
  onStoreClick: (vendor: WooVendor) => void
  onNavigate: (view: any) => void
  onBecomeVendor: () => void
  onViewAllCountry?: (countryCode: string) => void
  productsLoading?: boolean
  productsByCountry: Record<string, WooProduct[]>
  storesByCountry: Record<string, WooVendor[]>
}

const TARGET_COUNTRIES = ['sn', 'ci', 'gh', 'ng', 'gn', 'cm', 'bj']

// ── Food Section ──────────────────────────────────────────────────────────────
function FoodSection({ products, onProductClick, t }: { products: WooProduct[], onProductClick: (p: WooProduct) => void, t: any }) {
  const { formatPrice: fp } = useCurrency()
  const [broken, setBroken] = useState<Set<string>>(new Set())
  const foodProducts = products.filter(p =>
    (p.categorySlug === 'alimentation' ||
    p.categories?.some((c: any) => c.slug === 'alimentation')) &&
    !broken.has(p.id)
  ).slice(0, 8)

  if (foodProducts.length === 0) return null

  return (
    <section className="py-16 bg-orange-50/30">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-3xl font-black uppercase tracking-tighter text-orange-900 italic">{t.groceries}</h2>
            <p className="text-sm text-orange-700/70 font-bold uppercase tracking-widest">{t.groceriesSub}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {foodProducts.map((p) => (
            <div key={p.id} onClick={() => onProductClick(p)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onProductClick(p) } }}
              className="bg-white rounded-[2rem] p-4 shadow-sm hover:shadow-xl transition-all cursor-pointer border border-orange-100 group">
              <div className="aspect-square rounded-2xl overflow-hidden mb-4 bg-orange-50">
                <LazyImage src={p.image} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" alt={p.name} decoding="async"
                  onError={() => setBroken(prev => new Set(prev).add(p.id))} />
              </div>
              <h3 className="text-sm font-bold text-foreground line-clamp-1">{p.name}</h3>
              <div className="flex items-center justify-between mt-2">
                <span className="text-orange-600 font-black">{fp(Number(p.price || 0))}</span>
                <span className="text-[10px] bg-orange-100 text-orange-700 px-2 py-1 rounded-full font-black uppercase">{t.fresh}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ── Vendor CTA ────────────────────────────────────────────────────────────────
// export : réutilisé tel quel par MiadMarketClient.tsx pour l'accueil par
// défaut streamé (cf. server/HomeSections.tsx) — pas de duplication.
export function VendorCTA({ onBecomeVendor, t }: { onBecomeVendor: () => void, t: any }) {
  return (
    <section className="py-14 bg-primary text-primary-foreground">
      <div className="max-w-4xl mx-auto px-4">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-accent rounded-full mb-4">
            <Store size={14} className="text-accent-foreground" />
            <span className="text-xs font-bold text-accent-foreground">{t.vendorSpace || 'Vendeur'}</span>
          </div>
          <h2 className="text-2xl md:text-3xl font-bold mb-3">{t.joinCommunity || 'Rejoignez-nous'}</h2>
          <p className="text-primary-foreground/75 max-w-xl mx-auto text-sm leading-relaxed">...</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          {[
            { icon: Store, label: t.freeShop || 'Boutique gratuite', sub: t.openIn5Min || 'Ouvrez en 5 min' },
            { icon: Truck, label: t.dhlDelivery || 'Livraison MIAD Express', sub: t.countriesPlus || '220+ pays' },
            { icon: ShieldCheck, label: t.securePayments || 'Paiements sécurisés', sub: 'Wave, Orange Money' },
            { icon: Headphones, label: t.dedicatedSupport || 'Support dédié', sub: t.hoursSupport || '24h/7j' },
          ].map(f => (
            <div key={f.label} className="text-center p-4 bg-white/5 rounded-xl">
              <f.icon size={22} className="text-accent mx-auto mb-2" />
              <p className="text-sm font-semibold">{f.label}</p>
              <p className="text-xs text-primary-foreground/60 mt-0.5">{f.sub}</p>
            </div>
          ))}
        </div>
        <div className="text-center">
          <button type="button" onClick={onBecomeVendor}
            className="inline-flex items-center gap-2 px-8 py-3.5 bg-accent text-accent-foreground font-bold rounded-xl hover:bg-accent/90 transition-colors text-sm">
            <Store size={17} />
            {t.openShop || 'Ouvrir ma boutique'}
          </button>
          <p className="text-primary-foreground/50 text-xs mt-3">{t.trustedBy || 'Plus de 50 000 vendeurs'}</p>
        </div>
      </div>
    </section>
  )
}

// Précharge le catalogue du vendeur (endpoint fiable, cf. app/api/products/route.ts)
// dès le survol de sa tuile, pour que sa page boutique s'affiche instantanément
// au clic — SWR garde ce résultat en cache (dedupingInterval côté VendorStorePage).
const storeProductsFetcher = (url: string) => fetch(url).then(res => res.json())
function prefetchStoreProducts(store: WooVendor) {
  // Pas de variations=true : doit matcher exactement la clé de VendorStorePage.tsx
  // (retiré le 2026-07-16, root cause du chargement boutique à 10+ secondes)
  const url = `/api/products?vendor=${store.id}&per_page=100`
  mutate(url, storeProductsFetcher(url), { revalidate: false })
}

// Repli propre quand la boutique n'a pas de logo (ou que l'image casse) —
// avant, le repli pointait vers /vendor-placeholder.png qui n'existe pas,
// donc l'image cassait et se cachait (onError), laissant un cercle vide.
function VendorAvatar({ logo, name, priority = false }: { logo?: string; name: string; priority?: boolean }) {
  const [errored, setErrored] = useState(false)
  const valid = !!logo && !errored
  return valid ? (
    <div className="relative w-full h-full">
      <Image
        src={proxyIfLocalWp(logo)!}
        fill
        className="object-cover rounded-full"
        alt={name}
        onError={() => setErrored(true)}
        priority={priority}
        loading={priority ? undefined : 'lazy'}
      />
    </div>
  ) : (
    <div className="w-full h-full flex items-center justify-center bg-primary text-primary-foreground font-bold text-lg rounded-full">
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

// ── Boutiques Officielles Strip ───────────────────────────────────────────────
// export : réutilisé tel quel par MiadMarketClient.tsx pour l'accueil par
// défaut streamé (cf. server/HomeSections.tsx) — pas de duplication.
// Position de défilement horizontal du strip, hors du cycle de vie React —
// le composant est démonté puis remonté au retour arrière depuis une
// boutique (contrairement au scroll vertical de la page, restauré par
// MiadMarketClient.tsx via navStack), donc scrollRef.current.scrollLeft
// repartait toujours à 0 même quand la page, elle, revenait à la bonne
// hauteur (signalé le 2026-08-26 : "on recommence au début" du strip).
let topVendorsStripScrollLeft = 0

export function TopVendorsStrip({ stores, onStoreClick, language = 'fr' }: { stores: WooVendor[]; onStoreClick: (v: WooVendor) => void; language?: 'fr' | 'en' }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = topVendorsStripScrollLeft
  }, [])

  if (stores.length === 0) return null
  const t = translations[language]

  // Sur ordinateur, rien n'indiquait qu'on pouvait glisser la souris pour
  // voir les boutiques suivantes (contrairement au swipe tactile, naturel
  // sur mobile) — flèches ajoutées, même mécanisme que CategoriesSection.tsx
  // (demandé le 2026-08-01 : "sur ordinateur faut faire des cliques").
  const scroll = (direction: 'left' | 'right') => {
    if (!scrollRef.current) return
    scrollRef.current.scrollBy({ left: direction === 'left' ? -300 : 300, behavior: 'smooth' })
  }

  return (
    <section className="py-8 bg-white border-b border-border/30">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Store size={20} className="text-accent" />
            <h2 className="text-xl font-black uppercase tracking-tighter italic">{t.officialStores}</h2>
          </div>
          <div className="hidden sm:flex gap-2">
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
        <div
          ref={scrollRef}
          onScroll={(e) => { topVendorsStripScrollLeft = e.currentTarget.scrollLeft }}
          className="flex gap-6 overflow-x-auto scrollbar-hide pb-4"
        >
          {stores.map((store, i) => (
            <button
              type="button"
              key={store.id}
              onClick={() => onStoreClick(store)}
              onMouseEnter={() => prefetchStoreProducts(store)}
              className="flex flex-col items-center gap-2 min-w-20 group cursor-pointer"
            >
              <div className="relative w-16 h-16">
                <div className="w-full h-full rounded-full border-2 border-border p-0.5 group-hover:border-accent transition-colors overflow-hidden bg-muted">
                  {/* Ce strip est tout en haut de l'accueil ("AVANT le hero",
                      voir commentaire de section) — les 8 premiers logos
                      (visibles dès le chargement, avant tout défilement)
                      chargent en priorité plutôt qu'en lazy, corrige le
                      chargement lent des logos signalé le 2026-09-03 (les
                      images restaient longtemps floues/vides sur cette
                      section pourtant visible immédiatement). Au-delà de 8,
                      lazy reste le bon choix (hors écran tant qu'on ne
                      défile pas). */}
                  <VendorAvatar logo={store.logo} name={store.name} priority={i < 8} />
                </div>
                {store.countryCode && (
                  <Image
                    src={`https://flagcdn.com/w40/${store.countryCode.toLowerCase()}.png`}
                    alt={store.country || store.countryCode}
                    width={18}
                    height={13}
                    className="absolute -bottom-0.5 -right-0.5 rounded-[3px] border border-white shadow-sm object-cover"
                  />
                )}
              </div>
              <span className="text-[10px] font-bold text-center line-clamp-1 w-full uppercase tracking-tighter group-hover:text-accent transition-colors">
                {store.name}
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

// ── Main HomePage ─────────────────────────────────────────────────────────────
export function HomePage({
  language,
  selectedCountry,
  selectedCategory,
  searchQuery,
  onCountryChange,
  onCategoryChange,
  onProductClick,
  onAddToCart,
  onStoreClick,
  onNavigate,
  onBecomeVendor,
  productsLoading,
  productsByCountry,
  storesByCountry,
  onViewAllCountry,
  categories,
}: HomePageProps) {
  const t = translations[language] as any

  const products: WooProduct[] = useMemo(() => Object.values(productsByCountry).flat(), [productsByCountry])
  const stores: WooVendor[]    = useMemo(() => Object.values(storesByCountry).flat(),   [storesByCountry])

  const normalizedProductsByCountry = useMemo(() => {
    const obj: Record<string, WooProduct[]> = {}
    Object.entries(productsByCountry).forEach(([k, v]) => { obj[k.toLowerCase()] = v })
    return obj
  }, [productsByCountry])

  const normalizedStoresByCountry = useMemo(() => {
    const obj: Record<string, WooVendor[]> = {}
    Object.entries(storesByCountry).forEach(([k, v]) => { obj[k.toLowerCase()] = v })
    return obj
  }, [storesByCountry])

  const orderedCountries = useMemo(() => {
    // selectedCountry arrive en MAJUSCULES depuis la détection géo serveur
    // (app/page.tsx: raw.toUpperCase()) mais les codes de `countries` sont en
    // minuscules — sans normaliser ici, ce find() ne matchait jamais, la
    // bannière de bienvenue ne montrait donc jamais le bon pays en premier.
    const code = selectedCountry.toLowerCase()
    const filtered = countries.filter(c =>
      TARGET_COUNTRIES.includes(c.code) ||
      c.code === code ||
      normalizedProductsByCountry[c.code]?.length > 0 ||
      normalizedStoresByCountry[c.code]?.length > 0
    )
    const selected = filtered.find(c => c.code === code)
    const others = filtered.filter(c => c.code !== code)
    return selected ? [selected, ...others] : filtered
  }, [selectedCountry, normalizedProductsByCountry, normalizedStoresByCountry])

  // Marché [Pays] retiré de l'accueil par défaut (demandé le 2026-07-24/25),
  // MAIS ce composant est aussi le rendu des résultats de recherche/filtre
  // catégorie (cf. MiadMarketClient.tsx : HomePage sert de repli dès qu'un
  // filtre est actif ou que la langue passe en anglais) — CountrySection est
  // ici le seul mécanisme d'affichage des produits filtrés. Le retrait ne
  // s'applique donc qu'en navigation libre (sans filtre), pas aux résultats
  // de recherche.
  const filterActive = Boolean(selectedCategory) || Boolean(searchQuery)
  // Tentative du 2026-07-26 : afficher aussi les sections Marché [Pays] sur
  // l'accueil anglais sans filtre, en pensant réparer un "accueil anglais
  // vide". Revert le même jour (demande du fondateur) : ces sections sont
  // volontairement absentes de la navigation libre, y compris en français
  // (déplacées vers /promotions le 2026-07-24/25) — l'accueil anglais doit
  // rester à parité avec le français ici, pas afficher plus que lui. Le vrai
  // trou entre FR et EN est ailleurs : `homeSections` (contenu streamé
  // serveur, cf. MiadMarketClient.tsx) n'existe qu'en français — c'est CE
  // contenu-là qui "disparaît" en anglais, pas les sections Marché.
  const showProductSections = filterActive

  const filterProducts = (list: WooProduct[]) => {
    let out = list
    if (selectedCategory) out = out.filter(p => p.categorySlug === selectedCategory)
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      out = out.filter(p =>
        p.name?.toLowerCase().includes(q) ||
        p.vendor?.name?.toLowerCase().includes(q) ||
        (p as any).categories?.some((cat: any) => cat.name?.toLowerCase().includes(q))
      )
    }
    return out.sort((a, b) => (a.vendor?.id || '').localeCompare(b.vendor?.id || '')).slice(0, 600)
  }

  return (
    <main className="bg-muted/20 min-h-screen">

      {/* ① Boutiques Officielles — AVANT le hero */}
      <TopVendorsStrip stores={stores} onStoreClick={onStoreClick} language={language} />

      {/* ② Hero slider */}
      <HeroSection
        onExplore={() => document.getElementById('categories-section')?.scrollIntoView({ behavior: 'smooth' })}
        onLearnMore={() => document.getElementById('hero-features')?.scrollIntoView({ behavior: 'smooth' })}
        onViewStores={() => onNavigate('storesList')}
        language={language}
      />

      {/* Skeleton pendant le chargement initial */}
      {productsLoading && products.length === 0 && (
        <section className="py-20 bg-white border-b border-border/30">
          <div className="container mx-auto px-4">
            <div className="flex items-center gap-3 mb-8">
              <Skeleton className="w-12 h-12 rounded-2xl" />
              <Skeleton className="h-8 w-64 rounded-xl" />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
              <Skeleton className="lg:col-span-7 aspect-video rounded-[3rem]" />
              <div className="lg:col-span-5 grid grid-cols-2 gap-4">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="space-y-3">
                    <Skeleton className="aspect-square rounded-4xl" />
                    <Skeleton className="h-3 w-3/4 rounded" />
                    <Skeleton className="h-5 w-1/2 rounded" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ⑥ Catégories */}
      <CategoriesSection
        categories={categories}
        selectedCategory={selectedCategory}
        onSelectCategory={onCategoryChange}
        language={language}
      />

      {/* Skeleton sections pays — uniquement pendant une recherche/filtre
          (résultats affichés via CountrySection ci-dessous) ; en navigation
          libre les sections pays ne sont plus affichées ici (déplacées vers
          /promotions, demandé le 2026-07-24/25). */}
      {showProductSections && productsLoading && products.length === 0 && (
        <div id="country-sections" className="py-8">
          <div className="container mx-auto px-4 space-y-12">
            {[0, 1, 2].map(section => (
              <div key={section}>
                <div className="flex items-center gap-3 mb-6">
                  <Skeleton className="w-1 h-8 rounded-full" />
                  <Skeleton className="h-7 w-48 rounded-xl" />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                  {[...Array(6)].map((_, i) => (
                    <div key={i} className="space-y-2">
                      <Skeleton className="aspect-square rounded-2xl" />
                      <Skeleton className="h-3 w-3/4 rounded" />
                      <Skeleton className="h-4 w-1/2 rounded" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ⑨ Sections par pays — retirées de la navigation libre (déplacées
          vers /promotions, demandé le 2026-07-24/25) ; conservées ici
          uniquement quand une recherche/filtre catégorie est active, seul
          mécanisme d'affichage des résultats filtrés dans ce composant de
          repli (HomePage sert de repli à l'accueil streamé par défaut dès
          qu'un filtre est actif ou que la langue passe en anglais, cf.
          MiadMarketClient.tsx). */}
      <div id="country-sections" className="py-4">
        {showProductSections && orderedCountries.map(country => {
          const countryProducts = normalizedProductsByCountry[country.code] || []
          // Limité à 8 sur l'accueil : les logos/bannières vendeurs sont encore
          // servis depuis le serveur WordPress (pas le CDN, cf. CLAUDE.md —
          // migration abandonnée après incident), donc chaque boutique de plus
          // ajoute une requête lente en parallèle. Le bouton "Voir tout" mène
          // à la liste complète, non limitée, de la page pays dédiée.
          const countryStores = (normalizedStoresByCountry[country.code] || []).slice(0, 8)
          const filtered = filterProducts(countryProducts)
          if (filtered.length === 0 && countryStores.length === 0) return null
          return (
            <CountrySection
              key={country.code}
              language={language}
              country={country}
              products={filtered}
              stores={countryStores}
              isLoadingProducts={productsLoading}
              isHomepage={true}
              onStoreClick={onStoreClick}
              onProductClick={onProductClick}
              onAddToCart={onAddToCart}
              onViewAll={onViewAllCountry}
            />
          )
        })}

        <FoodSection products={products} onProductClick={onProductClick} t={t} />

        {products.length === 0 && !productsLoading && (
          <div className="container mx-auto px-4 py-20 text-center">
            <p className="text-2xl text-muted-foreground mb-3">{t.noProducts || 'Aucun produit'}</p>
            <p className="text-muted-foreground text-sm">...</p>
          </div>
        )}
      </div>

      {/* ⑩ CTA Vendeur */}
      <VendorCTA onBecomeVendor={onBecomeVendor} t={t} />
    </main>
  )
}

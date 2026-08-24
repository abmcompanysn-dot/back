'use client'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import {
  Star, Package, CheckCircle, Share2, Check, Link2, MessageCircle,
  Facebook, Twitter, ShoppingBag
} from 'lucide-react'
import { LazyImage } from './LazyImage'
import { proxyIfLocalWp } from '@/lib/image-utils'

const regionDisplayNames = new Intl.DisplayNames(['fr'], { type: 'region' })

function getCountryName(code: string): string {
  if (!code || code.length !== 2) return code
  try {
    return regionDisplayNames.of(code.toUpperCase()) || code
  } catch {
    return code
  }
}
import { StandaloneHeader } from './StandaloneHeader'
import { useCurrency } from '@/contexts/CurrencyContext'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface VendorProduct {
  id: string
  name: string
  slug: string
  price: number
  regularPrice?: number
  currency: string
  image: string
  images?: string[]
  categories?: { name: string; slug: string }[]
  countryCode?: string
  rating?: number
  salesCount?: number
  inStock?: boolean
}

interface Vendor {
  id: string
  name: string
  slug: string
  logo?: string
  banner?: string
  country?: string
  countryCode?: string
  rating?: number
  verified?: boolean
  productCount?: number
}

interface VendorStoreWrapperProps {
  vendor: Vendor
  products: VendorProduct[]
  total?: number
  totalPages?: number
}

function ShareVendorButton({ vendor }: { vendor: Vendor }) {
  const [copied, setCopied] = useState(false)
  const url = `https://www.miadmarket.com/vendor/${vendor.slug}`
  const title = vendor.name
  const desc = `Découvrez la boutique ${vendor.name} sur MIAD Market`

  const copyLink = async () => {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    toast.success('Lien copié !')
    setTimeout(() => setCopied(false), 2000)
  }

  const shareNative = async () => {
    if (navigator.share) {
      try { await navigator.share({ title, text: desc, url }) } catch {}
    } else {
      copyLink()
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="rounded-full border-slate-200 bg-white shadow-sm gap-2 px-4">
          <Share2 size={15} />
          <span className="text-xs font-bold uppercase tracking-wide">Partager</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52 rounded-2xl shadow-xl border-slate-100 p-1">
        <DropdownMenuItem className="flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer" onClick={copyLink}>
          {copied ? <Check size={16} className="text-green-500" /> : <Link2 size={16} className="text-slate-500" />}
          <span className="text-sm font-medium">{copied ? 'Lien copié !' : 'Copier le lien'}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1" />
        <DropdownMenuItem asChild>
          <a href={`https://wa.me/?text=${encodeURIComponent(`${title}\n${url}`)}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer">
            <MessageCircle size={16} className="text-green-500" />
            <span className="text-sm font-medium">WhatsApp</span>
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer">
            <Facebook size={16} className="text-blue-600" />
            <span className="text-sm font-medium">Facebook</span>
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer">
            <Twitter size={16} className="text-sky-500" />
            <span className="text-sm font-medium">X / Twitter</span>
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function VendorStoreWrapper({ vendor, products, total = 0, totalPages = 1 }: VendorStoreWrapperProps) {
  const router = useRouter()
  const { formatPrice: fp } = useCurrency()
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const countryCode = (vendor.countryCode || vendor.country || '').toUpperCase()
  const countryName = getCountryName(countryCode)
  const flagUrl = countryCode.length === 2 ? `https://flagcdn.com/w80/${countryCode.toLowerCase()}.png` : ''
  const [allProducts, setAllProducts] = useState(products)
  const [currentPage, setCurrentPage] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)
  const categoryBarRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({})

  const hasMore = currentPage < totalPages

  const loadMore = async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/vendor/${vendor.id}/products?page=${currentPage + 1}`)
      if (res.ok) {
        const data = await res.json()
        setAllProducts(prev => [...prev, ...(data.products || [])])
        setCurrentPage(p => p + 1)
      }
    } finally {
      setLoadingMore(false)
    }
  }

  // Resynchronise l'état local quand la liste de produits vient du serveur change
  useEffect(() => {
    setAllProducts(products)
    setCurrentPage(1)
  }, [products])

  // Group products by category
  const byCategory = useMemo(() => {
    const groups: Record<string, VendorProduct[]> = {}
    for (const p of allProducts) {
      const cat = p.categories?.[0]?.name || 'Divers'
      if (!groups[cat]) groups[cat] = []
      groups[cat].push(p)
    }
    return groups
  }, [allProducts])

  const categoryNames = Object.keys(byCategory)

  // Scroll active category button into view
  useEffect(() => {
    if (!activeCategory || !categoryBarRef.current) return
    const btn = categoryBarRef.current.querySelector(`[data-cat="${activeCategory}"]`) as HTMLElement
    if (btn) btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [activeCategory])

  // IntersectionObserver — highlight active category on scroll
  useEffect(() => {
    if (categoryNames.length === 0) return
    const observers: IntersectionObserver[] = []

    categoryNames.forEach((cat) => {
      const el = sectionRefs.current[cat]
      if (!el) return
      const obs = new IntersectionObserver(
        ([entry]) => { if (entry.isIntersecting) setActiveCategory(cat) },
        { threshold: 0.25, rootMargin: '-100px 0px -60% 0px' }
      )
      obs.observe(el)
      observers.push(obs)
    })

    return () => observers.forEach((o) => o.disconnect())
  }, [categoryNames])

  const scrollToCategory = useCallback((cat: string) => {
    setActiveCategory(cat)
    const el = sectionRefs.current[cat]
    if (el) {
      const offset = 120 // header + category bar height
      const top = el.getBoundingClientRect().top + window.scrollY - offset
      window.scrollTo({ top, behavior: 'smooth' })
    }
  }, [])

  const handleProductClick = (slug: string) => router.push(`/product/${slug}`)

  return (
    <div className="min-h-screen bg-background">
      <StandaloneHeader
        mode="vendor"
        title={vendor.name}
        subtitle={`${vendor.productCount || 0} produits`}
        image={vendor.logo || vendor.banner || undefined}
        rating={vendor.rating}
        verified={vendor.verified}
        countryCode={vendor.countryCode || vendor.country}
      />

      {/* ── BANDE CATÉGORIES STICKY ── */}
      {categoryNames.length > 1 && (
        <div className="sticky top-14 z-40 bg-white/95 backdrop-blur-sm border-b border-border shadow-sm">
          <div
            ref={categoryBarRef}
            className="flex items-center gap-3 overflow-x-auto scrollbar-hide px-4 py-3"
          >
            {/* Pill "Tout" */}
            <button
              type="button"
              onClick={() => { setActiveCategory(null); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
              className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-wide border transition-all ${activeCategory === null ? 'bg-primary text-white border-primary shadow' : 'border-border text-muted-foreground hover:border-primary/40'}`}
            >
              Tout
              <span className="opacity-70">{products.length}</span>
            </button>

            <div className="w-px h-8 bg-border shrink-0" />

            {categoryNames.map((cat) => {
              const count = byCategory[cat].length
              const isActive = activeCategory === cat
              const firstImg = byCategory[cat][0]?.image
              return (
                <button
                  key={cat}
                  data-cat={cat}
                  type="button"
                  onClick={() => scrollToCategory(cat)}
                  className={`flex flex-col items-center gap-1 shrink-0 transition-all ${isActive ? 'opacity-100' : 'opacity-55 hover:opacity-85'}`}
                >
                  <div className={`w-12 h-12 rounded-full overflow-hidden border-2 transition-all shadow-sm ${isActive ? 'border-accent shadow-accent/30 scale-110' : 'border-border/60'}`}>
                    {firstImg ? (
                      <LazyImage src={firstImg} alt={cat} className="w-full h-full object-cover" />
                    ) : (
                      <div className={`w-full h-full flex items-center justify-center text-sm font-black ${isActive ? 'bg-accent text-white' : 'bg-muted text-muted-foreground'}`}>
                        {cat[0]}
                      </div>
                    )}
                  </div>
                  <span className={`text-[9px] font-black uppercase tracking-tight leading-none max-w-14 text-center truncate ${isActive ? 'text-accent' : 'text-muted-foreground'}`}>
                    {cat}
                  </span>
                  <span className={`text-[8px] font-bold leading-none ${isActive ? 'text-accent' : 'text-muted-foreground/50'}`}>
                    {count}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ── BANNER VENDEUR ── */}
      <div className="h-52 md:h-72 bg-muted relative overflow-hidden">
        {vendor.banner ? (
          <Image src={proxyIfLocalWp(vendor.banner)!} alt={vendor.name} fill sizes="100vw" className="object-cover" />
        ) : (
          <div className="w-full h-full bg-linear-to-br from-primary to-accent/50" />
        )}
        <div className="absolute inset-0 bg-linear-to-t from-black/60 via-black/20 to-transparent" />

        {/* Badge pays en bas à gauche du banner */}
        {flagUrl && (
          <div className="absolute bottom-5 left-5 z-10 flex items-center gap-3 bg-black/50 backdrop-blur-md text-white px-4 py-2.5 rounded-2xl border border-white/20 shadow-xl">
            <Image
              src={flagUrl}
              alt={countryName}
              width={40}
              height={28}
              className="object-cover rounded-md shadow-md border border-white/30"
            />
            <div className="flex flex-col leading-tight">
              <span className="text-[10px] font-bold uppercase tracking-widest text-white/60">Origine</span>
              <span className="text-base font-black">{countryName}</span>
            </div>
          </div>
        )}
      </div>

      <div className="container mx-auto px-4 max-w-6xl -mt-14 relative z-10">
        {/* ── CARD PROFIL VENDEUR ── */}
        <div className="bg-card border border-border rounded-2xl p-5 shadow-xl flex flex-col md:flex-row items-center gap-5 mb-10">
          <div className="relative w-24 h-24 rounded-full border-4 border-background bg-white overflow-hidden shrink-0 shadow-lg">
            {vendor.logo ? (
              <Image src={proxyIfLocalWp(vendor.logo)!} alt={vendor.name} fill sizes="96px" className="object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-primary text-white text-3xl font-black">
                {vendor.name[0]}
              </div>
            )}
          </div>

          <div className="flex-1 text-center md:text-left">
            <div className="flex items-center justify-center md:justify-start gap-2 flex-wrap">
              <h1 className="text-2xl font-black">{vendor.name}</h1>
              {vendor.verified && (
                <span className="text-[10px] font-black uppercase bg-accent/10 text-accent px-2 py-0.5 rounded-full border border-accent/20 flex items-center gap-1">
                  <CheckCircle size={10} /> Vérifié
                </span>
              )}
            </div>
            <div className="flex items-center justify-center md:justify-start gap-4 mt-1.5 text-sm text-muted-foreground flex-wrap">
              {(vendor.rating ?? 0) > 0 && (
                <span className="flex items-center gap-1">
                  <Star size={13} className="fill-amber-400 text-amber-400" />
                  <strong>{(vendor.rating ?? 0).toFixed(1)}</strong>
                </span>
              )}
              <span className="flex items-center gap-1">
                <Package size={13} />
                {allProducts.length > 0 ? `${allProducts.length}${total > allProducts.length ? `/${total}` : ''} produits` : `${vendor.productCount ?? 0} produits`}
              </span>
              {flagUrl && (
                <span className="flex items-center gap-1.5">
                  <Image
                    src={flagUrl.replace('w80', 'w20')}
                    alt={countryName}
                    width={20}
                    height={14}
                    className="object-cover rounded-sm border border-border/40"
                  />
                  <span>{countryName}</span>
                </span>
              )}
            </div>
          </div>

          <ShareVendorButton vendor={vendor} />
        </div>

        {/* ── PRODUITS PAR CATÉGORIE ── */}
        {allProducts.length === 0 ? (
          <div className="text-center py-28 opacity-40">
            <Package size={56} className="mx-auto mb-4" />
            <p className="font-bold uppercase text-sm">Aucun produit disponible</p>
          </div>
        ) : (
          <>
          <div className="space-y-14 pb-10">
            {categoryNames.map((cat) => (
              <section
                key={cat}
                id={`cat-${cat}`}
                ref={(el) => { sectionRefs.current[cat] = el }}
              >
                <div className="flex items-center gap-3 mb-5">
                  <div className="h-7 w-1 bg-accent rounded-full" />
                  <h2 className="text-lg font-black uppercase tracking-tight">{cat}</h2>
                  <span className="text-xs text-muted-foreground font-bold">({byCategory[cat].length})</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                  {byCategory[cat].map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => handleProductClick(product.slug)}
                      className="group bg-card border border-border rounded-xl overflow-hidden hover:shadow-lg hover:border-accent/30 transition-all flex flex-col text-left"
                    >
                      <div className="aspect-square relative overflow-hidden bg-muted">
                        <LazyImage
                          src={product.image || '/placeholder.svg'}
                          alt={product.name}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        />
                        {product.countryCode && (
                          <div className="absolute top-1.5 left-1.5 bg-white/90 px-1.5 py-0.5 rounded text-[9px] font-black shadow-sm uppercase">
                            {product.countryCode}
                          </div>
                        )}
                        {(product.regularPrice ?? 0) > product.price && (
                          <div className="absolute top-1.5 right-1.5 bg-red-500 text-white px-1.5 py-0.5 rounded text-[9px] font-black">
                            -{Math.round((1 - product.price / (product.regularPrice ?? product.price)) * 100)}%
                          </div>
                        )}
                      </div>
                      <div className="p-2.5 flex flex-col flex-1">
                        <h3 className="text-xs font-medium line-clamp-2 leading-tight mb-1.5 group-hover:text-accent transition-colors">
                          {product.name}
                        </h3>
                        {(product.rating ?? 0) > 0 && (
                          <div className="flex items-center gap-1 mb-1.5">
                            <Star size={10} className="fill-orange-400 text-orange-400" />
                            <span className="text-[10px] font-bold">{(product.rating ?? 0).toFixed(1)}</span>
                          </div>
                        )}
                        <div className="mt-auto">
                          <p className="font-black text-sm text-accent">
                            {fp(product.price)}
                          </p>
                          {(product.regularPrice ?? 0) > product.price && (
                            <p className="text-[10px] text-muted-foreground line-through">
                              {fp(product.regularPrice ?? 0)}
                            </p>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {/* ── CHARGER PLUS ── */}
          {hasMore && (
            <div className="flex flex-col items-center gap-2 py-10">
              <p className="text-xs text-muted-foreground font-medium">
                {allProducts.length} sur {total} produits affichés
              </p>
              <Button
                onClick={loadMore}
                disabled={loadingMore}
                variant="outline"
                className="rounded-full px-8 py-5 font-black uppercase tracking-wide border-2 hover:border-accent hover:text-accent transition-all"
              >
                {loadingMore ? 'Chargement…' : 'Voir plus de produits'}
              </Button>
            </div>
          )}
          </>
        )}
      </div>

      {/* ── FOOTER ── */}
      <footer className="bg-primary text-white/60 text-center py-8 text-xs">
        <div className="flex items-center justify-center gap-2 mb-2">
          <ShoppingBag size={16} className="text-accent" />
          <p className="font-black text-white text-sm italic uppercase tracking-tighter">MIAD Market</p>
        </div>
        <p>Le marché africain en ligne · Qualité garantie · Livraison internationale</p>
        <Link href="/" className="inline-block mt-3 text-accent font-bold underline underline-offset-2 text-xs">
          Découvrir tous les produits →
        </Link>
      </footer>
    </div>
  )
}

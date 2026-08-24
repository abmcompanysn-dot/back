"use client"

import { useState } from 'react'
import useSWR from 'swr'
import Image from 'next/image'
import { Store, LayoutGrid, Package, Star, Share2, Grid, List, MapPin } from 'lucide-react'
import { type Country, type WooVendor, type WooCategory, type WooProduct } from '@/lib/woocommerce'
import { useCurrency } from '@/contexts/CurrencyContext'
import { Button } from '@/components/ui/button'
import { LazyImage } from './LazyImage'
import { proxyIfLocalWp } from '@/lib/image-utils'


const countryFetcher = (url: string) => fetch(url).then(res => {
  const contentType = res.headers.get("content-type");
  if (!res.ok || !contentType || !contentType.includes("application/json")) {
    throw new Error(`Le serveur a renvoyé une réponse inattendue (${res.status}). Vérifiez la configuration de l'API.`);
  }
  return res.json();
})

interface CountryPageProps {
  country: Country
  vendors: WooVendor[]
  products: WooProduct[]
  categories: WooCategory[]
  recommendedProducts?: WooProduct[]
  onBack: () => void
  onStoreClick: (vendor: WooVendor) => void
  onProductClick: (product: WooProduct) => void
  onAddToCart: (product: WooProduct) => void
  onCategoryClick: (slug: string) => void
}


function ShareButton({ title, url }: { title: string, url?: string }) {
  const handleShare = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (navigator.share) {
      navigator.share({ title, url: url || window.location.href }).catch(() => {})
    }
  }
  return (
    <button
      type="button"
      onClick={handleShare}
      aria-label="Partager"
      className="mia-share-btn absolute top-2 right-2 p-2 rounded-full bg-white/90 hover:bg-white text-primary shadow-sm z-20 transition-all hover:scale-110"
    >
      <Share2 size={14} />
    </button>
  )
}

export function CountryPage({ 
  country, 
  vendors,
  products,
  categories,
  recommendedProducts = [],
  onBack, 
  onStoreClick,
  onProductClick,
  onAddToCart,
  onCategoryClick
}: CountryPageProps) {
  const { formatPrice: fp } = useCurrency()
  const [selectedCity, setSelectedCity] = useState<string | null>(null)
  const [layoutMode, setLayoutMode] = useState<'grid' | 'scroll'>('grid')

  // Les données sont maintenant injectées depuis le parent (page.tsx)
  // On garde SWR uniquement pour les cas de filtrage par ville si nécessaire
  const vendorsLoading = !vendors
  const productsLoading = !products

  return (
    <main className="min-h-screen bg-background">
      {/* Hero Banner Country */}
      <div className="relative h-60 md:h-80 bg-primary overflow-hidden">
        <div className="absolute inset-0 bg-black/30 z-10" />
        <Image
          src={`https://flagcdn.com/w1280/${country.code}.png`}
          alt={country.name}
          fill
          sizes="100vw"
          className="object-cover opacity-40 blur-sm scale-110"
        />
        {/* Bouton retour retiré (2026-07-24), même choix que produit/boutique :
            navigation arrière laissée au geste natif / bouton du navigateur. */}
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center text-white">
          <Image
            src={`https://flagcdn.com/w160/${country.code}.png`}
            alt=""
            width={96}
            height={64}
            className="w-24 h-16 object-cover rounded-lg shadow-2xl mb-4 border-2 border-white/50"
          />
          <h1 className="text-4xl md:text-5xl font-black uppercase tracking-tighter drop-shadow-lg">
            {country.name}
          </h1>
          <p className="mt-2 text-white/80 font-medium tracking-widest uppercase text-sm">Marché Local MIAD</p>
        </div>
      </div>

      <div className="container mx-auto px-4 py-12 space-y-16">
        {/* City Filter Selection (Communicates with PHP city parameter) */}
        <div className="flex gap-2 overflow-x-auto pb-4 scrollbar-hide">
          <Button 
            variant={!selectedCity ? "default" : "outline"} 
            size="sm" 
            onClick={() => setSelectedCity(null)}
            className="rounded-full gap-2"
          >
            <MapPin size={14} /> Toutes les villes
          </Button>
          {['Dakar', 'Abidjan', 'Lomé', 'Douala', 'Libreville'].map(city => (
            <Button
              key={city}
              variant={selectedCity === city ? "default" : "outline"}
              size="sm"
              onClick={() => setSelectedCity(city)}
              className="rounded-full"
            >
              {city}
            </Button>
          ))}
        </div>

        {/* Vendors Section */}
        <section>
          <div className="flex items-center justify-between gap-3 mb-8">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-accent/10 rounded-lg text-accent">
                <Store size={24} />
              </div>
              <h2 className="text-2xl font-bold">Boutiques de {country.name}</h2>
            </div>
            <div className="flex gap-1 border rounded-lg p-1">
              <Button variant="ghost" size="icon" className={`h-8 w-8 ${layoutMode === 'grid' ? 'bg-muted' : ''}`} onClick={() => setLayoutMode('grid')}><Grid size={16} /></Button>
              <Button variant="ghost" size="icon" className={`h-8 w-8 ${layoutMode === 'scroll' ? 'bg-muted' : ''}`} onClick={() => setLayoutMode('scroll')}><List size={16} /></Button>
            </div>
          </div>

          {vendors.length === 0 ? (
            <div className="py-16 flex flex-col items-center text-center">
              <Store size={48} className="text-muted-foreground opacity-20 mb-4" />
              <p className="font-semibold text-foreground mb-1">Aucune boutique enregistrée</p>
              <p className="text-sm text-muted-foreground">Les boutiques de {country.name} apparaîtront ici.</p>
            </div>
          ) : (
            <div className={layoutMode === 'grid' ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6" : "flex gap-6 overflow-x-auto pb-4 scrollbar-hide"}>
              {vendors.map((vendor: WooVendor) => (
              <div
                key={vendor.id}
                onClick={() => onStoreClick(vendor)}
                role="button"
                tabIndex={0}
                className={`mia-store-card group bg-card border rounded-2xl overflow-hidden cursor-pointer hover:shadow-xl transition-all relative ${layoutMode === 'scroll' ? 'shrink-0 w-72' : ''}`}
              >
                <ShareButton title={vendor.name} />
                <div className="h-24 bg-muted relative">
                  {vendor.banner && (
                    <Image
                      src={proxyIfLocalWp(vendor.banner)!}
                      alt=""
                      fill
                      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                      className="object-cover"
                      loading="lazy"
                    />
                  )}
                  <div className="absolute -bottom-6 left-4 w-12 h-12 rounded-full border-4 border-card bg-primary flex items-center justify-center text-white font-bold overflow-hidden shadow-md">
                    {vendor.logo ? <Image src={proxyIfLocalWp(vendor.logo)!} alt={vendor.name} fill sizes="48px" className="object-cover" /> : vendor.name[0]}
                  </div>
                </div>
                <div className="pt-8 px-4 pb-4">
                  <h3 className="font-bold group-hover:text-accent transition-colors">{vendor.name}</h3>
                  <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
                    <Star size={14} className="text-accent fill-accent" />
                    <span>{vendor.rating}</span>
                  </div>
                </div>
              </div>
            ))}
            </div>
          )}
        </section>

        {/* Categories Section */}
        <section>
          <div className="flex items-center gap-3 mb-8">
            <div className="p-2 bg-primary/10 rounded-lg text-primary">
              <LayoutGrid size={24} />
            </div>
            <h2 className="text-2xl font-bold">Catégories Disponibles</h2>
          </div>
          <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
            {categories.map(cat => (
              <button
                key={cat.id}
                type="button"
                onClick={() => onCategoryClick(cat.slug)}
                className="shrink-0 px-6 py-3 bg-muted hover:bg-accent hover:text-accent-foreground rounded-full font-bold transition-all border border-transparent hover:border-accent"
              >
                {cat.name}
              </button>
            ))}
          </div>
        </section>

        {/* Top Products from Country */}
        <section>
          {products.length > 0 ? (
            <>
              <div className="flex items-center gap-3 mb-8">
                <div className="p-2 bg-accent/10 rounded-lg text-accent">
                  <Package size={24} />
                </div>
                <h2 className="text-2xl font-bold">Produits à la une en {country.name}</h2>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
                {products.map(product => (
                  <div
                    key={product.id}
                    onClick={() => onProductClick(product)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onProductClick(product) }}
                    role="button"
                    tabIndex={0}
                    className="bg-card border rounded-xl overflow-hidden cursor-pointer hover:shadow-md transition-all group"
                  >
                    <div className="aspect-square bg-muted overflow-hidden">
                      <LazyImage src={product.image} alt={product.name} decoding="async" className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                    </div>
                    <div className="p-3">
                      <h4 className="text-sm font-medium line-clamp-2 h-10">{product.name}</h4>
                      <p className="mt-2 font-bold text-accent">{fp(product.price)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : recommendedProducts.length > 0 && (
            <>
              <div className="mb-8 p-6 bg-muted/50 rounded-2xl border border-dashed border-border text-center">
                <p className="text-muted-foreground font-medium">Nous préparons actuellement les arrivages pour {country.name}.</p>
                <div className="flex items-center justify-center gap-3 mt-6">
                  <div className="p-2 bg-primary/10 rounded-lg text-primary">
                    <Star size={24} className="fill-primary" />
                  </div>
                  <h2 className="text-2xl font-bold">Vous pourriez aimer ça</h2>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
                {recommendedProducts.map(product => (
                  <div
                    key={product.id}
                    onClick={() => onProductClick(product)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onProductClick(product) }}
                    role="button"
                    tabIndex={0}
                    className="bg-card border rounded-xl overflow-hidden cursor-pointer hover:shadow-md transition-all group"
                  >
                    <div className="aspect-square bg-muted overflow-hidden relative">
                      <LazyImage src={product.image} alt={product.name} decoding="async" className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                      <div className="absolute top-2 left-2 px-2 py-1 bg-primary text-primary-foreground rounded text-[10px] font-bold shadow-lg">
                        {product.countryCode.toUpperCase()}
                      </div>
                    </div>
                    <div className="p-3">
                      <h4 className="text-sm font-medium line-clamp-2 h-10">{product.name}</h4>
                      <p className="mt-2 font-bold text-accent">{fp(product.price)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  )
}
"use client"
import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import useSWR from 'swr'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import DOMPurify from 'dompurify';
import { LazyMotion, domAnimation, m, AnimatePresence } from 'framer-motion'
import {
  ArrowLeft, Heart, Share2, Truck, Shield, Star, Minus, Plus, Loader2,
  ShoppingCart, ChevronLeft, ChevronRight, Package, Store, Check, Info, MessageCircle,
  Link2, Facebook, Twitter
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import Image from 'next/image'
import { type WooProduct, type WooProductVariation, type WooVendor, translations } from '@/lib/woocommerce'
import { recordRecentlyViewed } from '@/lib/recently-viewed'
import { useCurrency } from '@/contexts/CurrencyContext'
import { useWishlist } from '@/contexts/WishlistContext'
import { ProductVariations } from './ProductVariations'
import { ShippingInfo } from './ShippingInfo'
import { ProductShippingEstimate } from './ProductShippingEstimate'; // Import the new component
import { ProductReviewForm } from './ProductReviewForm'
import { FrequentlyBoughtTogether } from './FrequentlyBoughtTogether'
import { SimilarProducts } from './SimilarProducts'
import { InfiniteProductFeed } from './server/InfiniteProductFeed'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { QuickSelectModal } from './QuickSelectModal'
import { ProductCard } from './ProductCard'
import { Progress } from "@/components/ui/progress"
import { cn } from '@/lib/utils';
import { getCountryZone } from '@/lib/shipping-utils';
import { proxyIfLocalWp } from '@/lib/image-utils';

export type ProductDetailProps = {
  product: WooProduct
  onBack: () => void
  onProductClick: (product: WooProduct) => void
  allProducts: WooProduct[]
  onStoreClick: (vendor: WooVendor) => void
  onAddToCart: (product: WooProduct, quantity: number, variation?: WooProductVariation) => void
  onBuyNow: (product: WooProduct, quantity: number, variation?: WooProductVariation) => void
  onCartClick: () => void
  userCountry: string
  cartCount: number
  user?: {
    email?: string;
    display_name?: string;
    name?: string;
    [key: string]: any;
  } | null;
  shippingRates: Record<string, any>;
}

// Helper pour l'affichage des images avec support multi-format et fallback
function ProductImg({ src, alt, className }: { src: string | undefined; alt: string; className?: string }) {
  const [errored, setErrored] = useState(false)
  const hasImage = src && src !== '/placeholder.jpg' && !errored

  return hasImage ? (
    <div className={cn("relative", className)}>
      <Image
        src={src}
        alt={alt}
        fill
        sizes="(max-width: 640px) 100vw, 33vw"
        className="object-cover"
        onError={() => setErrored(true)}
      />
    </div>
  ) : (
    <div className="w-full h-full flex items-center justify-center bg-white p-8">
      <Image src="/logo/logo.png" alt="MIAD Market" width={200} height={200} className="w-full h-full object-contain opacity-30 brightness-95" />
    </div>
  )
}

function ShareProductButton({ product }: { product: WooProduct }) {
  const [copied, setCopied] = useState(false)
  const productUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/product/${product.slug || product.id}`
    : `https://www.miadmarket.com/product/${product.slug || product.id}`

  const copyLink = async () => {
    await navigator.clipboard.writeText(productUrl)
    setCopied(true)
    toast.success('Lien copié !')
    setTimeout(() => setCopied(false), 2000)
  }

  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${product.name}\n${productUrl}`)}`
  const facebookUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(productUrl)}`
  const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(product.name)}&url=${encodeURIComponent(productUrl)}`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="rounded-full shrink-0 border-slate-200 shadow-sm" aria-label="Partager">
          <Share2 size={18} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52 rounded-2xl shadow-xl border-slate-100 p-1">
        <DropdownMenuItem className="flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer" onClick={copyLink}>
          {copied ? <Check size={16} className="text-green-500 shrink-0" /> : <Link2 size={16} className="text-slate-500 shrink-0" />}
          <span className="text-sm font-medium">{copied ? 'Lien copié !' : 'Copier le lien'}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1" />
        <DropdownMenuItem asChild>
          <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer">
            <MessageCircle size={16} className="text-green-500 shrink-0" />
            <span className="text-sm font-medium">WhatsApp</span>
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={facebookUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer">
            <Facebook size={16} className="text-blue-600 shrink-0" />
            <span className="text-sm font-medium">Facebook</span>
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={twitterUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer">
            <Twitter size={16} className="text-sky-500 shrink-0" />
            <span className="text-sm font-medium">X / Twitter</span>
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ProductGallery({ product, activeImage, onBack, onCartClick, cartCount }: { product: WooProduct; activeImage?: string; onBack: () => void; onCartClick: () => void; cartCount: number; }) {
  const handleShare = async () => {
    const url = `${typeof window !== 'undefined' ? window.location.origin : 'https://www.miadmarket.com'}/product/${product.slug || product.id}`
    const shareData = { title: product.name, text: `${product.name} — ${product.price}$`, url }
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share(shareData) } catch { /* annulé */ }
    } else {
      await navigator.clipboard.writeText(url)
      toast.success('Lien copié !')
    }
  }

  const initialImages: string[] = useMemo(() => {
    const gallery = (product as any)?.images || []
    if (gallery.length > 0) return gallery
    if (product.image) return [product.image]
    return []
  }, [product])

  const images = useMemo(() => {
    if (!activeImage) return initialImages
    return [activeImage, ...initialImages.filter(img => img !== activeImage)]
  }, [initialImages, activeImage])

  const [errored, setErrored] = useState<Record<number, boolean>>({})
  // Réinitialise l'index actif dès que l'image active (prop) change, sans effet :
  // on mémorise pour quelle activeImage l'index a été calculé.
  const [activeState, setActiveState] = useState<{ index: number; forImage?: string }>({ index: 0, forImage: activeImage })
  const active = activeState.forImage === activeImage ? activeState.index : 0
  const setActive = (updater: number | ((i: number) => number)) => {
    setActiveState(prev => {
      const base = prev.forImage === activeImage ? prev.index : 0
      const next = typeof updater === 'function' ? (updater as (i: number) => number)(base) : updater
      return { index: next, forImage: activeImage }
    })
  }

  const hasImage = images.length > 0 && !errored[active]

  return (
    <div className="space-y-4">
      {/* Image principale */}
      <div className="relative bg-muted sm:rounded-3xl overflow-hidden" style={{ aspectRatio: '4/5' }}>
        {/* Actions flottantes mobile — bouton retour retiré (2026-07-23) :
            navigation arrière laissée au geste natif / bouton retour du
            navigateur, qui restaure déjà la position exacte via navStack. */}
        <div className="absolute top-5 left-4 right-4 z-20 flex justify-end sm:hidden">
          <div className="flex gap-2">
            <button type="button" onClick={handleShare} aria-label="Partager" className="p-2.5 bg-black/35 hover:bg-black/55 rounded-full text-white backdrop-blur-md transition-colors">
              <Share2 size={20} />
            </button>
            <button
              type="button"
              onClick={onCartClick}
              aria-label="Voir le panier"
              className="p-2.5 bg-black/35 hover:bg-black/55 rounded-full text-white backdrop-blur-md transition-colors relative"
            >
              <ShoppingCart size={20} />
              {cartCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-accent text-white text-[9px] font-black w-4 h-4 flex items-center justify-center rounded-full border border-white">
                  {cartCount}
                </span>
              )}
            </button>
          </div>
        </div>

        {hasImage ? (
          <Image
            src={images[active]}
            alt={product.name}
            fill
            sizes="(max-width: 1024px) 100vw, 40vw"
            className="object-cover transition-opacity duration-300"
            onError={() => setErrored(prev => ({ ...prev, [active]: true }))}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-white p-12">
            <Image src="/logo/logo.png" alt="MIAD Market" width={200} height={200} className="w-full h-full object-contain opacity-20" />
          </div>
        )}

        {product.regularPrice && product.regularPrice > product.price && (
          <span className="absolute top-4 left-4 px-3 py-1.5 bg-accent text-white text-xs font-black rounded-xl shadow-lg">
            -{Math.round((1 - product.price / product.regularPrice) * 100)}%
          </span>
        )}

        {/* Indicateur de position */}
        {images.length > 1 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1.5 z-10">
            {images.map((src, i) => (
              <button
                type="button"
                key={src}
                onClick={() => setActive(i)}
                aria-label={`Voir la photo ${i + 1}`}
                className={`rounded-full transition-all duration-200 ${
                  i === active ? 'w-5 h-1.5 bg-white' : 'w-1.5 h-1.5 bg-white/50'
                }`}
              />
            ))}
          </div>
        )}

        {images.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => setActive(i => (i - 1 + images.length) % images.length)}
              aria-label="Photo précédente"
              className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 bg-white/85 hover:bg-white rounded-full flex items-center justify-center shadow-md z-10 transition-colors"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              onClick={() => setActive(i => (i + 1) % images.length)}
              aria-label="Photo suivante"
              className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 bg-white/85 hover:bg-white rounded-full flex items-center justify-center shadow-md z-10 transition-colors"
            >
              <ChevronRight size={18} />
            </button>
          </>
        )}
      </div>

      {/* ── Bande miniatures style AliExpress ── */}
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
          {images.map((src, idx) => (
            <button
              type="button"
              key={src}
              onClick={() => setActive(idx)}
              className={`relative shrink-0 rounded-xl overflow-hidden border-2 transition-all duration-200
                ${active === idx
                  ? 'border-accent shadow-md shadow-accent/20 scale-105'
                  : 'border-transparent opacity-60 hover:opacity-90 hover:scale-105'}
              `}
              style={{ width: 72, height: 72 }}
            >
              {!errored[idx] ? (
                <Image
                  src={src}
                  alt={`${product.name} — vue ${idx + 1}`}
                  fill
                  sizes="72px"
                  className="object-cover"
                  onError={() => setErrored(prev => ({ ...prev, [idx]: true }))}
                />
              ) : (
                <div className="w-full h-full bg-muted flex items-center justify-center p-2">
                  <Image src="/logo/logo.png" alt="" width={40} height={40} className="opacity-20 object-contain" />
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function VendorCard({ vendor, onClick, newVendorLabel = 'Nouveau vendeur' }: { vendor: WooVendor; onClick: () => void; newVendorLabel?: string }) {
  const [logoLoaded, setLogoLoaded] = useState(false)
  const [logoErrored, setLogoErrored] = useState(false)

  return (
    <div
      role="button"
      tabIndex={0}
      className="bg-white border border-border rounded-3xl p-5 shadow-sm flex items-center gap-4 hover:border-accent/30 transition-all cursor-pointer group"
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      <div className="w-14 h-14 rounded-full border-2 border-accent/10 overflow-hidden shrink-0 bg-muted relative">
        {vendor.logo && !logoErrored ? (
          <>
            {!logoLoaded && (
              <div className="absolute inset-0 bg-gradient-to-r from-muted via-background/60 to-muted animate-pulse rounded-full" />
            )}
            <Image
              src={proxyIfLocalWp(vendor.logo)!}
              alt={vendor.name}
              fill
              sizes="56px"
              className={`object-cover transition-opacity duration-300 ${logoLoaded ? 'opacity-100' : 'opacity-0'}`}
              onLoad={() => setLogoLoaded(true)}
              onError={() => setLogoErrored(true)}
            />
          </>
        ) : (
          <Store className="w-full h-full p-3 text-muted-foreground opacity-30" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="font-black uppercase tracking-tight text-sm truncate group-hover:text-accent transition-colors">
          {vendor.name}
        </h3>
        <div className="flex items-center gap-2 mt-0.5">
          {vendor.rating && vendor.rating > 0 ? (
            <div className="flex items-center gap-1 text-[10px] font-bold text-orange-500">
              <Star size={10} className="fill-orange-500" /> {Number(vendor.rating).toFixed(1)}
            </div>
          ) : (
            <span className="text-[10px] text-muted-foreground font-medium">{newVendorLabel}</span>
          )}
        </div>
      </div>
      <Button variant="ghost" size="icon" className="rounded-full group-hover:bg-accent group-hover:text-white transition-all">
        <ChevronRight size={18} />
      </Button>
    </div>
  )
}

export function ProductDetail({ product, onBack, onProductClick, allProducts, onStoreClick, onAddToCart, onBuyNow, onCartClick, user, userCountry, cartCount, shippingRates }: ProductDetailProps) {
  const { formatPrice: fp } = useCurrency()
  const { isFavorite, toggle: toggleWishlist } = useWishlist()
  const [quantity, setQuantity] = useState(1)
  // État pour la variante active sélectionnée via le composant enfant
  const [shippingCost, setShippingCost] = useState<number>(10); // Valeur par défaut numérique au lieu de null
  const [isShippingLoading, setIsShippingLoading] = useState(false); // Added missing state
  const [activeVariation, setActiveVariation] = useState<WooProductVariation | null>(null)
  // NEW STATES for shipping method and duration
  const [selectedShippingMethod, setSelectedShippingMethod] = useState<string>('MIAD Standard');
  const [selectedMethodId, setSelectedMethodId] = useState<string>('miad_standard');
  const [localCountry, setLocalCountry] = useState(userCountry || 'SN');
  const [selectedShippingDuration, setSelectedShippingDuration] = useState<string>('15 jours ouvrés');
  // Jamais lu au rendu (QuickSelectModal n'est pas monté ici) — ref plutôt que state pour éviter un re-render inutile.
  const showQuickSelectRef = useRef(false)
  const t = useMemo(() => (translations[product.lang || 'fr'] || translations['fr']) as any, [product.lang])

  // CORRECTIF : Réinitialiser la vue quand le produit change (clic sur recommandations)
  useEffect(() => {
    setQuantity(1);
    setActiveVariation(null);
    setShippingCost(0); // On met à 0 au lieu de null pour respecter le type number
    recordRecentlyViewed(product.id);
  }, [product.id]);

  // CORRECTIF : Déclarer les setters de manière stable pour stopper la boucle infinie
  const handleShippingLoading = useCallback((val: boolean) => setIsShippingLoading(val), []);
  const handleShippingCost = useCallback((val: number) => {
    setShippingCost(val);
    console.log(`[Détail Produit] Nouveau prix de livraison calculé : ${val}`);
  }, []);
  const handleShippingMethod = useCallback((val: string) => {
    setSelectedShippingMethod(val);
    console.log(`[Détail Produit] Méthode sélectionnée : ${val}`);
  }, []);
  const handleShippingDuration = useCallback((val: string) => setSelectedShippingDuration(val), []);
  const handleMethodSelect = useCallback((val: string) => setSelectedMethodId(val), []);

  // Mémorisation du handler pour éviter les boucles de rendu avec ProductVariations
  const handleVariationChange = useCallback((v: WooProductVariation | null) => {
    setActiveVariation(v);
    console.log("[ProductDetail] activeVariation updated:", v);
  }, []);

  // Appel API optimisé avec bypass de cache pour les variations
  // BUG FIX: On lance le hit si variations est vide OU si ce n'est qu'un tableau d'IDs (nombres)
  const { data: variationsData, isLoading: isLoadingVariations } = useSWR<any>(
  product.type === 'variable'
    ? `/api/products?id=${product.id}&variations=true&lang=${product.lang || 'fr'}`
    : null,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Erreur API: ${res.status}`);
      
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new TypeError("Le serveur n'a pas renvoyé de JSON valide.");
      }

      const data = await res.json();
      // S'assurer que 'variations' est un tableau
      if (data && Array.isArray(data.products) && data.products.length > 0) {
        return data.products[0]; // Retourne l'objet produit complet
      }
      return null;
    },
    { 
      revalidateIfStale: false, // Pas de revalidation automatique
      revalidateOnFocus: false, // Pas de revalidation au focus
      dedupingInterval: 10000 // On réduit à 10s pour que tes tests de "purge" soient plus efficaces
    }
  );

  const variations = useMemo(() => {
    // Priorité absolue aux données complètes injectées par le hit unique de l'API
    if (variationsData?.variations && Array.isArray(variationsData.variations)) {
      if (typeof variationsData.variations[0] === 'object') return variationsData.variations;
    }
    // Fallback de sécurité sur les données de base (souvent vides pour les variables dans les listes)
    return Array.isArray(product.variations) && typeof product.variations[0] === 'object' ? product.variations : [];
  }, [product.variations, variationsData]);

  const attributes = useMemo(() => {
    if (variationsData?.attributes && variationsData.attributes.length > 0) return variationsData.attributes;
    return product.attributes && product.attributes.length > 0 ? product.attributes : [];
  }, [product.attributes, variationsData]);

  // On extrait aussi les prix du parent mis à jour par le hit si disponibles
  // PRIORITÉ : Si une variation est sélectionnée, c'est son prix qui compte.
  const currentPrice = Number(activeVariation?.price || variationsData?.price || product.price || 0)
  const currentRegularPrice = Number(activeVariation?.regularPrice || variationsData?.regularPrice || product.regularPrice || 0)

  // Optimisation : Préchargement des images des variantes pour un affichage instantané lors de la sélection
  useEffect(() => {
    if (variations && variations.length > 0) {
      variations.forEach((v: WooProductVariation) => {
        if (v.image && v.image !== '') {
          const img = new window.Image();
          img.src = v.image;
        }
      });
    }
  }, [variations]);

  const enrichedProduct = useMemo(() => ({
    ...product,
    variations,
    attributes
  }), [product, variations, attributes]);

  // Sanitize description HTML.
  // Les descriptions enrichies (phase 2) sont du TEXTE BRUT avec des sauts
  // de ligne `\n\n` entre paragraphes, des puces `• ` et des intitulés
  // "Label : valeur" en début de ligne. Sans mise en forme HTML, tout
  // s'affiche collé en un seul bloc illisible. On convertit donc le texte
  // brut en vrais paragraphes / listes / intertitres avant de l'injecter.
  const sanitizedDescription = useMemo(() => {
    const raw = product?.description || '';
    if (!raw) return '';

    const looksLikeHtml = /<\/?(p|div|ul|ol|li|br|h[1-6]|strong|em|table)\b/i.test(raw);
    let html: string;

    if (looksLikeHtml) {
      html = raw;
    } else {
      const esc = (s: string) =>
        s
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      // met en gras l'intitulé avant le premier " : " en tête de bloc
      const withLead = (s: string) => {
        const m = s.match(/^([A-ZÀ-ÖØ-Ý][^:\n]{1,40}?)\s:\s([\s\S]+)$/);
        return m ? `<strong>${esc(m[1])} :</strong> ${esc(m[2])}` : esc(s);
      };
      html = raw
        .split(/\n{2,}/)
        .map((block) => {
          const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
          if (!lines.length) return '';
          // bloc de puces
          if (lines.every((l) => /^[•\-*]\s+/.test(l))) {
            const items = lines
              .map((l) => `<li>${esc(l.replace(/^[•\-*]\s+/, ''))}</li>`)
              .join('');
            return `<ul>${items}</ul>`;
          }
          // bloc mixte : puces éventuelles + texte
          const parts = lines
            .map((l) =>
              /^[•\-*]\s+/.test(l)
                ? `<li>${esc(l.replace(/^[•\-*]\s+/, ''))}</li>`
                : `<p>${withLead(l)}</p>`
            )
            .join('');
          return parts.replace(/(<li>[\s\S]*?<\/li>)+/g, (m) => `<ul>${m}</ul>`);
        })
        .filter(Boolean)
        .join('');
    }

    return typeof window !== 'undefined' ? DOMPurify.sanitize(html) : html;
  }, [product?.description]);

  const displayPrice = useMemo(() => {
    const currency = product.currency || '$';
    
    if (activeVariation) {
      return fp(activeVariation.price);
    }
    
    if (product.type === 'variable' && variations.length > 0) {
      const prices = variations.reduce((acc: number[], v: WooProductVariation) => {
        const p = Number(v.price);
        if (!isNaN(p) && p > 0) acc.push(p);
        return acc;
      }, []);
      if (prices.length > 0) {
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
        if (minPrice === maxPrice) return fp(minPrice);
        return `${t.from || 'À partir de'} ${fp(minPrice)}`;
      }
    }
    
    return fp(product.price);
  }, [product, activeVariation, variations, t, fp])

  // Vrais avis WooCommerce via SWR
  const { data: reviewsData, mutate: mutateReviews } = useSWR<{ reviews: any[] }>(
    `/api/reviews?product_id=${product.id}`,
    (url: string) => fetch(url).then(r => r.json()),
    { revalidateOnFocus: false, dedupingInterval: 120000 }
  )
  const realReviews = useMemo(() => reviewsData?.reviews || [], [reviewsData])

  // Statistiques d'avis calculées depuis les vrais avis
  const reviewStats = useMemo(() => {
    const base = product.rating || 0
    const total = realReviews.length
    const avg = total > 0
      ? realReviews.reduce((s, r) => s + (r.rating || 0), 0) / total
      : base

    const dist = [5, 4, 3, 2, 1].map(star => {
      const count = realReviews.filter(r => r.rating === star).length
      return { stars: star, percent: total > 0 ? Math.round((count / total) * 100) : (star === 5 ? 85 : star === 4 ? 10 : star === 3 ? 3 : star === 2 ? 2 : 0) }
    })

    return { average: parseFloat(avg.toFixed(1)) || 4.8, total: total || 0, distribution: dist }
  }, [realReviews, product.rating])

  const totalPrice = useMemo(() => {
    return currentPrice + (shippingCost || 0);
  }, [currentPrice, shippingCost]);

  const currentImage = activeVariation?.image && activeVariation.image !== '' ? activeVariation.image : product.image
  const isInStock = activeVariation ? activeVariation.inStock : product.inStock
  const currentStock = activeVariation ? (activeVariation.stock || 0) : (product.stock || 0)

  // Produits de la même boutique
  const sameStoreProducts = useMemo(() => {
    return allProducts.filter(p => p.vendor?.id === product.vendor?.id && p.id !== product.id).slice(0, 4)
  }, [allProducts, product])

  // Logique de stock et confiance "Alibaba Style"
  const stockDisplay = useMemo(() => {
    if (!isInStock) {
      return { label: 'Rupture de stock', color: 'text-red-700 bg-red-100 border-red-200', dot: 'bg-red-500' }
    }
    if (currentStock > 0 && currentStock < 10) {
      return { label: `Plus que ${currentStock} en stock`, color: 'bg-orange-100 text-orange-700 border-orange-200', dot: 'bg-orange-500' }
    }
    return { label: 'En stock', color: 'bg-green-100 text-green-700 border-green-200', dot: 'bg-green-500' }
  }, [isInStock, currentStock])

  const trustSignals = [
    { icon: Shield, text: t.guarantee, sub: t.guaranteeSub },
    { icon: Truck, text: t.fastShipping, sub: t.fastShippingSub },
    { icon: Check, text: t.quality, sub: t.qualitySub }
  ]

  const maxQty = currentStock > 0 ? currentStock : 99
  const changeQty = (delta: number) => setQuantity(q => Math.max(1, q + delta))

  const handleWhatsApp = () => {
    if (typeof window === 'undefined') return;
    const phone = "15793689402"; 
    const message = `Bonjour, je suis intéressé par votre produit "${product?.name || 'produit'}" sur MIAD Market. Pouvons-nous en discuter ?\n\nLien du produit : ${window.location.href}`;
    const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
  };

  const handleAddToCartClick = () => {
    // Si c'est un produit variable et qu'aucune option n'est choisie
    if (product.type === 'variable' && !activeVariation) {
      const section = document.getElementById('variations-section');
      if (section) {
        section.scrollIntoView({ behavior: 'smooth' });
        toast.info("Choisissez votre modèle (taille, couleur...)");
      }
      return
    }

    // Log stratégique pour MIAD Market
    console.log("🛒 AJOUT PANIER :", {
      name: product.name,
      isVariable: product.type === 'variable',
      variationChoisie: activeVariation?.id || "AUCUNE"
    });
    
    // On passe la variante active au handler pour que l'ID de variante soit utilisé au checkout
    onAddToCart(product, quantity, activeVariation || undefined)
    
    const variantLabel = activeVariation 
      ? ` (${activeVariation.attributes.map(a => a.option).join(' / ')})`
      : '';

    // Notification Immersive Style MIAD
    toast.custom((toastId) => (
      <div className="max-w-md w-full bg-white shadow-2xl rounded-[1.5rem] pointer-events-auto flex ring-1 ring-black ring-opacity-5 overflow-hidden border border-accent/20">
        <div className="flex-1 w-0 p-4">
          <div className="flex items-start">
            <div className="flex-shrink-0 pt-0.5">
              <Image className="h-12 w-12 rounded-lg object-cover border border-border" src={currentImage} alt="" width={48} height={48} />
            </div>
            <div className="ml-3 flex-1">
              <p className="text-sm font-black text-gray-900 uppercase truncate">{product.name}</p>
              <p className="mt-1 text-xs font-bold text-accent">{quantity} unité(s) {variantLabel}</p>
              <p className="mt-1 text-[10px] text-green-600 font-black uppercase">Prêt pour expédition MIAD Express</p>
            </div>
          </div>
        </div>
        <div className="flex border-l border-gray-200">
          <button
            type="button"
            onClick={() => { toast.dismiss(toastId); onCartClick(); }}
            className="w-full border border-transparent rounded-none rounded-r-lg p-4 flex items-center justify-center text-xs font-black text-accent hover:text-accent/80 focus:outline-none uppercase tracking-tighter"
          >
            Voir Panier
          </button>
        </div>
      </div>
    ), { position: 'top-center', duration: 4000 });
  }

  const handleBuyNowClick = () => {
    if (product.type === 'variable' && !activeVariation) {
      showQuickSelectRef.current = true
      toast.info("Veuillez sélectionner vos options avant d'acheter.")
      return
    }
    // onBuyNow (MiadMarketClient) ajoute déjà au panier avant de naviguer vers
    // le checkout — un onAddToCart séparé ici doublait la quantité ajoutée.
    onBuyNow(product, quantity, activeVariation ?? undefined)

    const variantLabel = activeVariation 
      ? ` (${activeVariation.attributes.map(a => a.option).join(' / ')})`
      : '';

    toast.success("Produit ajouté au panier et redirection vers le paiement", {
      description: `${product.name}${variantLabel}`,
      position: 'top-center',
      style: {
        background: '#1f2937',
        color: '#ffffff',
        borderRadius: '1rem',
        border: '1px solid rgba(255,255,255,0.1)'
      }
    })
  }

  // Prepare current pricing details
  // pt-0 sur mobile : le header étant caché sur cette vue (isProductView),
  // l'image doit commencer à y=0 sans aucun espace au-dessus — signalé le
  // 2026-07-23 avec capture d'écran montrant un liseré blanc restant.
  return (
    <main className="min-h-screen bg-background pt-0 sm:pt-8 pb-20 sm:pb-8">
      <div className="container mx-auto px-4">
        <button type="button" onClick={onBack} className="hidden sm:flex items-center gap-2 text-muted-foreground hover:text-foreground mb-6 transition-colors">
          <ArrowLeft size={20} />
          <span>{t.backToProducts}</span>
        </button>

        {/* Tout le contenu de la fiche produit s'affiche à la suite, sans onglets à
            changer pour voir le reste (demandé le 2026-07-30 — l'ancienne version
            masquait Description/Avis/Recommandations derrière des TabsContent tant
            qu'on n'avait pas cliqué sur l'onglet correspondant). */}
        <div className="w-full">
          <div className="pt-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-start">
          {/* Product Gallery (Left Column - span 5 on large screens) */}
          <div className="lg:col-span-5 -mx-4 sm:mx-0">
          <ProductGallery
            product={product}
            activeImage={currentImage}
            onBack={onBack}
            onCartClick={onCartClick}
            cartCount={cartCount}
          />
          </div>

          {/* Product Details (Middle Column - span 4 on large screens) */}
          <div className="lg:col-span-4 space-y-6 animate-in fade-in slide-in-from-right duration-500">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl lg:text-3xl font-bold leading-tight">{product?.name || 'Produit sans nom'}</h1>
                {product.subtitle && (
                  <p className="text-sm text-foreground/80 mt-2 leading-snug">{product.subtitle}</p>
                )}
                {(product.vendor?.name || product.country) && (
                  <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1">
                    {product.vendor?.name && (
                      <span className="font-semibold text-foreground/70">{product.vendor.name}</span>
                    )}
                    {product.vendor?.name && product.country && <span>·</span>}
                    {product.country && <span>{product.country}</span>}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  aria-label={isFavorite(product.id) ? 'Retirer des favoris' : 'Ajouter aux favoris'}
                  onClick={() => toggleWishlist(product.id)}
                  className="w-10 h-10 rounded-full border border-border flex items-center justify-center hover:bg-muted transition-colors"
                >
                  <Heart size={18} className={isFavorite(product.id) ? 'fill-red-500 text-red-500' : 'text-muted-foreground'} />
                </button>
                <ShareProductButton product={product} />
              </div>
            </div>

            {/* Bloc Renseignements de la Boutique (Style Premium) */}
            {product.vendor && (
              <VendorCard vendor={product.vendor} onClick={() => product.vendor && onStoreClick(product.vendor)} newVendorLabel={t.newVendor} />
            )}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              {product.countryCode && (product.country || product.countryCode) && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Image
                    src={`https://flagcdn.com/w20/${product.countryCode.toLowerCase()}.png`}
                    alt={product.countryCode}
                    width={20}
                    height={15}
                    className="w-5 h-auto rounded-sm shadow-sm"
                  />
                  <span className="font-bold">{product.country || product.countryCode}</span>
                </div>
              )}
              {/* Product Rating & Sales Count */}
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Star size={12} className="fill-orange-400 text-orange-400" />
                <span className="font-bold">{product.rating && product.rating > 0 ? Number(product.rating).toFixed(1) : '4.9'}</span>
                {product.salesCount !== undefined && product.salesCount > 0 && (
                  <span className="text-xs ml-1">({product.salesCount} {t.sold || 'vendus'})</span>
                )}
              </div>
            </div>

            <div className="rounded-3xl border border-accent/10 shadow-sm overflow-hidden relative">
              {/* ── Bandeau prix fort — équivalent réel du bandeau "SuperDeals" ──
                  Pas de fausse urgence ("moins cher que les 90 derniers jours") :
                  seulement le vrai prix et la vraie réduction de ce produit. */}
              {currentRegularPrice > 0 && currentRegularPrice > currentPrice ? (
                <div className="bg-gradient-to-r from-accent to-accent/80 px-5 py-2.5 flex items-center justify-between">
                  <span className="text-white font-black text-xs uppercase tracking-wider">{t.miadOffer}</span>
                  <span className="bg-white/20 text-white text-[10px] font-black px-2 py-1 rounded-full uppercase tracking-wide">
                    -{Math.round((1 - currentPrice / currentRegularPrice) * 100)}% {t.today}
                  </span>
                </div>
              ) : (
                <div className="bg-accent/90 px-5 py-2.5">
                  <span className="text-white font-black text-xs uppercase tracking-wider">{t.miadPrice}</span>
                </div>
              )}

              <div className="bg-accent/5 p-6">
              <div className="grid grid-cols-2 gap-4 relative z-10">
                <div className="space-y-0.5">
                  <p className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider">{t.itemPrice}</p>
                  <p className="text-xl font-black text-foreground">{displayPrice}</p>
                  {/* If there's a regular price, display it strikethrough */}
                  {currentRegularPrice > 0 && currentRegularPrice > currentPrice && (
                    <p className="text-xs text-muted-foreground line-through">{fp(currentRegularPrice)}</p>
                  )}
                </div>
                <div className="space-y-0.5 text-right">
                  <p className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider">
                    Livraison ({userCountry}
                    {getCountryZone(userCountry) ? ` - Zone ${getCountryZone(userCountry)}` : ''})
                  </p>
                  <div className="text-xl font-black text-accent">
                    {/* CORRECTIF : On ne masque plus le composant pendant le chargement pour éviter le crash (boucle infinie) */}
                    {isShippingLoading && <span className="text-[10px] absolute -mt-4 animate-pulse italic">Mise à jour...</span>}
                    <ProductShippingEstimate
                      product={product}
                      selectedVariation={activeVariation || undefined}
                      quantity={quantity}
                      userCountryCode={localCountry}
                      onLoadingChange={handleShippingLoading}
                      onShippingCostCalculated={handleShippingCost}
                      onShippingMethodChange={handleShippingMethod}
                      onShippingDurationChange={handleShippingDuration}
                      globalShippingRates={shippingRates}
                      selectedMethodId={selectedMethodId}
                      onMethodSelect={handleMethodSelect}
                    />
                  </div>
                </div>
              </div>
              
              {/* Résumé dynamique de la sélection avec animation */}
              <LazyMotion features={domAnimation}>
              <AnimatePresence mode="wait">
                {activeVariation && !isShippingLoading && (
                  <m.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="mt-5 pt-5 border-t border-dashed border-accent/20 flex justify-between items-center"
                  >
                    <div>
                      <p className="text-[10px] font-black uppercase text-muted-foreground tracking-widest">
                        Total (Modèle {activeVariation.attributes.map(a => a.option).join('/')}) <span className="normal-case font-medium">({selectedShippingMethod} - {selectedShippingDuration})</span>
                      </p>
                      <p className="text-3xl font-black text-accent tracking-tighter">
                        {fp(totalPrice)}
                      </p>
                    </div>
                    <div className="bg-green-100 text-green-700 px-3 py-1 rounded-full text-[10px] font-black uppercase">Prêt</div>
                  </m.div>
                )}
              </AnimatePresence>
              </LazyMotion>

              {!activeVariation && product.type === 'variable' && (
                <div className="mt-4 text-center">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase animate-pulse italic">Selectionnez vos options ci-dessous pour commander</p>
                </div>
              )}
              </div>
            </div>

            {product.type === 'variable' && (
              <div id="variations-section" className="border-y border-border">
                {variations.length > 0 && (
                   <ProductVariations product={enrichedProduct} onVariationChange={handleVariationChange} />
                )}
              </div>
            )}

            <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-black border uppercase tracking-widest ${stockDisplay.color}`}>
              <span className={`w-2 h-2 rounded-full animate-pulse ${stockDisplay.dot}`} />
              {stockDisplay.label}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2 bg-muted rounded-lg p-1.5">
                <button type="button" onClick={() => changeQty(-1)} disabled={quantity <= 1} aria-label="Diminuer la quantité" className="p-2"><Minus size={16} /></button>
                <span className="w-10 text-center font-bold">{quantity}</span>
                <button type="button" onClick={() => changeQty(1)} disabled={quantity >= maxQty} aria-label="Augmenter la quantité" className="p-2"><Plus size={16} /></button>
              </div>
              <div className="flex-1 flex gap-2">
                <Button 
                  variant="outline" 
                  onClick={handleAddToCartClick}
                  className="flex-1 py-7 border-accent text-accent font-black rounded-2xl transition-all hover:bg-accent/5"
                >
                  {product.type === 'variable' && !activeVariation ? t.choose : (activeVariation && !activeVariation.inStock ? t.outOfStock : t.addToCart)}
                </Button>
                <Button
                  onClick={handleBuyNowClick}
                  disabled={activeVariation ? !activeVariation.inStock : false}
                  className="flex-1 py-7 bg-accent text-white font-black rounded-2xl shadow-xl shadow-accent/20 transition-all active:scale-95"
                >
                  {activeVariation && !activeVariation.inStock ? t.outOfStock : t.buyNowBtn}
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-border pt-5">
              <Button variant="outline" onClick={handleWhatsApp} className="w-full border-green-500 text-green-600 gap-2 h-12">
                <MessageCircle size={20} /> Négocier sur WhatsApp
              </Button>

              {/* Trust Signals */}
              <div className="grid grid-cols-1 gap-3 mt-4">
                {trustSignals.map((s) => (
                  <div key={s.text} className="flex items-start gap-3 p-3 bg-muted/20 rounded-xl">
                    <s.icon size={16} className="text-accent mt-0.5" />
                    <div>
                      <p className="text-xs font-bold">{s.text}</p>
                      <p className="text-[10px] text-muted-foreground">{s.sub}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Bloc Livraison & Actions style AliExpress (Sticky à droite sur PC) */}
          <div className="lg:col-span-3 hidden lg:block">
            <ShippingInfo 
              product={product}
              userCountry={localCountry}
              language={(product.lang || 'fr') as 'fr' | 'en'}
              selectedVariation={activeVariation || undefined} // Pass active variation to ShippingInfo
              onCountryChange={setLocalCountry}
              onLoadingChange={setIsShippingLoading}
              shippingCost={shippingCost}
              onShippingCostCalculated={setShippingCost}
              onShippingMethodChange={setSelectedShippingMethod}
              onShippingDurationChange={setSelectedShippingDuration}
              selectedShippingMethod={selectedShippingMethod}
              selectedShippingDuration={selectedShippingDuration}
              quantity={quantity}
              onWhatsAppClick={handleWhatsApp} 
              globalShippingRates={shippingRates}
              selectedMethodId={selectedMethodId}
              onMethodSelect={setSelectedMethodId}
            />
          </div>
        </div>

        {/* Bloc Livraison sur Mobile - Placé avant les onglets pour plus de visibilité */}
        <div className="lg:hidden mt-8">
          <ShippingInfo 
            product={product}
            userCountry={localCountry}
            selectedVariation={activeVariation || undefined}
            onCountryChange={setLocalCountry}
            onLoadingChange={setIsShippingLoading}
            shippingCost={shippingCost}
            onShippingCostCalculated={setShippingCost}
            onShippingMethodChange={setSelectedShippingMethod}
            onShippingDurationChange={setSelectedShippingDuration}
            selectedShippingMethod={selectedShippingMethod}
            selectedShippingDuration={selectedShippingDuration}
            quantity={quantity}
            language={(product.lang || 'fr') as 'fr' | 'en'} 
            globalShippingRates={shippingRates}
            onWhatsAppClick={handleWhatsApp} 
            selectedMethodId={selectedMethodId}
            onMethodSelect={setSelectedMethodId}
          />
        </div>

          </div>

          <div className="pt-10 pb-10 border-t border-border">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
              <div className="lg:col-span-9">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-1 h-5 bg-accent rounded-full" />
                <h2 className="text-xl font-black uppercase tracking-tight">{t.description}</h2>
              </div>
              {/* ── Texte / HTML de description ──
                  `product-desc` : styles dédiés (voir globals.css) pour que
                  le texte enrichi (paragraphes, puces, intitulés en gras)
                  soit lisible même sans le plugin @tailwindcss/typography. */}
              {sanitizedDescription ? (
                <div
                  className="product-desc max-w-none text-[15px] leading-7 text-foreground/90"
                  dangerouslySetInnerHTML={{ __html: sanitizedDescription }}
                />
              ) : (
                <p className="text-muted-foreground text-sm">Aucune description disponible.</p>
              )}

              {/* ── Galerie images produit (4 premières) — style AliExpress ── */}
              {(() => {
                const galleryImgs: string[] = ((product as any)?.images || [])
                  .filter(Boolean)
                  .slice(0, 4)
                if (galleryImgs.length === 0) return null
                return (
                  <div className="mt-10 pt-8 border-t border-border">
                    <div className="flex items-center gap-2 mb-5">
                      <div className="w-1 h-5 bg-accent rounded-full" />
                      <h3 className="font-black text-sm uppercase tracking-widest">Photos du produit</h3>
                      <span className="text-[10px] text-muted-foreground font-bold">({galleryImgs.length} photo{galleryImgs.length > 1 ? 's' : ''})</span>
                    </div>
                    {/* Mobile : 1 colonne pleine largeur (portrait, comme AliExpress)
                        Desktop : grille 2×2                                      */}
                    <div className={`grid gap-3 grid-cols-1 sm:grid-cols-2`}>
                      {galleryImgs.map((src, i) => (
                        <div
                          key={src}
                          className={`relative overflow-hidden rounded-2xl bg-muted border border-border/50 shadow-sm
                            ${galleryImgs.length === 3 && i === 2 ? 'sm:col-span-2' : ''}
                          `}
                          style={{ aspectRatio: '3/4' }}
                        >
                          <Image
                            src={src}
                            alt={`${product.name} — vue ${i + 1}`}
                            fill
                            sizes="(max-width: 640px) 100vw, 50vw"
                            className="object-cover hover:scale-105 transition-transform duration-500"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}

              {/* ── Caractéristiques — tableau type Alibaba/AliExpress ── */}
              {(() => {
                // Une seule liste de lignes {label, value}, dans l'ordre :
                // specifications (matière, entretien…) puis attributs de
                // variation, puis origine / boutique / poids / dimensions / réf.
                const rows: { label: string; value: string }[] = [];
                (product.specifications || [])
                  .filter((s) => s && s.k && s.v)
                  .forEach((s) => rows.push({ label: String(s.k), value: String(s.v) }));
                (product.attributes || []).forEach((attr) =>
                  rows.push({ label: attr.name, value: attr.options.join(', ') })
                );
                const origin = product.originCountry || product.country;
                if (origin && !rows.some((r) => /origine/i.test(r.label)))
                  rows.push({ label: 'Origine', value: origin });
                if (product.vendor?.name && !rows.some((r) => /boutique|vendu/i.test(r.label)))
                  rows.push({ label: t.soldBy || 'Vendu par', value: product.vendor.name });
                if (product.weightKg != null && !rows.some((r) => /poids/i.test(r.label)))
                  rows.push({ label: 'Poids', value: `${product.weightKg} kg` });
                if (
                  (product.lengthCm != null || product.widthCm != null || product.heightCm != null) &&
                  !rows.some((r) => /dimension/i.test(r.label))
                )
                  rows.push({
                    label: 'Dimensions',
                    value: `${[product.lengthCm, product.widthCm, product.heightCm]
                      .filter((v) => v != null)
                      .join(' × ')} cm`,
                  });
                if (product.sku && !rows.some((r) => /r[eé]f[eé]rence/i.test(r.label)))
                  rows.push({ label: 'Référence', value: product.sku });

                return (
                  <div className="mt-10 pt-8 border-t border-border">
                    <div className="flex items-center gap-2 mb-5">
                      <div className="w-1 h-5 bg-accent rounded-full" />
                      <h3 className="font-black text-sm uppercase tracking-widest">Caractéristiques</h3>
                    </div>
                    {rows.length === 0 ? (
                      <p className="text-muted-foreground text-sm">Aucune spécification technique disponible.</p>
                    ) : (
                      <div className="overflow-hidden rounded-2xl border border-border">
                        <table className="w-full text-sm">
                          <tbody>
                            {rows.map((r, i) => (
                              <tr
                                key={`${r.label}-${i}`}
                                className={i % 2 === 0 ? 'bg-muted/40' : 'bg-background'}
                              >
                                <th
                                  scope="row"
                                  className="w-2/5 align-top px-4 py-3 text-left font-semibold text-muted-foreground border-b border-border/60"
                                >
                                  {r.label}
                                </th>
                                <td className="px-4 py-3 align-top font-medium border-b border-border/60">
                                  {r.value}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })()}
              </div>
            </div>
          </div>

          <div className="pt-10 pb-10 border-t border-border">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
              <div className="lg:col-span-9">
              <h2 className="text-xl font-black uppercase tracking-tight mb-6">{t.reviews} {reviewStats.total > 0 ? `(${reviewStats.total})` : ''}</h2>
              <div className="grid grid-cols-1 md:grid-cols-12 gap-12">
                {/* Résumé des notes */}
                <div className="md:col-span-4 space-y-6">
                  <div className="bg-slate-50 p-8 rounded-4xl text-center">
                    <p className="text-5xl font-black text-slate-900">{reviewStats.average}</p>
                    <div className="flex justify-center gap-1 my-3">
                      {[...Array(5)].map((_, i) => (
                        <Star key={i} size={18} className={cn("fill-orange-400 text-orange-400", i >= Math.floor(reviewStats.average) && "text-slate-200 fill-slate-200")} />
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest">
                      {reviewStats.total > 0 ? `${reviewStats.total} avis clients` : 'Soyez le premier à donner votre avis'}
                    </p>
                  </div>

                  {reviewStats.total > 0 && (
                    <div className="space-y-3">
                      {reviewStats.distribution.map((d) => (
                        <div key={d.stars} className="flex items-center gap-4 text-xs font-bold">
                          <span className="w-12 text-slate-400">{d.stars} {t.stars || 'étoiles'}</span>
                          <Progress value={d.percent} className="h-1.5 flex-1 bg-slate-100" />
                          <span className="w-8 text-right text-slate-400">{d.percent}%</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <ProductReviewForm
                    productId={Number(product.id)}
                    productName={product.name}
                    user={user}
                    onReviewSubmitted={() => mutateReviews()}
                  />
                </div>

                {/* Liste des vrais avis WooCommerce */}
                <div className="md:col-span-8 space-y-8">
                  {realReviews.length === 0 ? (
                    <div className="text-center py-16 text-slate-400">
                      <Star size={40} className="mx-auto mb-4 opacity-20" />
                      <p className="font-bold text-sm">{t.noReviews}</p>
                      <p className="text-xs mt-1">{t.shareYourExperience}</p>
                    </div>
                  ) : (
                    realReviews.map((rev) => (
                      <div key={rev.id} className="border-b border-slate-100 pb-8 last:border-0">
                        <div className="flex justify-between items-start mb-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center font-black text-slate-400 text-sm">
                              {(rev.reviewer || 'C')[0].toUpperCase()}
                            </div>
                            <div>
                              <p className="text-sm font-black flex items-center gap-2">
                                {rev.reviewer}
                                {rev.verified && (
                                  <span className="bg-blue-50 text-blue-600 text-[8px] px-1.5 py-0.5 rounded-full uppercase tracking-tighter">Achat vérifié</span>
                                )}
                              </p>
                              <div className="flex gap-0.5 mt-0.5">
                                {[...Array(5)].map((_, i) => (
                                  <Star key={i} size={10} className={cn("fill-orange-400 text-orange-400", i >= rev.rating && "text-slate-200 fill-slate-200")} />
                                ))}
                              </div>
                            </div>
                          </div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase" suppressHydrationWarning>
                            {rev.date ? new Date(rev.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}
                          </span>
                        </div>
                        <p className="text-sm text-slate-600 leading-relaxed">{rev.review}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
              </div>
            </div>
          </div>

          <div className="pt-10 pb-10 space-y-16 border-t border-border">
            <h2 className="text-xl font-black uppercase tracking-tight">{t.recommendations}</h2>
            <FrequentlyBoughtTogether
              productId={product.id}
              onProductClick={(p) => { onProductClick(p); window.scrollTo(0, 0); }}
              onAddToCart={(p) => onAddToCart(p, 1)}
            />

            <SimilarProducts
              productId={product.id}
              onProductClick={(p) => { onProductClick(p); window.scrollTo(0, 0); }}
              onAddToCart={(p) => onAddToCart(p, 1)}
            />

            {/* Section: Plus de cette boutique - Fix protection vendor.name */}
            {sameStoreProducts.length > 0 && product.vendor && (
              <div>
                <div className="flex justify-between items-center mb-6">
                  <h2 className="text-xl font-bold">Plus de chez {product.vendor?.name}</h2>
                  {product.vendor && (
                    // Bouton (pas <Link href="/vendor/[slug]">) : la vraie page
                    // Next /vendor/[slug] fait un rechargement complet sur
                    // mobile (sortie du SPA, panier/scroll perdus). onStoreClick
                    // bascule la vue en client, comme les autres boutons vendeur
                    // de cette page. Signalé le 2026-08-29 (audit nav mobile).
                    <button
                      type="button"
                      onClick={() => product.vendor && onStoreClick(product.vendor)}
                      className="inline-flex items-center gap-1 text-accent font-bold hover:underline text-sm"
                    >
                      Voir toute la boutique <ChevronRight size={16} />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                  {sameStoreProducts.map(p => (
                    <ProductCard
                      key={p.id}
                      product={p}
                      onClick={(clickedProd) => { onProductClick(clickedProd); window.scrollTo(0,0); }}
                      onAddToCart={(addedProd) => onAddToCart(addedProd, 1)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Scroll infini (demandé le 2026-07-23, même mécanisme que
                l'accueil) : au-delà des recommandations personnalisées
                ci-dessus, une découverte à la volée sans limite fixe.
                cacheKey isolé par produit pour ne pas mélanger son état
                avec celui du feed de l'accueil ou d'une autre fiche. */}
            <InfiniteProductFeed cacheKey={`product-${product.id}`} language={(product.lang || 'fr') as 'fr' | 'en'} title={product.lang === 'en' ? 'Discover more products' : "Découvrir d'autres produits"} />
          </div>
        </div>
      </div>

      {/* AliExpress Style: Fixed Mobile Bottom Bar */}
      <div className="sm:hidden fixed bottom-0 left-0 right-0 h-16 bg-background border-t border-border z-50 px-4 flex items-center gap-4 shadow-[0_-4px_10px_rgba(0,0,0,0.05)]">
        <div className="flex gap-4">
          <button type="button" onClick={() => product.vendor && onStoreClick(product.vendor)} className="flex flex-col items-center gap-1 text-muted-foreground">
            <Store size={20} />
            <span className="text-[10px] font-medium">{t.shop || "Boutique"}</span>
          </button>
          <button type="button" onClick={handleWhatsApp} className="flex flex-col items-center gap-1 text-muted-foreground">
            <MessageCircle size={20} />
            <span className="text-[10px] font-medium">{t.chat || "Chat"}</span>
          </button>
          <button type="button" onClick={onCartClick} className="flex flex-col items-center gap-1 text-muted-foreground relative">
            <ShoppingCart size={20} />
            <span className="text-[10px] font-medium">Panier</span>
            {cartCount > 0 && (
              <span className="absolute -top-1 right-0 bg-accent text-white text-[8px] font-black w-3.5 h-3.5 flex items-center justify-center rounded-full border border-white">
                {cartCount}
              </span>
            )}
          </button>
        </div>
        <div className="flex-1 flex gap-2">
          <button
            type="button"
            onClick={handleAddToCartClick}
            className="flex-1 bg-orange-100 text-orange-600 font-bold py-3 rounded-full text-xs"
          >
            {t.addToCart || "Ajouter"}
          </button>
          <button
            type="button"
            onClick={handleBuyNowClick}
            className="flex-1 bg-accent text-white font-bold py-3 rounded-full text-xs shadow-lg shadow-accent/20"
          >
            {t.buyNow || "Acheter"}
          </button>
        </div>
      </div>
 
    </main>
  )
}
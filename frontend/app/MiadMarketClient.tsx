"use client"

import { useState, useMemo, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import { trackEvent } from '@/lib/analytics'
import { mktViewContent, mktAddToCart, mktInitiateCheckout, mktSearch } from '@/lib/marketing-events'
import { Header } from '@/components/miad/Header'
import { HomePage, TopVendorsStrip, VendorCTA } from '@/components/miad/HomePage'
import { HomeCategoryTabs } from '@/components/miad/HomeCategoryTabs'
import { HomeCategoryTabSection } from '@/components/miad/HomeCategoryTabSection'
import { HeroSection } from '@/components/miad/HeroSection'
import { CategoriesSection } from '@/components/miad/CategoriesSection'
import { toast } from 'sonner'
import { ProductDetail } from '@/components/miad/ProductDetail'
import { CartPage } from '@/components/miad/CartPage'
import { CheckoutPage } from '@/components/miad/CheckoutPage'
import { Dashboard } from '@/components/miad/Dashboard'
import { ClientDashboard } from '@/components/miad/ClientDashboard'
import { LoginPage } from '@/components/miad/LoginPage'
import { QuickSelectModal } from '@/components/miad/QuickSelectModal'
import { ContactVendorForm } from '@/components/miad/ContactVendorForm'
import { VendorStorePage } from '@/app/VendorStorePage'
import { CountryPage } from '@/components/miad/CountryPage'
import { CategoryPage } from '@/components/miad/CategoryPage'
import { Footer } from '@/components/miad/Footer'
import { MobileSidebar } from '@/components/miad/MobileSidebar' 
import { CategoriesListPage } from '@/components/miad/CategoriesListPage'
import { StoresListPage } from '@/components/miad/StoresListPage'
import { ProductCard } from '@/components/miad/ProductCard'
import { Button } from '@/components/ui/button'
import { HelpCenter } from '@/components/miad/HelpCenter'
import { OrderHistory } from '@/components/miad/OrderHistory'
import { ProductSkeleton } from '@/components/miad/ProductSkeleton'
import { Skeleton } from '@/components/ui/skeleton'
import { ProductFilterSidebar } from '@/components/miad/ProductFilterSidebar'
import { filterAndSortProducts } from '@/lib/product-filters'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

import { Home, LayoutGrid, User, ShoppingBag, Search, Store, ShoppingCart, ArrowLeft, Star, LayoutDashboard, Package, Heart, MessageCircle, MapPin, Tag, QrCode, BarChart2, Settings, X, SlidersHorizontal } from 'lucide-react'
import { type WooProduct, type CartItem, type WooVendor, type Country, type WooCategory, type WooProductVariation, countries, formatPrice, translations, toCartProduct } from '@/lib/woocommerce'
import { CART_KEY } from '@/lib/cart-store'
import { StreamedNavClickProvider } from '@/contexts/StreamedNavClickContext'
import { CountryDetectionBanner } from '@/components/miad/CountryDetectionBanner'
import { ScrollToTopButton } from '@/components/miad/ScrollToTopButton'

type View =
  | 'home'
  | 'product'
  | 'cart'
  | 'checkout'
  | 'vendorDashboard'
  | 'clientDashboard'
  | 'login'
  | 'store'
  | 'category'
  | 'country'
  | 'delivery'
  | 'about'
  | 'shippingInfo'
  | 'services'
  | 'search'
  | 'categoriesList'
  | 'orderHistory'
  | 'storesList'
  | 'help'
  | 'contact'

const MOBILE_VENDOR_SECTIONS = [
  { id: 'overview',  label: 'Aperçu',       icon: LayoutDashboard },
  { id: 'products',  label: 'Produits',      icon: Package },
  { id: 'orders',    label: 'Commandes',     icon: ShoppingCart },
  { id: 'analytics', label: 'Analytiques',   icon: BarChart2 },
  { id: 'settings',  label: 'Paramètres',    icon: Settings },
]

const MOBILE_CLIENT_SECTIONS = [
  { id: 'overview',  label: 'Aperçu',        icon: LayoutDashboard },
  { id: 'orders',    label: 'Commandes',     icon: Package },
  { id: 'messages',  label: 'Messages',      icon: MessageCircle },
  { id: 'addresses', label: 'Adresses',      icon: MapPin },
  { id: 'settings',  label: 'Paramètres',    icon: Settings },
]

function MobileBottomNav({ currentView, cartCount, isLoggedIn, userType, language, onHome, onNavigate, onAccount, onSectionClick }: {
  currentView: string
  cartCount: number
  isLoggedIn: boolean
  userType: 'buyer' | 'vendor'
  language: 'fr' | 'en'
  onHome: () => void
  onNavigate: (view: View) => void
  onAccount: () => void
  onSectionClick: (section: string) => void
}) {
  const t = translations[language]
  const [showSections, setShowSections] = useState(false)
  const sections = userType === 'vendor' ? MOBILE_VENDOR_SECTIONS : MOBILE_CLIENT_SECTIONS

  const handleAccountTap = () => {
    if (!isLoggedIn) { onAccount(); return }
    setShowSections(o => !o)
  }

  return (
    <>
      {/* Section popup panel */}
      {showSections && isLoggedIn && (
        <div className="md:hidden fixed bottom-[60px] left-0 right-0 z-[55] bg-white border-t border-border shadow-2xl rounded-t-3xl animate-in slide-in-from-bottom-2 duration-200">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Mon espace</p>
            <button type="button" onClick={() => setShowSections(false)} aria-label="Fermer" className="p-1 text-slate-400 hover:text-slate-700">
              <X size={16} />
            </button>
          </div>
          <div className="grid grid-cols-5 gap-1 p-3">
            {sections.map(s => (
              <button
                type="button"
                key={s.id}
                onClick={() => { setShowSections(false); onSectionClick(s.id) }}
                className="flex flex-col items-center gap-1.5 p-2 rounded-2xl hover:bg-accent/10 active:bg-accent/20 transition-colors"
              >
                <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center text-accent">
                  <s.icon size={18} />
                </div>
                <span className="text-[9px] font-bold text-center text-slate-600 leading-tight">{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {showSections && (
        <div
          className="md:hidden fixed inset-0 z-[54]"
          role="button"
          tabIndex={0}
          aria-label="Fermer"
          onClick={() => setShowSections(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setShowSections(false) }}
        />
      )}

      <div className="mobile-bottom-nav md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-border z-50 pt-2 flex justify-around items-center shadow-[0_-2px_10px_rgba(0,0,0,0.05)]">
        <button type="button" onClick={onHome} className={`flex flex-col items-center gap-0.5 ${currentView === 'home' ? 'text-accent' : 'text-muted-foreground'}`}>
          <Home size={20} />
          <span className="text-[10px] font-medium">{t.home}</span>
        </button>
        <button type="button" onClick={() => onNavigate('categoriesList')} className={`flex flex-col items-center gap-0.5 ${currentView === 'category' || currentView === 'categoriesList' ? 'text-accent' : 'text-muted-foreground'}`}>
          <LayoutGrid size={20} />
          <span className="text-[10px] font-medium">{t.categories}</span>
        </button>
        <button type="button" onClick={() => onNavigate('storesList')} className={`flex flex-col items-center gap-0.5 ${currentView === 'storesList' ? 'text-accent' : 'text-muted-foreground'}`}>
          <Store size={20} />
          <span className="text-[10px] font-medium">{t.stores}</span>
        </button>
        <button type="button" onClick={() => onNavigate('cart')} className={`flex flex-col items-center gap-0.5 ${currentView === 'cart' ? 'text-accent' : 'text-muted-foreground'}`}>
          <div className="relative">
            <ShoppingBag size={20} />
            {cartCount > 0 && (
              <span className="absolute -top-1.5 -right-2 bg-accent text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full min-w-4.5 border-2 border-white">
                {cartCount}
              </span>
            )}
          </div>
          <span className="text-[10px] font-medium">{t.cart}</span>
        </button>
        <button
          type="button"
          onClick={handleAccountTap}
          className={`flex flex-col items-center gap-0.5 ${['vendorDashboard', 'clientDashboard', 'login'].includes(currentView) || showSections ? 'text-accent' : 'text-muted-foreground'}`}
        >
          <User size={20} />
          <span className="text-[10px] font-medium">{t.account}</span>
        </button>
      </div>
    </>
  )
}

type NavSnapshot = {
  view: View
  selectedProduct: WooProduct | null
  selectedVendor: WooVendor | null
  selectedCategory: string | null
  activeCountry: Country | null
  // Onglet catégorie actif de l'accueil ('explore' ou un slug). Doit être
  // restauré au retour arrière : sans lui, ouvrir un produit depuis
  // l'onglet "Sacs" puis revenir retombait sur l'onglet mémorisé "au
  // hasard" (state React non réinitialisé) — fragile.
  homeTab: string
  // Terme de recherche au moment où on quitte la vue 'search'. Restauré au
  // retour pour ré-afficher les résultats ET le champ rempli (avant, le
  // retour vers une recherche ré-affichait la grille mais avec le champ
  // vide, les gardes anti-skeleton le nettoyant volontairement).
  searchQuery: string
  // Filtres de la page catégorie (tri, pays, prix, note). Comme homeTab et
  // searchQuery, ils vivaient en useState LOCAL dans CategoryPage — perdus
  // dès qu'on ouvrait un produit (CategoryPage se démonte), donc au retour
  // arrière la liste revenait triée "newest" sans filtre, et la position
  // de scroll ne retombait plus juste (liste différente). Remontés ici +
  // capturés dans le snapshot pour un vrai retour à l'identique.
  categoryFilters: CategoryFilterState
  scrollY: number
}

export type CategoryFilterState = {
  sortBy: string
  selectedCountries: string[]
  priceRange: [number, number]
  minRating: number
}

const DEFAULT_CATEGORY_FILTERS: CategoryFilterState = {
  sortBy: 'newest',
  selectedCountries: [],
  priceRange: [0, 1000000],
  minRating: 0,
}

type MiadMarketClientProps = {
  initialProducts: WooProduct[]
  initialCategories: WooCategory[]
  initialStores: WooVendor[]
  initialUserCountryCode: string;
  forcedView?: View;
  forcedVendorSlug?: string;
  forcedProductSlug?: string;
  shippingRates: Record<string, any>;
  stripeReturn?: { orderId: number; paymentIntentId?: string };
  sharedCartId?: string;
  // Sections de l'accueil par défaut, streamées indépendamment côté serveur
  // (voir components/miad/server/HomeSections.tsx) — un React Server
  // Component ne peut être composé dans cet arbre client qu'en le recevant
  // déjà rendu, comme n'importe quel autre enfant (cf. page.tsx).
  homeSections?: ReactNode;
  // Langue explicite fournie par l'URL (?lang=en/fr) au moment du rendu
  // serveur de homeSections — undefined pour une visite normale (pas de
  // ?lang= dans l'URL), auquel cas le client se fie à localStorage comme
  // avant. Défini uniquement pour un lien direct partagé (?lang=en) ou
  // notre propre navigation de bascule de langue (voir handleLanguageChange
  // plus bas) — dans ces deux cas, homeSections est déjà rendu dans CETTE
  // langue côté serveur, donc le client doit s'y aligner sans repasser par
  // localStorage/navigator.language qui pourraient dire autre chose.
  initialLang?: 'fr' | 'en';
}

/**
 * Utilitaire de partage professionnel (WhatsApp, etc.)
 */
const shareMiadContent = async (title: string, text: string, url: string) => {
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
    } catch (e) { /* Partage annulé */ }
  } else {
    await navigator.clipboard.writeText(url);
    toast.success("Lien copié dans le presse-papier !");
  }
};

const publicFetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const error = new Error(`Erreur HTTP: ${res.status}`);
    throw error;
  }
  return res.json();
}

const swrOptions = {
  // SWR caching strategy for client-side data fetching (AliExpress style)
  revalidateOnFocus: false,
  dedupingInterval: 60000,
  keepPreviousData: true,
  revalidateIfStale: false, // Évite de re-fetcher au retour sur la page si les données sont là
  persistSize: true, // Garde le nombre de pages chargées en mémoire
}

// Squelette de page générique — évite l'effondrement du layout pendant les transitions
const PageSkeleton = () => (
  <div className="min-h-screen bg-muted/20 py-10 pb-24">
    <div className="container mx-auto px-4">
      <div className="flex items-center gap-3 mb-6">
        <Skeleton className="h-8 w-8 rounded-lg" />
        <Skeleton className="h-6 w-48 rounded" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {[...Array(12)].map((_, i) => <ProductSkeleton key={i} />)}
      </div>
    </div>
  </div>
)

export default function MiadMarketClient({ initialProducts, initialCategories, initialStores, initialUserCountryCode, forcedView, forcedVendorSlug, forcedProductSlug, shippingRates, stripeReturn, sharedCartId, homeSections, initialLang }: MiadMarketClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  // --- 1. ETATS (Doivent être en haut pour éviter les erreurs de TDZ) ---
  const [language, setLanguage] = useState<'fr' | 'en'>(initialLang || 'fr')
  const [currentView, setCurrentView] = useState<View>(forcedView || 'home')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchSelectedCountries, setSearchSelectedCountries] = useState<string[]>([])
  const [searchPriceRange, setSearchPriceRange] = useState<[number, number]>([0, 1000000])
  const [searchMinRating, setSearchMinRating] = useState(0)
  const [searchSortBy, setSearchSortBy] = useState('newest')
  const [isSearchFilterMobileOpen, setIsSearchFilterMobileOpen] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState<WooProduct | null>(() => {
    if (!forcedProductSlug) return null
    return initialProducts.find(p => p.slug === forcedProductSlug) ?? null
  })
  const [selectedVendor, setSelectedVendor] = useState<WooVendor | null>(() => {
    if (!forcedVendorSlug) return null
    return initialStores.find(s => s.slug === forcedVendorSlug || s.id === forcedVendorSlug) ?? null
  })
  const [activeCountry, setActiveCountry] = useState<Country | null>(null);
  // Pas de fallback 'sn' : un pays non détecté doit rester vide, sinon isLocalDelivery()
  // fait passer les produits sénégalais (majoritaires) pour de la livraison locale
  // auprès de visiteurs dont le pays réel est simplement inconnu.
  const [selectedCountryCode, setSelectedCountryCode] = useState(initialUserCountryCode || '');
  // Pays pré-rempli par détection IP au premier rendu (pas un choix du
  // client) — pilote l'affichage du CountryDetectionBanner tant qu'il n'a
  // pas confirmé/changé son pays (voir app/page.tsx pour la détection).
  const [countryWasAutoDetected] = useState(!!initialUserCountryCode);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  // Filtres de la page catégorie, remontés ici (voir CategoryFilterState) :
  // état partagé pour survivre à l'ouverture d'un produit et être restauré
  // à l'identique au retour arrière (snapshot navStack).
  const [categoryFilters, setCategoryFilters] = useState<CategoryFilterState>(DEFAULT_CATEGORY_FILTERS)
  // Onglet catégorie de l'accueil (style AliExpress) : 'explore' = accueil normal,
  // sinon slug de catégorie → bannière + grille dédiées (voir HomeCategoryTabSection).
  const [homeTab, setHomeTab] = useState<string>('explore')
  const [cart, setCart] = useState<CartItem[]>([])
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [userName, setUserName] = useState('')
  const [userType, setUserType] = useState<'buyer' | 'vendor'>('buyer')
  // isRep/prevView : lus uniquement dans des handlers, jamais affichés à
  // l'écran — un useRef évite un re-render inutile à chaque mise à jour.
  const isRep = useRef(false)
  const [activeHelpTopic, setActiveHelpTopic] = useState<string | undefined>()
  const prevView = useRef<View | null>(null)
  // Passe à true dès que l'accueil (avec ses homeSections) a été rendu au
  // moins une fois dans CE montage de MiadMarketClient. Sert à décider si un
  // retour arrière vers 'home' a besoin d'un router.refresh() (flash
  // skeleton) : inutile — et donc à éviter — quand l'accueil est déjà en
  // mémoire (cas normal des nav SPA ?v=). Le refresh n'est vraiment
  // nécessaire que si on a atterri directement sur une route externe
  // (/product/[slug]) sans jamais peindre l'accueil, puis qu'on revient.
  const homeRenderedRef = useRef(currentView === 'home' && Boolean(homeSections))
  const [quickProduct, setQuickProduct] = useState<WooProduct | null>(null)
  const [hideEmptyCategories, setHideEmptyCategories] = useState(false)
  const [pendingDashboardSection, setPendingDashboardSection] = useState<string | undefined>()
  const [stripeConfirmedOrderId, setStripeConfirmedOrderId] = useState<number | null>(null)
  const [vendorKey, setVendorKey] = useState(0)
  // Graine du tri aléatoire de l'accueil — une seule fois par onglet/session
  // (sessionStorage, pas localStorage : on veut un nouvel ordre à la prochaine
  // vraie visite, mais le MÊME ordre tant qu'on navigue dans cet onglet, y
  // compris après un retour arrière depuis une fiche produit). Générée dans
  // l'initialiseur (exécuté une seule fois, au montage) plutôt qu'un
  // useEffect : évite un premier fetch sans graine suivi d'un refetch avec
  // graine dès qu'elle serait posée. '' côté serveur (pas de sessionStorage
  // en SSR) — sans incidence, cette valeur ne sert qu'à construire une clé
  // SWR, jamais rendue dans le HTML, donc aucun risque de mismatch d'hydratation.
  const [homeShuffleSeed] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    try {
      const existing = sessionStorage.getItem('miad_home_seed')
      if (existing) return existing
      const fresh = Math.random().toString(36).slice(2)
      sessionStorage.setItem('miad_home_seed', fresh)
      return fresh
    } catch {
      return ''
    }
  })

  // Restore language from storage after hydration (avoids error #418).
  // Sauté si l'URL fournissait déjà ?lang= explicitement (initialLang) : dans
  // ce cas homeSections est déjà rendu côté serveur dans cette langue-là, la
  // remplacer par la valeur localStorage ici recréerait exactement le
  // décalage FR/EN qu'on corrige (voir MiadMarketClientProps.initialLang).
  //
  // Plus de bascule auto sur navigator.language : le sélecteur FR/EN est
  // masqué depuis le 2026-07-14 (le site reste en français), et les
  // traductions EN du catalogue ne sont PAS enrichies (description/
  // subtitle/tags vides côté EN). Un navigateur configuré en anglais
  // basculait donc toute la fiche produit sur ?lang=en et affichait
  // "Aucune description disponible" alors que le FR est complet (signalé
  // le 2026-09-02). On ne suit plus que 'miad_lang' s'il a été posé
  // explicitement.
  useEffect(() => {
    if (initialLang) return
    const saved = localStorage.getItem('miad_lang') as 'fr' | 'en'
    if (saved === 'fr' || saved === 'en') setLanguage(saved)
  }, [initialLang])

  // Capture du code de parrainage représentant (?ref=CODE) — persisté en
  // localStorage (pas juste l'URL courante) car le visiteur navigue
  // souvent avant de s'inscrire, transmis à /api/auth/otp/verify par
  // RegisterPage.tsx au moment de la création réelle du compte. Ne remplace
  // jamais un code déjà enregistré (premier lien cliqué gagne, cohérent
  // avec ON CONFLICT DO NOTHING côté loyalty-svc — pas de re-parrainage
  // silencieux si le visiteur reclique un autre lien plus tard).
  useEffect(() => {
    const ref = searchParams.get('ref')
    if (ref && !localStorage.getItem('miad_referral_code')) {
      localStorage.setItem('miad_referral_code', ref)
    }
  }, [searchParams])

  // "Se connecter en tant que ce vendeur" (bouton admin, AllVendors.tsx →
  // POST /admin/api/vendors/{id}/impersonate) ouvre miadmarket.ca/?impersonate_jwt=…
  // — un vrai JWT customer signé par auth-svc (role:"customer" + vendor_id,
  // voir isVendor() dans lib/miad-server-auth.ts), jamais lu côté client
  // avant le 2026-09-03 : ce paramètre n'était traité nulle part, donc le
  // clic ouvrait juste l'accueil normal, déconnecté. On installe ce JWT
  // exactement comme le fait LoginPage après une connexion classique, puis
  // on redirige vers le dashboard vendeur — sans jamais renvoyer ce token
  // vers l'origine (il est déjà dans l'URL, donc potentiellement dans les
  // logs serveur/historique : on le retire de la barre d'adresse
  // immédiatement après l'avoir consommé).
  useEffect(() => {
    const impersonateJwt = searchParams.get('impersonate_jwt')
    if (!impersonateJwt) return

    // Nettoie l'URL tout de suite (avant même la résolution du profil) pour
    // ne jamais laisser ce token trainer dans l'historique/un rafraîchissement.
    const url = new URL(window.location.href)
    url.searchParams.delete('impersonate_jwt')
    window.history.replaceState({}, '', url.toString())

    ;(async () => {
      try {
        const res = await fetch('/api/customer', { headers: { Authorization: `Bearer ${impersonateJwt}` } })
        const data = await res.json()
        if (!res.ok || !data?.success) {
          toast.error("Ce lien de connexion vendeur n'est plus valide.")
          return
        }
        const profile = data.data
        localStorage.removeItem('miad_token'); localStorage.removeItem('miad_user'); localStorage.removeItem('miad_role')
        localStorage.setItem('miad_token', impersonateJwt)
        localStorage.setItem('miad_user', JSON.stringify({
          display_name: profile.name, user_email: profile.email, user_nicename: profile.email, id: profile.id, avatar: profile.avatar,
        }))
        localStorage.setItem('miad_role', 'vendor')
        setIsLoggedIn(true)
        setUserType('vendor')
        setUserName(profile.name || 'Vendeur')
        navigateTo('vendorDashboard')
      } catch {
        toast.error('Connexion en tant que vendeur impossible (réseau).')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mémorise qu'on a affiché l'accueil au moins une fois dans ce montage :
  // un retour arrière ultérieur vers 'home' n'aura alors plus besoin d'un
  // router.refresh() (plus de flash skeleton du bas de page). Voir
  // restoreFromStack / handlePopState.
  useEffect(() => {
    if (currentView === 'home') homeRenderedRef.current = true
  }, [currentView])

  useEffect(() => {
    if (!forcedView) {
      const saved = sessionStorage.getItem('miad_view') as View
      if (saved && saved !== 'home') setCurrentView(saved)
    }
  }, [forcedView])

  // Ouverture directe d'une section du tableau de bord via l'URL
  // (?v=clientDashboard&section=orders) — utilisé par l'en-tête des pages
  // autonomes (fiche produit) dont le menu "Compte" reproduit celui de
  // l'accueil, et par les liens d'e-mails. Sans ça le dashboard s'ouvrait
  // toujours sur "Aperçu".
  useEffect(() => {
    const section = searchParams.get('section')
    if (forcedView === 'clientDashboard' && section) {
      setPendingDashboardSection(section)
    }
  }, [forcedView, searchParams])

  // Chargement direct d'une fiche produit (lien partagé, favori, actualisation
  // de page) : le produit n'est pas forcément dans les 100 premiers initialProducts,
  // donc on va le chercher par slug si l'initialisation synchrone ne l'a pas trouvé.
  // pendingProductFetch (ref, pas state) : évite que le garde-fou "anti-skeleton
  // infini" plus bas (currentView === 'product' && !selectedProduct → home) ne
  // renvoie vers l'accueil avant que ce fetch ait eu le temps de répondre — un
  // ref se met à jour immédiatement, contrairement à un state qui n'est visible
  // qu'au prochain rendu.
  const pendingProductFetch = useRef(Boolean(forcedProductSlug) && !selectedProduct)
  // Bascule à la fin du fetch (succès ou échec) pour forcer une réévaluation
  // du garde-fou anti-skeleton infini plus bas — pendingProductFetch (ref) ne
  // déclenche pas de re-render à lui seul.
  const [productFetchSettled, setProductFetchSettled] = useState(false)
  useEffect(() => {
    if (forcedView !== 'product' || !forcedProductSlug || selectedProduct) return
    const controller = new AbortController()
    // lang=${language} : sans ça, ce fetch renvoie toujours le produit en FR
    // (défaut catalog-svc), même si l'utilisateur navigue en EN — l'effet
    // "Bascule FR/EN" plus bas le corrige aussitôt, mais ce va-et-vient crée
    // un clignotement visible d'une fraction de seconde sur la fiche produit
    // (bug remonté 2026-09-01).
    fetch(`/api/products?slug=${encodeURIComponent(forcedProductSlug)}&lang=${language}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const p = data?.products?.[0]
        if (p) setSelectedProduct(p)
      })
      .catch(() => {})
      .finally(() => {
        pendingProductFetch.current = false
        setProductFetchSettled(true)
      })
    return () => controller.abort()
  }, [forcedView, forcedProductSlug, selectedProduct, language])

  // Même protection pour un lien direct BOUTIQUE (/?v=vendor&slug=X, favori,
  // partage) : la boutique n'est pas forcément dans les 100 premiers
  // initialStores. Sans ce fetch de secours + le ref pendingVendorFetch,
  // le garde-fou anti-skeleton (currentView === 'store' && !selectedVendor
  // → home) renvoyait à l'accueil AVANT que la boutique ait pu être
  // chargée — asymétrie avec le produit, signalée à l'audit nav mobile du
  // 2026-08-29 (et déjà notée dans CLAUDE.md comme "skeleton indéfini").
  const pendingVendorFetch = useRef(Boolean(forcedVendorSlug) && !selectedVendor)
  const [vendorFetchSettled, setVendorFetchSettled] = useState(false)
  // Slug produit / boutique dont le fetch de secours (effet "réactivité URL"
  // plus bas) a déjà été LANCÉ, pour ne pas le relancer en boucle : cet
  // effet vide selectedProduct/selectedVendor avant de fetch, ce qui le
  // re-déclenche (selectedProduct est dans ses deps) alors que le produit
  // n'est toujours pas dans allProducts → sans cette garde, refetch infini.
  const urlFetchInFlightRef = useRef<string>('')
  useEffect(() => {
    if (forcedView !== 'store' || !forcedVendorSlug || selectedVendor) return
    const controller = new AbortController()
    fetch(`/api/stores?slug=${encodeURIComponent(forcedVendorSlug)}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const s = data?.stores?.[0]
        if (s) { setSelectedVendor(s); setVendorKey(k => k + 1) }
      })
      .catch(() => {})
      .finally(() => {
        pendingVendorFetch.current = false
        setVendorFetchSettled(true)
      })
    return () => controller.abort()
  }, [forcedView, forcedVendorSlug, selectedVendor])

  // Bascule FR/EN pendant qu'une fiche produit est affichée : sans ceci, le
  // switcher du Header changeait `language` (état global) mais la fiche
  // produit restait figée dans sa langue de chargement initial — le
  // sélecteur "marchait" visuellement mais le produit affiché ne suivait
  // jamais (signalé le 27/08). catalog-svc expose déjà `translationOfId`
  // (voir linked.id dans getProduct, main.go) : un seul aller simple par
  // ID, pas de nouvelle recherche par slug, la fiche ne disparaît jamais
  // pendant le fetch (l'ancienne reste affichée jusqu'à ce que la nouvelle
  // soit prête).
  useEffect(() => {
    if (currentView !== 'product' || !selectedProduct) return
    if (selectedProduct.lang === language) return
    const targetId = selectedProduct.translationOfId
    if (!targetId) return
    const controller = new AbortController()
    fetch(`/api/products?id=${targetId}&lang=${language}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const p = data?.products?.[0]
        if (p) setSelectedProduct(p)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [language, currentView, selectedProduct])

  // --- RETOUR STRIPE 3D SECURE ---
  useEffect(() => {
    if (!stripeReturn?.orderId) return
    const token = localStorage.getItem('miad_token') || sessionStorage.getItem('miad_token')
    fetch(`/api/orders/${stripeReturn.orderId}/confirm-stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ payment_intent_id: stripeReturn.paymentIntentId }),
    }).catch(() => {})
    setStripeConfirmedOrderId(stripeReturn.orderId)
    setCurrentView('checkout')
    window.history.replaceState({}, '', '/')
  }, [stripeReturn])

  // --- PERSISTENCE DU PANIER (Anti-effacement au retour) ---
  useEffect(() => {
    const savedCart = localStorage.getItem('miad_cart');
    if (savedCart) {
      try {
        setCart(JSON.parse(savedCart));
      } catch (e) { console.error("Cart recovery failed", e); }
    }
  }, []);

  // Panier serveur (2026-08-26) — jusqu'ici purement localStorage (miad_cart),
  // donc perdu à chaque changement d'appareil, contrairement à la wishlist
  // déjà server-backed. À la connexion, on récupère le panier serveur et on
  // le FUSIONNE avec le panier local courant (jamais un remplacement pur :
  // un visiteur peut avoir ajouté des articles avant de se connecter, ils ne
  // doivent pas disparaître) — en cas de même produit/variation des deux
  // côtés, la quantité la plus grande gagne (hypothèse la moins surprenante :
  // on ne perd jamais silencieusement un article qu'on avait déjà mis dans
  // le panier sur l'un OU l'autre appareil).
  useEffect(() => {
    if (!isLoggedIn) return
    const token = localStorage.getItem('miad_token')
    if (!token) return
    fetch('/api/cart', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const serverItems: { product: WooProduct; quantity: number; variationId: number | null }[] = data?.items || []
        if (serverItems.length === 0) return
        setCart(prev => {
          const keyOf = (productId: string, variationId?: number | string | null) => variationId ? `${productId}-${variationId}` : String(productId)
          const merged = [...prev]
          for (const si of serverItems) {
            const key = keyOf(String(si.product.id), si.variationId)
            const idx = merged.findIndex(i => keyOf(i.product.id, i.variation?.id) === key)
            if (idx >= 0) {
              merged[idx] = { ...merged[idx], quantity: Math.max(merged[idx].quantity, si.quantity) }
            } else {
              merged.push({ product: si.product, quantity: si.quantity, variation: si.variationId ? { id: si.variationId } as any : undefined })
            }
          }
          return merged
        })
      })
      .catch(() => {}) // best-effort : le panier local reste utilisable même si le serveur est injoignable
  }, [isLoggedIn]);

  // Synchronise CHAQUE changement de panier vers le serveur (best-effort,
  // jamais bloquant pour l'UI) — un client non connecté garde un panier
  // purement local (comportement identique à avant, cohérent avec la
  // wishlist qui exige aussi une connexion pour persister). Pas de debounce
  // ici volontairement : chaque clic +/- doit refléter l'état exact voulu
  // par l'utilisateur, un debounce ferait courir le risque qu'un changement
  // rapide (double-clic, retour arrière) n'atteigne jamais le serveur.
  const cartSyncedRef = useRef(false)
  const prevCartKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isLoggedIn) return
    const token = localStorage.getItem('miad_token')
    if (!token) return
    // Ignore le tout premier passage après la fusion serveur→local
    // ci-dessus : sans ça, la fusion elle-même redéclencherait aussitôt un
    // PUT vers le serveur pour des données qui en viennent déjà.
    if (!cartSyncedRef.current) { cartSyncedRef.current = true; return }
    const currentIds = new Set(cart.map(i => i.variation ? `${i.product.id}-${i.variation.id}` : String(i.product.id)))
    for (const item of cart) {
      fetch(`/api/cart/${item.product.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ variationId: item.variation?.id ?? null, quantity: item.quantity }),
      }).catch(() => {})
    }
    // Retire du serveur ce qui a disparu du panier local (suppression) —
    // seule la liste précédente en mémoire (ref) permet de savoir quoi a
    // été retiré, la comparaison ne peut pas se faire sur `cart` seul.
    for (const prevKey of prevCartKeysRef.current) {
      if (!currentIds.has(prevKey)) {
        const [productId, variationId] = prevKey.split('-')
        const qs = variationId ? `?variationId=${variationId}` : ''
        fetch(`/api/cart/${productId}${qs}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      }
    }
    prevCartKeysRef.current = currentIds
  }, [cart, isLoggedIn]);

  // Restauration d'un panier partagé via lien (/?cart=<id>) — permet à un
  // client de reprendre son propre panier sur un autre appareil/navigateur.
  // Remplace le panier local (vide la plupart du temps sur un nouvel appareil).
  useEffect(() => {
    if (!sharedCartId) return
    fetch(`/api/cart-share?id=${encodeURIComponent(sharedCartId)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.items?.length) {
          setCart(data.items)
          toast.success('Panier restauré')
        } else {
          toast.error('Ce lien de panier est introuvable ou a expiré')
        }
      })
      .catch(() => toast.error('Ce lien de panier est introuvable ou a expiré'))
      .finally(() => window.history.replaceState({}, '', '/'))
  }, [sharedCartId]);

  useEffect(() => {
    try {
      // On persiste une version allégée du produit (toCartProduct) — le panier
      // en mémoire garde le produit complet pour l'affichage pendant la
      // session, mais localStorage n'a besoin que des champs lus par
      // CartPage/CheckoutPage. Sans ça, quelques produits différents dans le
      // panier suffisaient à dépasser le quota localStorage (~5-10 Mo).
      const slimCart = cart.map(item => ({ ...item, product: toCartProduct(item.product) }));
      localStorage.setItem('miad_cart', JSON.stringify(slimCart));
    } catch {
      // Quota localStorage toujours dépassé malgré l'allègement (ou
      // localStorage indisponible) — même pattern que AddToCartButton.tsx et
      // ProductDetailWrapper.tsx : on ignore silencieusement plutôt que de
      // laisser l'exception non interceptée faire planter toute l'app
      // ("Application error: a client-side exception has occurred").
    }
  }, [cart]);

  // Synchronisation avec le bus panier partagé (lib/cart-store.ts) — un ajout
  // fait depuis un arbre monté séparément (ex: une section Server Component
  // streamée côté accueil, cf. LinkProductCard) écrit dans localStorage et
  // notifie via l'événement 'miad-cart-change' ; on recharge alors le panier
  // ici pour que le badge du header reste à jour. Les écritures internes à ce
  // composant (setCart + persistance ci-dessus) ne passent pas par ce bus,
  // donc pas de risque de boucle.
  useEffect(() => {
    const reload = () => {
      try {
        const raw = localStorage.getItem(CART_KEY)
        setCart(raw ? JSON.parse(raw) : [])
      } catch {}
    }
    window.addEventListener('miad-cart-change', reload)
    window.addEventListener('storage', reload)
    return () => {
      window.removeEventListener('miad-cart-change', reload)
      window.removeEventListener('storage', reload)
    }
  }, []);

  const isInitialMount = useRef(true)
  const scrollPositions = useRef<Map<string, number>>(new Map())
  const pendingScrollY = useRef<number | null>(null)
  const navStack = useRef<NavSnapshot[]>([])

  // Persistance de la vue courante — uniquement les vues "stateless" (sans sélection requise)
  //
  // 'category' manquait à cette liste (trouvé le 2026-08-19) : cette vue a
  // besoin de selectedCategory pour afficher quoi que ce soit, exactement
  // comme 'product'/'vendor' ont besoin de selectedProduct/selectedVendor —
  // mais selectedCategory n'est jamais persisté. Sur un vrai rechargement
  // (pas une restauration douce via popstate+navStack — ex: retour natif du
  // navigateur qui recharge la page sur mobile), sessionStorage restaurait
  // currentView='category' pendant que selectedCategory retombait à null,
  // laissant la grille de produits vide sous la bannière catégorie —
  // signalé comme "on ne voit que la bannière au lieu de voir les produits".
  useEffect(() => {
    const STATEFUL_VIEWS = ['login', 'checkout', 'product', 'vendor', 'country', 'category']
    if (!STATEFUL_VIEWS.includes(currentView)) {
      sessionStorage.setItem('miad_view', currentView)
    }
  }, [currentView])

  // Restauration du scroll après changement de vue (retour arrière). La vue
  // qu'on restaure (ex: l'accueil) vient d'être remontée — un seul rAF ne
  // laissait pas toujours le temps à la grille de produits d'atteindre sa
  // hauteur finale avant le scrollTo, donc le retour n'atterrissait pas
  // exactement là où le client avait quitté la page (signalé le 2026-07-16,
  // "les deux/partout"). On réessaie sur plusieurs frames tant que la page
  // n'est pas encore assez haute pour contenir la position cible, avec une
  // limite pour ne jamais bloquer indéfiniment.
  useEffect(() => {
    if (pendingScrollY.current !== null) {
      const y = pendingScrollY.current
      pendingScrollY.current = null
      let attempts = 0
      const tryScroll = () => {
        attempts++
        const tallEnough = document.documentElement.scrollHeight - window.innerHeight >= y
        if (tallEnough) {
          window.scrollTo(0, y)
        } else if (attempts < 20) {
          requestAnimationFrame(tryScroll)
        }
        // Sinon (20 tentatives épuisées, page toujours trop courte pour y) : on
        // abandonne sans forcer le scroll. window.scrollTo(0, y) avec un y trop
        // grand est automatiquement ramené (clampé) tout en bas par le navigateur
        // — la page s'ouvrait donc scrollée en bas d'écran au lieu du haut,
        // notamment en revenant sur une page devenue plus courte que la position
        // quittée (ex: boutique avec peu de produits) — signalé le 2026-07-30.
      }
      requestAnimationFrame(tryScroll)
    }
  }, [currentView])

  // Dashboard KPI admin : vue de page à chaque changement, et entrée dans le
  // checkout en particulier (étape clé de l'entonnoir d'achat).
  useEffect(() => {
    trackEvent('page_view')
    if (currentView === 'checkout') {
      trackEvent('checkout_start', { metadata: { cart: cart.map(i => ({ id: i.product.id, name: i.product.name, qty: i.quantity, price: i.product.price })) } })
      mktInitiateCheckout({
        value: cart.reduce((s, i) => s + (Number(i.variation?.price || i.product.price) || 0) * i.quantity, 0),
        numItems: cart.reduce((s, i) => s + i.quantity, 0),
        contentIds: cart.map(i => String(i.product.id)),
        currency: cart[0]?.product.currency,
      })
    }
  }, [currentView])

  // loginReturnTo : destination explicite après connexion (ex: 'checkout'
  // pour "Acheter maintenant" non connecté) — sans ça, cette valeur était
  // écrasée juste en dessous par `currentView`, donc l'appelant pouvait
  // bien faire `prevView.current = 'checkout'` juste avant, ça ne servait
  // jamais à rien : le client atterrissait sur son dashboard après connexion
  // au lieu du checkout (signalé le 2026-07-16).
  const navigateTo = useCallback((view: View, scrollToTop = true, pushUrl?: string, loginReturnTo?: View) => {
    if (view === currentView) return
    scrollPositions.current.set(currentView, window.scrollY)

    navStack.current.push({
      view: currentView,
      selectedProduct,
      selectedVendor,
      selectedCategory,
      activeCountry,
      homeTab,
      searchQuery,
      categoryFilters,
      scrollY: window.scrollY,
    })

    // Création de l'entrée d'historique.
    //
    // - pushUrl fourni ET différent de l'URL courante (product/vendor/
    //   country → /?v=...) : router.push, pour que Next App Router connaisse
    //   cette entrée (sinon un retour arrière la recharge en entier).
    // - sinon (vues sans URL propre : category, search, cart, dashboards…,
    //   ou pushUrl === URL courante) : router.push('/') sur une URL déjà
    //   égale à '/' ne crée AUCUNE entrée d'historique — le bouton retour
    //   sortait alors du site (ex. "Voir tout" d'une rangée catégorie de
    //   l'accueil, signalé le 2026-08-31). window.history.pushState, lui,
    //   empile toujours une entrée ; le popstate + navStack la restaurent
    //   comme les autres.
    const here = window.location.pathname + window.location.search
    if (pushUrl && pushUrl !== here) {
      router.push(pushUrl, { scroll: false })
    } else {
      window.history.pushState({}, '', here)
    }

    const returnTarget = loginReturnTo || currentView
    if (view === 'login') {
      sessionStorage.setItem('miad_login_return', returnTarget)
    }
    prevView.current = returnTarget
    setCurrentView(view)
    if (scrollToTop) window.scrollTo(0, 0)
  }, [currentView, selectedProduct, selectedVendor, selectedCategory, activeCountry, homeTab, searchQuery, categoryFilters, router])

  // searchQuery n'est volontairement pas dans le snapshot (une recherche ne
  // définit pas d'entrée d'historique dédiée) — mais retomber sur l'accueil
  // pile vide sans le nettoyer laissait `filterActive` (renderMainContent,
  // case 'home') bloqué à true indéfiniment : homeSections restait ignoré
  // au profit du fallback HomePage, qui masque les produits en navigation
  // libre. Même bug que onHomeClick/onHome ci-dessous, signalé le 27/08
  // ("l'accueil normal ne revient plus").
  const restoreFromStack = useCallback(() => {
    const snapshot = navStack.current.pop()
    if (!snapshot) {
      setCurrentView('home')
      setSearchQuery('')
      window.scrollTo(0, 0)
      return
    }
    pendingScrollY.current = snapshot.scrollY
    setCurrentView(snapshot.view)
    setSelectedProduct(snapshot.selectedProduct)
    setSelectedVendor(snapshot.selectedVendor)
    setSelectedCategory(snapshot.selectedCategory)
    setActiveCountry(snapshot.activeCountry)
    setHomeTab(snapshot.homeTab ?? 'explore')
    // Restaure les filtres de la page catégorie exactement comme au départ
    // (tri, pays, prix, note) — sinon la liste revenait "newest" sans
    // filtre et la position de scroll ne retombait plus juste.
    setCategoryFilters(snapshot.categoryFilters ?? DEFAULT_CATEGORY_FILTERS)
    // On ne restaure searchQuery QUE si on revient sur la vue 'search' :
    // sinon on ré-armerait `filterActive` sur l'accueil (grille filtrée au
    // lieu de homeSections) — c'est justement ce que les gardes
    // anti-skeleton nettoient.
    setSearchQuery(snapshot.view === 'search' ? (snapshot.searchQuery ?? '') : '')
    // router.refresh() en revenant à l'accueil : à ne faire QUE si l'accueil
    // n'a jamais été peint dans ce montage (homeRenderedRef === false) —
    // c.-à-d. arrivée directe sur une route externe /product|/vendor/[slug]
    // puis retour, où homeSections serait vide (hero + bandeau boutiques
    // puis rien, signalé le 2026-08-28). Dans le cas NORMAL des navigations
    // SPA (?v=product…), l'accueil est déjà en mémoire : un refresh
    // re-suspendrait l'arbre RSC et ferait clignoter <HomeShell> (le bas de
    // page en skeleton une fraction de seconde avant le vrai contenu),
    // signalé le 2026-08-29 comme « écran flash de transition » au retour.
    if (snapshot.view === 'home' && !homeRenderedRef.current) {
      router.refresh()
    }
  }, [router])

  const navigateBack = useCallback(() => {
    if (navStack.current.length === 0) {
      setCurrentView('home')
      setSearchQuery('')
      window.scrollTo(0, 0)
      return
    }
    window.history.back()
  }, [])

  // Interception du bouton retour du navigateur (iPhone, Android, PWA).
  // Toutes les entrees (garde initiale + vues SPA) sont desormais creees via
  // router.push, donc on ne peut plus (et n'a plus besoin de) lire un
  // marqueur personnalise dans e.state — la pile en memoire (navStack) est
  // la seule source de verite sur ce qu'il reste a restaurer.
  useEffect(() => {
    const handlePopState = () => {
      if (navStack.current.length > 0) {
        restoreFromStack()
      } else {
        // Pile en mémoire vide NE VEUT PAS DIRE qu'on doit revenir à
        // l'accueil — ça arrive aussi quand ce montage n'a jamais construit
        // de snapshot pour l'URL courante (ex. fiche produit ouverte
        // directement, puis navigation ailleurs, puis retour arrière : la
        // pile React n'a jamais connu cet aller, seul l'historique
        // navigateur le sait). Avant ce fix, ce cas forçait TOUJOURS
        // l'accueil, quelle que soit l'URL réelle vers laquelle on vient de
        // reculer (?v=product&slug=X restait affiché dans la barre
        // d'adresse mais montrait l'accueil) — signalé le 2026-09-03
        // ("j'étais dans une boutique, retour vers l'accueil, retour vers
        // la boutique → accueil affiché"). On relit l'URL réelle
        // (window.location, pas le searchParams du hook qui peut ne pas
        // encore avoir resynchronisé) et on ne retombe sur l'accueil que
        // si elle ne cible vraiment rien de particulier.
        const params = new URLSearchParams(window.location.search)
        const v = params.get('v')
        const slug = params.get('slug')
        if ((v === 'product' || v === 'vendor') && slug) {
          // Laisse l'effet réactif à searchParams (plus haut, ~ligne 1247)
          // résoudre produit/boutique depuis ce slug — il gère déjà le cas
          // "pas encore en mémoire" via son propre fetch de secours. On ne
          // fait ici que NE PAS écraser la vue avec 'home'.
          return
        }
        setCurrentView('home')
        setSearchQuery('')
        window.scrollTo(0, 0)
        if (!homeRenderedRef.current) router.refresh()
      }
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [restoreFromStack, router])

  const handleProductClick = useCallback((p: WooProduct) => {
    trackEvent('product_view', { productId: p.id })
    mktViewContent({ id: p.id, name: p.name, price: Number(p.price) || undefined, currency: p.currency })
    if (currentView === 'product' && selectedProduct?.id !== p.id) {
      // produit → produit : on pousse manuellement dans la pile
      navStack.current.push({
        view: 'product',
        selectedProduct,
        selectedVendor,
        selectedCategory,
        activeCountry,
        homeTab,
        searchQuery,
        categoryFilters,
        scrollY: window.scrollY,
      })
      // Note : on n'utilise jamais le vrai chemin /product/[slug] ici car c'est
      // aussi une route Next.js existante (page SEO). router.push (et non
      // window.history.pushState) pour que Next App Router connaisse cette
      // entree d'historique, sinon le retour arriere recharge toute la page.
      router.push(p.slug ? `/?v=product&slug=${p.slug}` : (window.location.pathname + window.location.search), { scroll: false })
      setSelectedProduct(p)
      window.scrollTo(0, 0)
    } else {
      setSelectedProduct(p)
      navigateTo('product', true, p.slug ? `/?v=product&slug=${p.slug}` : undefined)
    }
  }, [navigateTo, currentView, selectedProduct, selectedVendor, selectedCategory, activeCountry, homeTab, searchQuery, categoryFilters, router])

  const handleVendorClick = useCallback((v: WooVendor) => {
    // Meme raison que handleProductClick : pas de vrai chemin /vendor/[slug] ici
    // (le composant reste "dans" l'app SPA — même header, panier synchronisé
    // instantanément — plutôt qu'une vraie navigation de page. /vendor/[slug]
    // existe bien séparément pour l'accès direct/SEO, cf. app/vendor/[slug]/
    // page.tsx, corrigé aussi le 2026-08-28 pour ne plus planter au-delà des
    // 100 premières boutiques).
    const vendorUrl = v.slug ? `/?v=vendor&slug=${v.slug}` : undefined
    if (currentView === 'store') {
      navStack.current.push({
        view: 'store',
        selectedProduct,
        selectedVendor,
        selectedCategory,
        activeCountry,
        homeTab,
        searchQuery,
        categoryFilters,
        scrollY: window.scrollY,
      })
      router.push(vendorUrl || (window.location.pathname + window.location.search), { scroll: false })
      setSelectedVendor(v)
      setVendorKey(k => k + 1)
      window.scrollTo(0, 0)
    } else {
      setSelectedVendor(v)
      setVendorKey(k => k + 1)
      navigateTo('store', true, vendorUrl)
    }
  }, [navigateTo, currentView, selectedProduct, selectedVendor, selectedCategory, activeCountry, homeTab, searchQuery, categoryFilters, router])

  // Ouvre une page catégorie DEPUIS un autre endroit (menu, bannière, "voir
  // tout"…) : on repart de filtres vierges. Le retour arrière vers une
  // catégorie déjà visitée passe lui par restoreFromStack, qui réinjecte
  // les filtres du snapshot — donc on ne reset PAS ici dans ce cas.
  const openCategory = useCallback((slug: string) => {
    setSelectedCategory(slug)
    setCategoryFilters(DEFAULT_CATEGORY_FILTERS)
    navigateTo('category')
  }, [navigateTo])

  // Onglets catégorie de la barre d'accueil (HomeCategoryTabs : "Explorer",
  // "Sacs", "Pagnes"…). On reste sur la vue 'home' — seul homeTab change —
  // mais on pousse quand même une VRAIE entrée d'historique + un snapshot
  // navStack, pour que le bouton retour du navigateur revienne à l'onglet
  // précédent (typiquement "Explorer") au lieu de sortir de l'accueil / du
  // site. Signalé le 2026-08-29. Pas de router.push d'URL nouvelle (l'onglet
  // n'a pas d'URL propre) : window.history.pushState suffit, l'entrée est
  // ré-associée à navStack au popstate comme les autres.
  const handleSelectHomeTab = useCallback((slug: string) => {
    if (slug === homeTab) return
    scrollPositions.current.set(currentView, window.scrollY)
    navStack.current.push({
      view: currentView,
      selectedProduct,
      selectedVendor,
      selectedCategory,
      activeCountry,
      homeTab,
      searchQuery,
      categoryFilters,
      scrollY: window.scrollY,
    })
    window.history.pushState({}, '', window.location.pathname + window.location.search)
    setHomeTab(slug)
    window.scrollTo(0, 0)
  }, [homeTab, currentView, selectedProduct, selectedVendor, selectedCategory, activeCountry, searchQuery, categoryFilters])

  // Même logique que handleProductClick/handleVendorClick : navigateTo met à
  // jour currentView de façon synchrone (sans attendre le router.push), donc
  // la vue pays s'affiche instantanément avec les données déjà en mémoire
  // (stores/allProducts). Extrait ici pour être exposé aussi bien à HomePage
  // (fallback client) qu'au bouton "Voir tout" streamé depuis le serveur via
  // StreamedNavClickContext — remplace un <Link href="/?v=country&code=...">
  // qui, lui, attendait le round-trip serveur avant d'afficher quoi que ce
  // soit (~2-3s sans prefetch, signalé le 2026-07-23).
  const handleViewAllCountry = useCallback((code: string) => {
    setSelectedCountryCode(code)
    const c = countries.find(x => x.code === code)
    if (c) { setActiveCountry(c); navigateTo('country') }
  }, [navigateTo])

  // Geste swipe-retour : RETIRÉ le 2026-08-29 (audit nav mobile).
  //
  // Ce handler custom (glisser depuis le bord gauche → navigateBack) faisait
  // DOUBLON avec le geste natif de retour d'iOS Safari / Chrome Android, qui
  // déclenche déjà un popstate — lui-même déjà intercepté plus haut
  // (handlePopState → restoreFromStack). Résultat sur mobile : un seul swipe
  // reculait de DEUX vues au lieu d'une, et un scroll vertical dont le doigt
  // dérapait horizontalement depuis le bord déclenchait un retour
  // involontaire. Le retour gestuel reste pleinement fonctionnel via le
  // geste natif + navStack ; plus besoin de le réimplémenter.

  // --- 2. FONCTIONS DE FETCH ---
  // sessionExpired=true : la déconnexion est déclenchée par un rejet serveur
  // (401/403), pas un clic volontaire sur "Déconnexion" — dans ce cas on
  // prévient explicitement et on renvoie vers la connexion immédiatement,
  // au lieu d'attendre que le client arrive au checkout pour le découvrir
  // (avant, seul CheckoutPage.tsx affichait ce message, uniquement à l'étape
  // de paiement — demandé le 2026-07-16 : ça doit être immédiat, partout).
  const handleLogout = useCallback((sessionExpired = false) => {
    localStorage.removeItem('miad_token')
    localStorage.removeItem('miad_user')
    localStorage.removeItem('miad_role')
    localStorage.removeItem('miad_cart')
    setIsLoggedIn(false)
    isRep.current = false
    setUserType('buyer')
    setUserName('')
    setCart([])
    if (sessionExpired) {
      // Le message doit rester visible un court instant avant la redirection
      // (signalé le 2026-07-16 : la redirection immédiate ne laissait pas le
      // temps de lire "session invalide" avant d'atterrir sur la connexion).
      toast.error('Session invalide. Veuillez vous reconnecter.')
      setTimeout(() => navigateTo('login'), 1500)
    } else {
      setCurrentView('home')
      setSearchQuery('')
    }
  }, [navigateTo])

  const fetcherWithAuth = async (url: string) => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('miad_token') : null
    const res = await fetch(url, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} })
    if (res.status === 401) { handleLogout(true); throw new Error("Session expirée"); }
    return res.json()
  }

  // Valide activement la session pendant que le client est sur l'accueil (ou
  // toute autre vue publique) sans faire d'appel authentifié — jusqu'ici rien
  // ne détectait un token expiré en dehors du dashboard/checkout, donc ça
  // passait inaperçu jusqu'à la prochaine action authentifiée (signalé le
  // 2026-07-16 : le modal/redirection doit apparaître même sur l'accueil).
  useSWR(
    isLoggedIn ? '/api/customer' : null,
    fetcherWithAuth,
    { revalidateOnFocus: true, revalidateOnMount: true, dedupingInterval: 120000, shouldRetryOnError: false }
  )

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false
      return
    }
    localStorage.setItem('miad_lang', language);
  }, [language])

  // Pas de toast ici volontairement : ces erreurs sont pour la plupart des accrocs
  // réseau transitoires (timeout WordPress, challenge anti-bot SiteGround) que SWR
  // retente déjà automatiquement en arrière-plan, et keepPreviousData garde l'écran
  // du client inchangé pendant ce temps — un toast rouge "erreur de chargement" à
  // chaque accroc n'apportait rien au client et l'inquiétait pour rien.
  const handleSWRFetchError = (err: any) => {
    console.error("SWR Fetch Error:", err);
    if (err.status === 401) {
      handleLogout(true);
    }
  };

  // LOGIQUE SCROLL INFINI (Amazon-style)
  const PRODUCTS_PER_PAGE = 100; // Augmenté pour un chargement initial plus complet
  // 'product'/'store' ont chacun leur propre fetch scopé (ProductDetail via
  // slug déjà résolu, VendorStorePage via /api/products?vendor=X) — allProducts
  // n'y sert que d'aperçu instantané optionnel (voir VendorStorePage.tsx).
  // Ne pas déclencher ici le fetch 100 produits + préchargement fond de 500
  // évite un appel réseau inutile constaté le 2026-07-11 : cliquer une carte
  // produit/boutique depuis une section streamée (navigation Link réelle,
  // donc remount de ce composant) relançait tout le catalogue pour rien.
  const needsCatalog = currentView !== 'product' && currentView !== 'store'
  const { data: infiniteProducts, size, setSize, isValidating: productsLoading, mutate: mutateProducts, error: productsError } = useSWRInfinite(
    (index, previousPageData) => {
      if (!needsCatalog) return null
      if (previousPageData && !previousPageData.products?.length && index > 0) return null // Fin de liste atteinte (index > 0 pour ne pas bloquer la première page)
      // Si une erreur s'est produite sur une page précédente, arrêtez de récupérer
      if (previousPageData && previousPageData.error) return null;
      // Pas de variations=true ici : ça forçait un appel WooCommerce par produit
      // variable (N+1) pour un lot de 100 produits, juste pour afficher des
      // cartes qui n'en ont pas besoin. ProductDetail et QuickSelectModal
      // récupèrent déjà leurs propres variations à la demande (?id=X&variations=true).
      // random+seed : mélange stable du flux (toutes boutiques confondues,
      // pas juste les dernières ajoutées) — même graine tant que l'onglet
      // reste ouvert, donc le même ordre après un retour arrière depuis une
      // fiche produit (voir homeShuffleSeed ci-dessus).
      const randomParam = homeShuffleSeed ? `&random=true&seed=${homeShuffleSeed}` : ''
      return `/api/products?page=${index + 1}&per_page=${PRODUCTS_PER_PAGE}&lang=${language}&userCountry=${selectedCountryCode}${randomParam}`
    },
    fetcherWithAuth,
    { ...swrOptions, fallbackData: initialProducts.length > 0 ? [{ products: initialProducts }] : undefined }
  )

  // Le filtrage par langue est déjà fait côté serveur (paramètre `lang=` de
  // /api/products) — le refiltrer ici était une "sécurité" qui se retournait
  // contre nous : `initialProducts` (SSR, utilisé comme fallbackData tant que
  // le vrai fetch n'a pas résolu) est toujours tagué lang:'fr' côté serveur,
  // donc un visiteur en 'en' voyait TOUS ses produits rejetés par ce filtre —
  // grille vide au chargement, avant même que la vraie requête `lang=en` ait
  // eu le temps de répondre. Sans ce filtre, l'utilisateur voit brièvement le
  // fallback (dans l'autre langue) plutôt qu'une grille vide.
  const allProducts = useMemo(() => {
    return infiniteProducts ? infiniteProducts.flatMap(page => page?.products || []) : initialProducts;
  }, [infiniteProducts, initialProducts])

  useEffect(() => {
    if (productsError) {
      handleSWRFetchError(productsError);
    }
  }, [productsError]);

  // Vérifie si on a atteint la fin des produits pour stopper les appels API inutiles
  const isReachingEnd = infiniteProducts && (infiniteProducts[infiniteProducts.length - 1]?.products?.length < PRODUCTS_PER_PAGE)

  // --- 1.2 LOGIQUE DE PRÉ-CHARGEMENT AUTOMATIQUE (Background Fill) ---
  // Une fois les 100 premiers chargés, l'app charge le reste du catalogue
  // (jusqu'à 500 produits / 5 pages) en arrière-plan, pour que les sections
  // "Marché [Pays]" aient toutes leurs produits sans attendre un scroll.
  //
  // Avant : un palier à la fois (setSize(size+1)) suivi d'une attente de 3s
  // avant le palier suivant — chaque palier attendant que le précédent soit
  // revenu, ça enchaînait 4 cycles fetch+3s d'attente ARTIFICIELLE (~12-15s
  // rien qu'en pauses), et chaque section "Marché [Pays]" n'apparaissait
  // (avec son propre skeleton) qu'au palier où son premier produit arrivait
  // enfin. D'où l'impression de sections qui se chargent "une par une".
  // useSWRInfinite reste intrinsèquement séquentiel ici (getKey dépend de
  // previousPageData pour détecter la fin du catalogue), mais un saut direct
  // à size=5 après un seul court délai enchaîne les pages 2 à 5 dès que
  // chacune répond — sans les pauses de 3s entre chaque — donc tout le
  // catalogue arrive en ~1-2s au lieu de s'étaler sur 12-15s.
  useEffect(() => {
    if (productsLoading || isReachingEnd || size !== 1) return;
    if (infiniteProducts && infiniteProducts.length === size) {
      const backgroundTimer = setTimeout(() => {
        setSize(5);
      }, 1000); // Court délai pour ne pas concurrencer le chargement initial critique
      return () => clearTimeout(backgroundTimer);
    }
  }, [infiniteProducts, productsLoading, size, setSize, isReachingEnd]);

  const { data: categoriesData, isLoading: categoriesLoading, error: categoriesError } = useSWR(`/api/categories?lang=${language}`, fetcherWithAuth, {
    ...swrOptions,
    fallbackData: { categories: initialCategories }
  })
  useEffect(() => { if (categoriesError) handleSWRFetchError(categoriesError); }, [categoriesError]);

  const { data: storesData, error: storesError, mutate: mutateStores } = useSWR('/api/stores?per_page=100', publicFetcher, {
    ...swrOptions,
    fallbackData: { stores: initialStores }
  })
  useEffect(() => { if (storesError) handleSWRFetchError(storesError); }, [storesError]);

  // Synchronisation : on rafraîchit les boutiques quand le catalogue de produits s'agrandit
  useEffect(() => {
    if (size > 1) {
      mutateStores();
    }
  }, [size, mutateStores]);

  // Dokan retourne toujours productCount=0 — on le recalcule depuis le catalogue déjà chargé
  const stores: WooVendor[] = useMemo(() => {
    const raw: WooVendor[] = storesData?.stores || []
    if (!allProducts.length) return raw
    const countById: Record<string, number> = {}
    allProducts.forEach(p => {
      const vid = p.vendor?.id?.toString()
      if (vid) countById[vid] = (countById[vid] || 0) + 1
    })
    return raw.map(s => ({
      ...s,
      productCount: countById[s.id?.toString() || ''] ?? s.productCount,
    }))
  }, [storesData, allProducts])

  // Réactivité URL pour les navigations qui ne passent PAS par
  // handleProductClick/handleVendorClick/onViewAllCountry — typiquement un
  // <Link href="/?v=product&slug=X"> (ou v=vendor/v=country) rendu par une
  // section Server Component streamée (qui n'a pas accès à ces callbacks,
  // function props impossibles à passer d'un client vers un descendant
  // serveur). Les callbacks existants mettent déjà selectedProduct/
  // selectedVendor/activeCountry à jour de façon synchrone avant même que
  // l'URL ne change, donc cet effet est un no-op pour ces chemins existants
  // (vérification "déjà à jour" ci-dessous). currentView n'est mis à jour que
  // dans le MÊME batch que la sélection correspondante — jamais l'un sans
  // l'autre — pour ne pas déclencher le garde-fou anti-skeleton infini plus
  // bas (~ligne 752).
  useEffect(() => {
    const v = searchParams.get('v')
    const slug = searchParams.get('slug')
    const code = searchParams.get('code')

    // Relâcher la garde anti-refetch dès que l'URL ne cible plus CE slug
    // précis (retour accueil, autre produit, autre boutique) : sinon un
    // slug dont le fetch de secours a échoué une fois resterait bloqué (la
    // ref n'est pas relâchée sur échec pour éviter une boucle immédiate) et
    // un nouveau clic sur le même lien n'afficherait plus qu'un skeleton.
    const currentTarget = (v === 'product' || v === 'vendor') && slug ? `${v}:${slug}` : ''
    if (urlFetchInFlightRef.current && urlFetchInFlightRef.current !== currentTarget) {
      urlFetchInFlightRef.current = ''
    }

    if (v === 'country' && code) {
      // Le garde-fou ne doit sauter que si on affiche déjà cette vue pays —
      // pas seulement si activeCountry a la bonne valeur en mémoire (qui
      // reste posée même après être reparti vers l'accueil), sinon un
      // second clic sur "Voir tout" pour le même pays ne faisait plus rien
      // du tout (bug remonté le 2026-07-23).
      if (activeCountry?.code === code && currentView === 'country') return
      const found = countries.find(c => c.code === code)
      if (found) {
        setSelectedCountryCode(code)
        setActiveCountry(found)
        setCurrentView('country')
        window.scrollTo(0, 0)
      }
      return
    }

    if (!v || !slug) return

    if (v === 'product') {
      if (selectedProduct?.slug === slug) { urlFetchInFlightRef.current = ''; return }
      const found = allProducts.find(p => p.slug === slug)
      if (found) {
        urlFetchInFlightRef.current = ''
        setSelectedProduct(found)
        setCurrentView('product')
        window.scrollTo(0, 0)
        return
      }
      // Slug pas encore dans le lot chargé côté client → fetch de secours.
      // On ne vide PAS selectedProduct de façon synchrone (cet effet a
      // selectedProduct dans ses deps : le re-render relancerait l'effet et
      // son cleanup avorterait ce fetch → skeleton infini). L'ancienne
      // fiche reste affichée le temps du fetch, puis :
      //  - produit trouvé → on l'affiche
      //  - slug inconnu / API en erreur → on remet selectedProduct à null
      //    ET on bascule productFetchSettled : le garde-fou anti-skeleton
      //    (plus bas, deps incluant productFetchSettled) fait alors le
      //    retour propre à l'accueil, au lieu de laisser la fiche figée sur
      //    le mauvais produit ou un skeleton infini après rafraîchissement
      //    (signalé le 2026-09-02 : "on change de page produit, ça reste
      //    bloqué, aucun produit").
      // urlFetchInFlightRef : ne pas relancer le même fetch si l'effet
      // re-tourne (changement d'une autre dep) pendant qu'il est en vol.
      // Une seule tentative par slug : la ref n'est relâchée qu'au succès
      // (l'effet re-tourne alors avec selectedProduct.slug === slug et
      // sort). Sur échec on fait le retour accueil AVEC nettoyage d'URL
      // (router.replace('/')) — sans ça, ?v=product&slug=X resterait dans
      // l'URL et cet effet retenterait le fetch à chaque re-render (boucle).
      if (urlFetchInFlightRef.current === `product:${slug}`) return
      urlFetchInFlightRef.current = `product:${slug}`
      pendingProductFetch.current = true
      // lang=${language} : sans ça flash FR/EN sur la fiche (bug 2026-09-01).
      fetch(`/api/products?slug=${encodeURIComponent(slug)}&lang=${language}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (searchParams.get('slug') !== slug) return // URL déjà changée
          const p = data?.products?.[0]
          if (p) {
            urlFetchInFlightRef.current = ''
            setSelectedProduct(p); setCurrentView('product'); window.scrollTo(0, 0)
          } else {
            setSelectedProduct(null); setSearchQuery(''); setCurrentView('home')
            router.replace('/', { scroll: false })
          }
        })
        .catch(() => {
          if (searchParams.get('slug') !== slug) return
          setSelectedProduct(null); setSearchQuery(''); setCurrentView('home')
          router.replace('/', { scroll: false })
        })
        .finally(() => {
          pendingProductFetch.current = false
          setProductFetchSettled(s => !s)
        })
      return
    }

    if (v === 'vendor') {
      if (selectedVendor?.slug === slug || selectedVendor?.id === slug) { urlFetchInFlightRef.current = ''; return }
      const found = stores.find(s => s.slug === slug || s.id === slug)
      if (found) {
        urlFetchInFlightRef.current = ''
        setSelectedVendor(found)
        setVendorKey(k => k + 1)
        setCurrentView('store')
        window.scrollTo(0, 0)
        return
      }
      // Même robustesse que v=product (voir commentaire ci-dessus) : fetch
      // de secours sans vider selectedVendor de façon synchrone ; sur
      // échec, selectedVendor repasse à null + bascule vendorFetchSettled
      // pour que le garde-fou anti-skeleton renvoie à l'accueil au lieu de
      // figer l'ancienne boutique. Avant le correctif d'origine
      // (2026-08-28) le lien restait silencieusement sur l'accueil ; ici on
      // ajoute la sortie propre quand la boutique n'existe pas.
      if (urlFetchInFlightRef.current === `vendor:${slug}`) return
      urlFetchInFlightRef.current = `vendor:${slug}`
      pendingVendorFetch.current = true
      fetch(`/api/stores?slug=${encodeURIComponent(slug)}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (searchParams.get('slug') !== slug) return
          const s = data?.stores?.[0]
          if (s) {
            urlFetchInFlightRef.current = ''
            setSelectedVendor(s); setVendorKey(k => k + 1); setCurrentView('store'); window.scrollTo(0, 0)
          } else {
            setSelectedVendor(null); setSearchQuery(''); setCurrentView('home')
            router.replace('/', { scroll: false })
          }
        })
        .catch(() => {
          if (searchParams.get('slug') !== slug) return
          setSelectedVendor(null); setSearchQuery(''); setCurrentView('home')
          router.replace('/', { scroll: false })
        })
        .finally(() => {
          pendingVendorFetch.current = false
          setVendorFetchSettled(s => !s)
        })
      return
    }
  }, [searchParams, allProducts, stores, selectedProduct, selectedVendor, activeCountry, currentView, language, router])

  // Récupération des résultats de recherche via l'API
  const { data: searchResultsData, isLoading: searchLoading } = useSWR(
    currentView === 'search' && searchQuery ? `/api/products?search=${searchQuery}&lang=${language}` : null,
    publicFetcher,
    { ...swrOptions }
  )

  const categories = useMemo(() => {
    return categoriesData?.categories || []
  }, [categoriesData])

  // /api/categories renvoie tout WooCommerce à plat (racines + sous-catégories
  // + anciennes catégories orphelines qui ont encore un produit ou deux) —
  // utilisable pour un vrai navigateur de catalogue (CategoriesListPage), mais
  // pas pour une nav rapide : le hamburger et les bandes "Catégories" montraient
  // des doublons/anciennes catégories (ex: "Accessoires" à côté de "Bijoux -
  // Accessoires") en plus des 8 catégories officielles, ce qui menait sur une
  // page catégorie vide ou inattendue au clic (signalé le 2026-07-30).
  const rootCategories = useMemo(() => {
    return categories.filter((c: WooCategory) => c.isRoot)
  }, [categories])

  // Anti-skeleton infini : si on est sur category/store mais que les données manquent → retour accueil
  // Placé ici car nécessite categoriesLoading et categories (déclarés au-dessus)
  // setSearchQuery('') ajouté aux 3 branches (27/08) : c'est le chemin le
  // plus probable du bug "l'accueil normal ne revient plus" — rechercher un
  // produit, l'ouvrir, puis revenir déclenche fréquemment l'une de ces
  // gardes, et sans ce nettoyage searchQuery restait rempli indéfiniment,
  // bloquant `filterActive` à true (voir renderMainContent, case 'home').
  useEffect(() => {
    if (currentView === 'category' && !categoriesLoading && categories.length > 0 && selectedCategory) {
      const found = categories.find((c: WooCategory) => c.slug === selectedCategory)
      if (!found) {
        setSelectedCategory(null)
        setCurrentView('home')
        setSearchQuery('')
      }
    }
    if (currentView === 'store' && !selectedVendor && !pendingVendorFetch.current) {
      setCurrentView('home')
      setSearchQuery('')
    }
    if (currentView === 'product' && !selectedProduct && !pendingProductFetch.current) {
      setCurrentView('home')
      setSearchQuery('')
    }
  }, [currentView, categoriesLoading, categories, selectedCategory, selectedVendor, selectedProduct, productFetchSettled, vendorFetchSettled])

  // Groupement par code pays pour l'accueil (Amazon-style sessions)
  const productsByCountry = useMemo(() => {
    const grouped: Record<string, WooProduct[]> = {}
    allProducts.filter(Boolean).forEach((p: WooProduct) => {
      const code = p.countryCode?.toLowerCase() || 'sn'
      if (!grouped[code]) grouped[code] = []
      grouped[code].push(p)
    })
    return grouped
  }, [allProducts])

  const storesByCountry = useMemo(() => {
    const grouped: Record<string, WooVendor[]> = {}
    stores.filter(Boolean).forEach((s: WooVendor) => {
      const code = s.countryCode?.toLowerCase() || 'sn'
      if (!grouped[code]) grouped[code] = []
      grouped[code].push(s)
    })
    return grouped
  }, [stores])
  
  // Amazon-style : Déclenchement automatique du scroll infini
  useEffect(() => {
    if (!['home', 'category', 'country', 'search'].includes(currentView)) return;

    const handleScroll = () => {
      const isNearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 400
      if (isNearBottom && !productsLoading && !isReachingEnd) {
        setSize(s => s + 1)
      }
    }
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [productsLoading, setSize, currentView, isReachingEnd])

  // HYDRATION DE LA SESSION : Vérifie si on est déjà connecté au démarrage
  useEffect(() => {
    const token = localStorage.getItem('miad_token');
    const savedUser = localStorage.getItem('miad_user');
    const savedRole = localStorage.getItem('miad_role'); // On va stocker le rôle explicitement

    if (token && savedUser) {
      try {
        const user = JSON.parse(savedUser)
        
        // Sécurité : si le token existe mais que l'email est manquant, on nettoie
        if (!user.email && !user.user_email) {
          handleLogout()
          return
        }

        if (user) {
          setIsLoggedIn(true);
          setUserName(user.display_name || user.first_name || user.name || 'Utilisateur');
          if (savedRole === 'representant') {
            isRep.current = true;
          }

          if (savedRole === 'vendor' || savedRole === 'seller') {
            setUserType('vendor');
          } else {
            setUserType('buyer');
          }
        }
      } catch (e) {
        console.error("Erreur session", e);
      }
    }
  }, [handleLogout]);

  // Registration du Service Worker — activation forcée pour que la nouvelle version
  // prenne le contrôle immédiatement sans que l'utilisateur ait à vider son cache
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then(registration => {
        // Vérifier immédiatement s'il y a une mise à jour disponible
        registration.update();

        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            // Dès que le nouveau SW est installé, lui demander de prendre le contrôle
            if (newWorker.state === 'installed') {
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      }).catch(err => console.error("Worker failed", err));

      // Quand le SW change (nouveau SW actif), recharger une fois silencieusement
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) { refreshing = true; window.location.reload(); }
      });
    }

    // WebSocket : Uniquement si l'URL est configurée pour éviter l'erreur 404/fail
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
    if (wsUrl && wsUrl.startsWith('wss://')) {
      const socket = new WebSocket(wsUrl); 
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'PRODUCT_UPDATE') {
          mutateProducts();
        }
      };
      socket.onerror = () => console.warn("WebSocket MIAD : Mode dégradé (polling)");
      return () => socket.close();
    }
  }, [language, mutateProducts])

  // Navigation intelligente pour la recherche.
  //
  // Bug trouve le 2026-08-21 : setCurrentView('search') en direct court-
  // circuitait navigateTo() — aucune entree d'historique navigateur ni de
  // pile interne n'etait creee pour la recherche (seul endroit du fichier a
  // le faire). Consequence : "retour arriere" juste apres une recherche
  // (sans meme cliquer un produit) ne ramenait pas a la page precedente,
  // mais forcait l'accueil (pile vide -> repli de handlePopState). Fixe en
  // passant par navigateTo() comme toute autre transition de vue, qui pousse
  // a la fois router.push() et le snapshot navStack necessaires au retour
  // arriere. On ne re-navigue que lors de l'ENTREE dans la recherche —
  // affiner la requete en restant sur la vue recherche ne doit pas empiler
  // une entree d'historique par frappe.
  const handleSearch = (query: string) => {
    if (query.trim()) { trackEvent('search', { searchQuery: query.trim() }); mktSearch(query.trim()) }
    setSearchQuery(query)
    if (currentView !== 'search') navigateTo('search')
  }

  const handleCountryClick = useCallback((code: string) => {
    setSelectedCountryCode(code)
    const c = countries.find(x => x.code === code)
    if (c) {
      setActiveCountry(c)
      navigateTo('country')
    }
  }, [navigateTo])

  // Expérience Premium : Intercepter le clic "Acheter" pour choisir les options
  const handleQuickAdd = (product: WooProduct) => {
    if (product.type === 'variable') {
      setQuickProduct(product);
    } else {
      addToCart(product, 1);
    }
  }

  const handleConfirmQuickAdd = (product: WooProduct, qty: number, variation?: WooProductVariation) => {
    addToCart(product, qty, variation)
    setQuickProduct(null)
  }

  const showCartToast = (product: WooProduct) => {
    toast.success(`${product.name} ajouté au panier`, {
      action: {
        label: 'Voir Panier',
        onClick: () => navigateTo('cart')
      },
      duration: 3000,
      position: 'bottom-right',
    })
  }

  const addToCart = (product: WooProduct, quantity = 1, variation?: WooProductVariation) => {
    trackEvent('add_to_cart', {
      productId: product.id,
      metadata: {
        added: { id: product.id, name: product.name, qty: quantity },
        cart: cart.map(i => ({ id: i.product.id, name: i.product.name, qty: i.quantity, price: i.product.price })),
      },
    })
    mktAddToCart({
      id: product.id, name: product.name,
      price: Number(variation?.price || product.price) || 0, qty: quantity,
      currency: product.currency,
    })
    setCart(prev => {
      const cartKey = variation ? `${product.id}-${variation.id}` : String(product.id)
      const existing = prev.find(i => (i.variation ? `${i.product.id}-${i.variation.id}` : String(i.product.id)) === cartKey)
      return existing
        ? prev.map(i => (i.variation ? `${i.product.id}-${i.variation.id}` : String(i.product.id)) === cartKey ? { ...i, quantity: i.quantity + quantity } : i)
        : [...prev, { product, quantity, variation }]
    })
    if (currentView !== 'product') showCartToast(product)
  }

  const updateCartQuantity = (productId: string, quantity: number) => {
    setCart(prev => quantity <= 0 ? prev.filter(i => i.product.id !== productId) : prev.map(i => i.product.id === productId ? { ...i, quantity } : i))
  }

  // "Reprendre le paiement" d'une commande non payée (ClientOrderDetail) :
  // recharge ses produits dans le panier puis va au checkout, où le client
  // rechoisit son moyen de paiement (carte / Mobile Money PayDunya).
  // Les line_items d'une commande ne portent qu'un product_id + nom + prix,
  // pas un WooProduct complet — on refetch chaque produit par id pour que
  // CheckoutPage ait tout ce qu'il lui faut (vendor, type, currency…).
  const handleReorder = useCallback(async (items: Array<{ productId: number; quantity: number }>) => {
    const fetched = await Promise.all(
      items.map(async ({ productId, quantity }) => {
        try {
          const r = await fetch(`/api/products?id=${productId}&lang=${language}`)
          if (!r.ok) return null
          const d = await r.json()
          const p: WooProduct | undefined = d?.products?.[0]
          return p ? { product: p, quantity } : null
        } catch { return null }
      })
    )
    const valid = fetched.filter((x): x is { product: WooProduct; quantity: number } => x !== null)
    if (valid.length === 0) {
      toast.error("Impossible de recharger cette commande pour l'instant.")
      return
    }
    setCart(valid)
    navigateTo('checkout')
  }, [language, navigateTo])

  const removeFromCart = (productId: string) => {
    const removed = cart.find(i => i.product.id === productId)
    trackEvent('remove_from_cart', {
      productId,
      metadata: {
        removed: removed ? { id: removed.product.id, name: removed.product.name, qty: removed.quantity } : undefined,
        cart: cart.filter(i => i.product.id !== productId).map(i => ({ id: i.product.id, name: i.product.name, qty: i.quantity, price: i.product.price })),
      },
    })
    setCart(prev => prev.filter(i => i.product.id !== productId))
  }
  const cartCount = cart.reduce((sum, i) => sum + i.quantity, 0)

  // Génère un lien vers le panier courant (stocké côté serveur) pour que le
  // client puisse le reprendre sur un autre appareil/navigateur.
  const handleShareCart = async () => {
    try {
      const slimCart = cart.map(item => ({ ...item, product: toCartProduct(item.product) }))
      const res = await fetch('/api/cart-share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: slimCart }),
      })
      if (!res.ok) throw new Error('cart-share failed')
      const { id } = await res.json()
      const url = `${window.location.origin}/?cart=${id}`
      await shareMiadContent('Mon panier MIAD Market', 'Retrouvez mon panier ici', url)
    } catch {
      toast.error("Impossible de générer le lien pour l'instant")
    }
  }

  const handleLoginSuccess = (type: 'buyer' | 'vendor', user?: any) => {
    setIsLoggedIn(true)
    setUserType(type)
    if (user) {
      setUserName(user.user_display_name || user.display_name || user.first_name || user.name || 'Utilisateur');
    }

    // Si c'est un représentant, on l'envoie directement vers son espace dédié
    const role = localStorage.getItem('miad_role')
    if (role === 'representant') {
      isRep.current = true
      window.location.href = '/espace-representant'
      return
    }

    // Retourner exactement là où l'utilisateur était avant le login
    const returnView = (sessionStorage.getItem('miad_login_return') as View | null) || prevView.current
    sessionStorage.removeItem('miad_login_return')

    const noReturnViews: View[] = ['login', 'vendorDashboard', 'clientDashboard']
    const destination: View = (returnView && !noReturnViews.includes(returnView))
      ? returnView
      : (type === 'vendor' ? 'vendorDashboard' : 'clientDashboard')

    navigateTo(destination)
    prevView.current = null
  }

  const handleDashboardSectionClick = (section: string) => {
    if (!isLoggedIn) { prevView.current = currentView; navigateTo('login'); return }
    setPendingDashboardSection(section)
    navigateTo(userType === 'vendor' ? 'vendorDashboard' : 'clientDashboard')
  }

  // Bascule FR/EN : contrairement au reste de l'app (fetch client, se
  // réajuste tout seul), l'accueil streamé par défaut (homeSections, cf.
  // page.tsx) est rendu une seule fois côté serveur en français — sans
  // navigation, il restait figé dans l'ancienne langue jusqu'au prochain
  // rechargement complet (bug signalé le 2026-07-27). Un router.push vers
  // /?lang=X redéclenche le rendu serveur de homeSections dans la bonne
  // langue (soft navigation Next.js — MiadMarketClient n'est pas démonté,
  // seul homeSections change), donc uniquement utile/déclenché quand on est
  // effectivement sur l'accueil libre (sans filtre catégorie/recherche).
  const handleLanguageChange = useCallback((lang: 'fr' | 'en') => {
    setLanguage(lang)
    if (currentView === 'home' && !selectedCategory && !searchQuery) {
      router.push(`/?lang=${lang}`, { scroll: false })
    }
  }, [currentView, selectedCategory, searchQuery, router])

  const headerProps = {
    cartCount,
    selectedCountry: undefined,
    isLoggedIn,
    userType,
    categories: rootCategories,
    isLoadingCategories: categoriesLoading,
    language,
    onLanguageChange: handleLanguageChange,
    onCartClick: () => { navigateTo('cart'); setIsSidebarOpen(false); },
    // setSearchQuery('') manquait ici : une recherche active empêchait
    // `filterActive` (voir renderMainContent, case 'home') de redevenir
    // false même après un retour à l'accueil, donc homeSections restait
    // ignoré au profit du fallback HomePage — qui masque les produits en
    // navigation libre. C'est le "l'accueil normal ne revient plus" signalé
    // le 27/08 : reproductible dès qu'une recherche précédait le clic sur
    // le logo/icône Accueil.
    onHomeClick: () => { setSelectedCategory(null); setSearchQuery(''); navigateTo('home', true, '/'); },
    onCategoryClick: (slug: string) => { openCategory(slug) },
    onCountryClick: undefined,
    onSearch: handleSearch,
    searchQuery,
    onLoginClick: () => { prevView.current = currentView; navigateTo('login'); },
    onHelpClick: (topic?: string) => {
      setActiveHelpTopic(topic);
      navigateTo('help');
    },
    unreadMessages: 0,
    onDashboardClick: () => {
      if (!isLoggedIn) { prevView.current = currentView; navigateTo('login'); }
      else if (isRep.current) { window.location.href = '/espace-representant'; }
      else { setPendingDashboardSection(undefined); navigateTo(userType === 'vendor' ? 'vendorDashboard' : 'clientDashboard'); }
    },
    onDashboardSectionClick: handleDashboardSectionClick,
    isProductView: currentView === 'product',
  }


  // --- RENDER MANAGER (Centralisation pour éviter les 404 et disparitions d'UI) ---
  const renderMainContent = () => {
    switch (currentView) {
      case 'home': {
        // Sections streamées côté serveur (HomeSections, cf. page.tsx) : ne
        // remplacent HomePage que dans l'état "par défaut" — aucun filtre
        // catégorie/recherche actif (filterProducts() de HomePage.tsx doit
        // continuer de s'appliquer en direct dès qu'un filtre est choisi, ce
        // qu'un Server Component ne peut pas faire sans aller-retour réseau
        // à chaque frappe). Pas de condition sur `language` ici : homeSections
        // est déjà rendu dans la bonne langue par le serveur (voir page.tsx,
        // HomeSections lang=), et handleLanguageChange pousse `/?lang=en`
        // précisément pour ça — un `language === 'fr'` codé en dur ici
        // rejetait quand même ce contenu anglais déjà prêt, et retombait sur
        // HomePage (fallback) qui, lui, masque les sections produits en
        // navigation libre (déplacées vers /promotions) → accueil anglais
        // sans aucun produit visible, sur mobile comme sur desktop (signalé
        // le 2026-07-30, capture d'écran à l'appui).
        const filterActive = Boolean(selectedCategory) || Boolean(searchQuery)
        if (!filterActive && homeSections) {
          const t = translations[language]
          return (
            <main className="bg-muted/20 min-h-screen">
              <HomeCategoryTabs activeTab={homeTab} onSelectTab={handleSelectHomeTab} language={language} />
              {homeTab === 'explore' ? (
                <>
                  <TopVendorsStrip stores={stores} onStoreClick={(v: WooVendor) => { handleVendorClick(v) }} />
                  <HeroSection onExplore={() => document.getElementById('categories-section')?.scrollIntoView({ behavior: 'smooth' })} />
                  <CategoriesSection
                    categories={rootCategories}
                    selectedCategory={selectedCategory}
                    onSelectCategory={(slug: string | null) => { if (slug) openCategory(slug); else setSelectedCategory(null) }}
                  />
                  {homeSections}
                  <VendorCTA onBecomeVendor={() => navigateTo('login')} t={t} />
                </>
              ) : (
                <HomeCategoryTabSection
                  categorySlug={homeTab}
                  allProducts={allProducts}
                  userCountry={selectedCountryCode}
                  onProductClick={(p: WooProduct) => { handleProductClick(p) }}
                  onAddToCart={handleQuickAdd}
                  language={language}
                />
              )}
            </main>
          );
        }
        return (
          <HomePage
            language={language} selectedCountry={selectedCountryCode} selectedCategory={selectedCategory} searchQuery={searchQuery}
            onCountryChange={(code: string) => setSelectedCountryCode(code)}
            onCategoryChange={(slug: string | null) => { if (slug) openCategory(slug); else setSelectedCategory(null) }}
            onNavigate={(v: View) => { navigateTo(v); }}
            onProductClick={(p: WooProduct) => { handleProductClick(p) }}
            onAddToCart={handleQuickAdd}
            onStoreClick={(v: WooVendor) => { handleVendorClick(v) }}
            onViewAllCountry={handleViewAllCountry}
            categories={rootCategories}
            onBecomeVendor={() => navigateTo('login')}
            productsByCountry={productsByCountry}
            storesByCountry={storesByCountry}
          />
        );
      }
      
      case 'product':
        if (!selectedProduct) return <PageSkeleton />;
        return (
          <ProductDetail
            product={selectedProduct}
            onBack={navigateBack}
            allProducts={allProducts}
            onStoreClick={(v) => { handleVendorClick(v) }}
            onAddToCart={(p, qty, v) => addToCart(p, qty, v)}
            onBuyNow={(p, qty, v) => {
              addToCart(p, qty, v);
              if (!isLoggedIn) { navigateTo('login', true, undefined, 'checkout'); }
              else navigateTo('checkout');
            }}
            onCartClick={() => navigateTo('cart')}
            onProductClick={(p) => { handleProductClick(p) }}
            userCountry={selectedCountryCode}
            cartCount={cartCount}
            shippingRates={shippingRates}
          />
        );

      case 'login':
        return <LoginPage onBack={navigateBack} onLoginSuccess={handleLoginSuccess} />;

      case 'store':
        if (!selectedVendor) return <PageSkeleton />;
        return (
          <VendorStorePage
            key={vendorKey}
            vendor={selectedVendor}
            allProducts={allProducts}
            language={language}
            onBack={navigateBack}
            onProductClick={p => { handleProductClick(p) }}
            onAddToCart={handleQuickAdd}
          />
        );

      case 'category':
        if (!selectedCategory) return <PageSkeleton />;
        const categoryObj = categories.find((c: WooCategory) => c.slug === selectedCategory);
        // Skeleton uniquement pendant le chargement — si catégories chargées et slug introuvable,
        // le useEffect redirige vers home (évite le skeleton infini)
        if (!categoryObj) return <PageSkeleton />;
        return (
          <CategoryPage
            category={categoryObj}
            language={language}
            onBack={navigateBack}
            products={allProducts}
            filters={categoryFilters}
            onFiltersChange={setCategoryFilters}
            onProductClick={(p: WooProduct) => { handleProductClick(p) }}
            onAddToCart={handleQuickAdd}
          />
        );

      case 'cart':
        return (
          <CartPage
            cart={cart} onUpdateQuantity={updateCartQuantity} onRemoveItem={removeFromCart}
            onContinueShopping={() => navigateTo('home', true, '/')}
            onCheckout={() => {
              if (!isLoggedIn) { navigateTo('login', true, undefined, 'checkout'); }
              else navigateTo('checkout');
            }}
            onShareCart={handleShareCart}
            shippingRates={shippingRates}
            userCountry={selectedCountryCode}
          />
        );

      case 'orderHistory':
        return (
          <OrderHistory
            onBack={navigateBack}
            onContinueShopping={() => navigateTo('home', true, '/')}
          />
        );

      case 'checkout':
        return (
          <CheckoutPage
            language={language}
            cart={cart} onBack={navigateBack}
            onOrderComplete={() => {
              trackEvent('checkout_complete')
              setCart([])
              setStripeConfirmedOrderId(null)
              setPendingDashboardSection('orders')
              navStack.current = []
              navigateTo('clientDashboard')
            }}
            shippingRates={shippingRates}
            userCountryCode={selectedCountryCode}
            stripeConfirmedOrderId={stripeConfirmedOrderId ?? undefined}
            onSessionExpired={() => handleLogout(true)}
          />
        );

      case 'country':
        if (!activeCountry) return null;
        return (
          <CountryPage
            country={activeCountry}
            vendors={stores.filter(v => v.countryCode?.toLowerCase() === activeCountry.code.toLowerCase())}
            categories={rootCategories}
            products={allProducts.filter(p => p.countryCode?.toLowerCase() === activeCountry.code.toLowerCase())}
            onBack={navigateBack}
            onStoreClick={(v: WooVendor) => { handleVendorClick(v) }}
            onProductClick={(p: WooProduct) => { handleProductClick(p) }}
            onAddToCart={handleQuickAdd}
            onCategoryClick={(slug: string) => { openCategory(slug) }}
          />
        );

      case 'clientDashboard':
        return <ClientDashboard onBack={navigateBack} onLogout={handleLogout} onSessionExpired={() => handleLogout(true)} language={language} onLanguageChange={handleLanguageChange} initialSection={pendingDashboardSection as any} />;

      case 'vendorDashboard': {
        // Réservé aux vendeurs connectés uniquement
        if (!isLoggedIn) { navigateTo('login'); return null; }
        if (userType !== 'vendor') { navigateTo('clientDashboard'); return null; }
        const storedUser = typeof window !== 'undefined' ? JSON.parse(localStorage.getItem('miad_user') || '{}') : null;
        return <Dashboard
          onBack={navigateBack}
          onLogout={handleLogout}
          onSessionExpired={() => handleLogout(true)}
          storeName={userName || "Ma Boutique"}
          vendorId={storedUser?.id}
          initialSection={pendingDashboardSection as any}
        />;
      }

      case 'storesList':
        return <StoresListPage stores={stores} isLoading={!storesData} onBack={navigateBack} onStoreClick={(v: WooVendor) => { handleVendorClick(v) }} />;

      case 'categoriesList':
        return (
          <CategoriesListPage
            categories={categories}
            allProducts={allProducts}
            language={language}
            onBack={navigateBack}
            onProductClick={(p: WooProduct) => { handleProductClick(p) }}
            onAddToCart={handleQuickAdd}
            onCategoryClick={(slug: string) => { openCategory(slug) }}
          />
        );

      case 'help':
        return <HelpCenter activeTopic={activeHelpTopic} onBack={navigateBack} onTopicClick={setActiveHelpTopic} onOpenChat={() => {}} />;


      case 'search': {
        const rawSearchResults = searchResultsData?.products || [];
        const searchResults = filterAndSortProducts(rawSearchResults, {
          selectedCountries: searchSelectedCountries,
          priceRange: searchPriceRange,
          minRating: searchMinRating,
          sortBy: searchSortBy,
        });
        const t = translations[language];
        return (
          <main className="min-h-screen bg-muted/20 pb-20">
            <div className="container mx-auto px-4 py-10">
              <div className="flex items-center justify-between gap-4 mb-8">
                <div className="flex items-center gap-4">
                  <button type="button" onClick={navigateBack} aria-label="Retour" className="p-2 hover:bg-muted rounded-full transition-colors"><ArrowLeft size={24} /></button>
                  <div>
                    <h1 className="text-2xl font-black uppercase tracking-tighter italic">{t.searchResultsFor} &ldquo;{searchQuery}&rdquo;</h1>
                    <p className="text-sm text-muted-foreground font-bold">{searchResults.length} {t.itemsFound}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Select value={searchSortBy} onValueChange={setSearchSortBy}>
                    <SelectTrigger className="w-[180px] bg-card h-12 rounded-2xl border-border font-bold">
                      <SelectValue placeholder="Trier" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="newest">Nouveautés</SelectItem>
                      <SelectItem value="price-asc">Prix croissant</SelectItem>
                      <SelectItem value="price-desc">Prix décroissant</SelectItem>
                      <SelectItem value="rating-desc">Meilleures notes</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="icon"
                    className="lg:hidden h-12 w-12 rounded-2xl border-border"
                    onClick={() => setIsSearchFilterMobileOpen(true)}
                  >
                    <SlidersHorizontal size={20} />
                  </Button>
                </div>
              </div>

              <div className="flex flex-col lg:flex-row gap-12">
                <aside className="hidden lg:block w-72 shrink-0">
                  <div className="sticky top-24">
                    <ProductFilterSidebar
                      selectedCountries={searchSelectedCountries}
                      onSelectedCountriesChange={setSearchSelectedCountries}
                      priceRange={searchPriceRange}
                      onPriceRangeChange={setSearchPriceRange}
                      minRating={searchMinRating}
                      onMinRatingChange={setSearchMinRating}
                    />
                  </div>
                </aside>

                <div className="flex-1">
                  {searchLoading ? (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                      {[...Array(12)].map((_, i) => <ProductSkeleton key={i} />)}
                    </div>
                  ) : searchResults.length > 0 ? (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                      {searchResults.map((p: WooProduct) => <ProductCard key={p.id} product={p} onClick={handleProductClick} onAddToCart={handleQuickAdd} />)}
                    </div>
                  ) : (
                    <div className="text-center py-32 bg-muted/10 rounded-[60px] border-2 border-dashed border-border/50">
                      <Package size={64} className="mx-auto text-muted-foreground opacity-10 mb-6" />
                      <h3 className="text-2xl font-black uppercase tracking-tighter">Aucun résultat</h3>
                      <p className="text-muted-foreground mt-2 mb-8 max-w-xs mx-auto text-sm font-medium">Essaie d'élargir tes filtres.</p>
                      <Button
                        variant="outline"
                        onClick={() => { setSearchSelectedCountries([]); setSearchPriceRange([0, 1000000]); setSearchMinRating(0) }}
                        className="rounded-full px-10 border-accent text-accent font-black h-12 hover:bg-accent hover:text-white transition-all"
                      >
                        RÉINITIALISER LES FILTRES
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Mobile Drawer */}
            {isSearchFilterMobileOpen && (
              <div className="fixed inset-0 z-[100] lg:hidden">
                <div
                  className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in duration-300"
                  role="button"
                  tabIndex={0}
                  aria-label="Fermer les filtres"
                  onClick={() => setIsSearchFilterMobileOpen(false)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setIsSearchFilterMobileOpen(false) }}
                />
                <div className="absolute bottom-0 left-0 right-0 bg-background rounded-t-[50px] p-10 shadow-2xl animate-in slide-in-from-bottom duration-500 max-h-[85vh] overflow-y-auto">
                  <div className="w-12 h-1.5 bg-muted rounded-full mx-auto mb-8" />
                  <div className="flex items-center justify-between mb-10">
                    <h2 className="text-3xl font-black uppercase tracking-tighter">Filtres</h2>
                    <button type="button" onClick={() => setIsSearchFilterMobileOpen(false)} aria-label="Fermer" className="w-12 h-12 rounded-full bg-muted flex items-center justify-center active:scale-90 transition-transform"><X size={24} /></button>
                  </div>
                  <ProductFilterSidebar
                    selectedCountries={searchSelectedCountries}
                    onSelectedCountriesChange={setSearchSelectedCountries}
                    priceRange={searchPriceRange}
                    onPriceRangeChange={setSearchPriceRange}
                    minRating={searchMinRating}
                    onMinRatingChange={setSearchMinRating}
                  />
                  <Button className="w-full bg-accent text-white font-black h-16 rounded-[24px] mt-12 shadow-2xl shadow-accent/30 text-lg" onClick={() => setIsSearchFilterMobileOpen(false)}>
                    APPLIQUER
                  </Button>
                </div>
              </div>
            )}
          </main>
        );
      }
      default:
        return <PageSkeleton />;
    }
  };

  return (
    <StreamedNavClickProvider value={{ onVendorClick: handleVendorClick, onProductClick: handleProductClick, onViewAllCountry: handleViewAllCountry, onViewAllCategory: (slug: string) => { openCategory(slug) }, onReorder: handleReorder }}>
      <Header {...headerProps} />

      {countryWasAutoDetected && currentView !== 'login' && currentView !== 'checkout' && (
        // Masqué sur mobile pour la vue produit, même logique que le header
        // ci-dessus : l'image produit doit prendre tout le haut de l'écran.
        <div className={currentView === 'product' ? 'hidden sm:block' : ''}>
          <CountryDetectionBanner countryCode={selectedCountryCode} onChangeCountry={setSelectedCountryCode} language={language} />
        </div>
      )}

      <div className="w-full min-h-screen">
        {renderMainContent()}
      </div>

      {/* ProductTicker retiré de l'accueil (demandé le 2026-07-24). */}

      {/* Quick Select Modal Overlay - Fix: Placé à l'extérieur pour corriger l'erreur de syntaxe */}
      {quickProduct && (
        <QuickSelectModal 
          product={quickProduct} 
          onClose={() => setQuickProduct(null)} 
          onConfirm={handleConfirmQuickAdd} 
        />
      )}
      {currentView !== 'login' && (
        // has-bottom-nav : réserve la hauteur de la MobileBottomNav (fixed)
        // + la safe-area iOS, sinon le bas du footer (liste des pays,
        // moyens de paiement) reste masqué derrière la barre sur mobile.
        // Pas sur la vue panier : la MobileBottomNav y est masquée (voir
        // plus bas), c'est la barre "Procéder au paiement" de CartPage qui
        // occupe le bas de l'écran sur mobile.
        <div className={currentView === 'cart' ? '' : 'has-bottom-nav'}>
          <Footer categories={categories} onCountryClick={handleCountryClick} selectedCountry={selectedCountryCode} language={language} />
        </div>
      )}
      {currentView === 'home' && <ScrollToTopButton />}
      {/* MobileBottomNav masquée sur la vue panier : sur mobile, CartPage
          affiche sa propre barre fixe "Procéder au paiement" (z-40) — la
          bottom-nav (z-50) passait par-dessus et recouvrait le bouton. */}
      {currentView !== 'login' && currentView !== 'cart' && (
        <MobileBottomNav
          currentView={currentView}
          cartCount={cartCount}
          isLoggedIn={isLoggedIn}
          userType={userType}
          language={language}
          onHome={() => { setSelectedCategory(null); setSearchQuery(''); navigateTo('home', true, '/'); }}
          onNavigate={navigateTo}
          onAccount={() => {
            if (!isLoggedIn) { prevView.current = currentView; navigateTo('login'); }
            else if (isRep.current) { window.location.href = '/espace-representant'; }
            else { setPendingDashboardSection(undefined); navigateTo(userType === 'vendor' ? 'vendorDashboard' : 'clientDashboard'); }
          }}
          onSectionClick={handleDashboardSectionClick}
        />
      )}
      <MobileSidebar
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        isLoggedIn={isLoggedIn}
        userName={userName}
        userType={userType}
        onNavigate={setCurrentView}
        onLogout={handleLogout}
      />
    </StreamedNavClickProvider>
  )
}
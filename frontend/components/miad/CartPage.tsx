"use client"

import { useState, useEffect, useMemo } from 'react'
import Image from 'next/image'
import { Minus, Plus, Trash2, ArrowLeft, Truck, ShoppingBag, Share2, MapPin, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { type CartItem } from '@/lib/woocommerce'
import { useCurrency } from '@/contexts/CurrencyContext'
import { isLocalDelivery, isSameZoneAfrica, COUNTRY_TO_ZONE } from '@/lib/shipping-utils'
import { useShippingRates, calcShipping } from '@/hooks/useShippingRates'
import { isSenegalDomestic, SENEGAL_DOMESTIC_FALLBACK_USD } from '@/lib/domestic-shipping-estimate'
import { SENEGAL_CITIES } from '@/lib/geo-senegal'

interface CartPageProps {
  cart: CartItem[]
  onUpdateQuantity: (productId: string, quantity: number) => void
  onRemoveItem: (productId: string) => void
  onContinueShopping: () => void
  onCheckout: () => void
  onShareCart?: () => void
  shippingRates: Record<string, any>;
  userCountry: string;
}

function CartItemImage({ src, name }: { src: string; name: string }) {
  const [errored, setErrored] = useState(false)
  const valid = src && src !== '/placeholder.jpg' && !errored
  
  return valid ? (
    <Image
      src={src}
      alt={name}
      fill
      className="object-cover"
      onError={() => setErrored(true)}
    />
  ) : (
    <div className="w-full h-full flex items-center justify-center bg-linear-to-br from-accent/20 to-primary/20">
      <span className="text-2xl">🛍️</span>
    </div>
  )
}

export function CartPage({
  cart,
  onUpdateQuantity,
  onRemoveItem,
  onContinueShopping,
  onCheckout,
  onShareCart,
  shippingRates,
  userCountry,
}: CartPageProps) {
  const [shippingMethod, setShippingMethod] = useState<'standard' | 'express'>('standard')
  const { formatPrice: fp } = useCurrency()
  const shippingRatesConfig = useShippingRates()

  // Seuil livraison offerte : piloté par shipping-svc /shipping/config
  // (back-office → Livraison), comme au checkout. 0 => jamais offert.
  const FREE_SHIPPING_THRESHOLD = shippingRatesConfig.free_threshold ?? 150

  const subtotal = cart.reduce((sum, item) => {
    const price = Number(item.variation?.price || item.product.price || 0);
    return sum + (price * Number(item.quantity));
  }, 0)

  const isFreeShipping = FREE_SHIPPING_THRESHOLD > 0 && subtotal >= FREE_SHIPPING_THRESHOLD

  // Livraison par produit via tarifs dynamiques (admin WordPress). Vendeur ET
  // acheteur au Sénégal -> estimation alignée sur le module de livraison
  // nationale (checkout) plutôt que le tarif "local" générique, qui n'a pas
  // de sens ici (voir lib/domestic-shipping-estimate.ts).
  const perItemShipping = (item: CartItem, method: 'standard' | 'express') =>
    isSenegalDomestic(item.product.countryCode || '', userCountry)
      ? (shippingRatesConfig.domestic_fallback_usd ?? SENEGAL_DOMESTIC_FALLBACK_USD)
      : calcShipping(item.product.countryCode || '', userCountry, method, shippingRatesConfig, COUNTRY_TO_ZONE)

  const expressShipping = useMemo(() => cart.reduce((sum, item) => {
    return sum + perItemShipping(item, 'express') * item.quantity
  }, 0), [cart, userCountry, shippingRatesConfig])

  const standardShipping = useMemo(() => cart.reduce((sum, item) => {
    return sum + perItemShipping(item, 'standard') * item.quantity
  }, 0), [cart, userCountry, shippingRatesConfig])

  // ── Vrai calcul par distance, directement dans le panier (pas juste une
  // estimation) — demandé le 2026-08-21 : dès que le client renseigne sa
  // ville, on calcule le vrai tarif sans attendre l'étape checkout. Actif
  // seulement quand TOUT le panier est éligible (même simplification que
  // CheckoutPage : un panier mêlant Sénégal + international garde l'ancien
  // sélecteur Standard/Express pour l'instant).
  const allSenegalDomestic = cart.length > 0 && cart.every(item => isSenegalDomestic(item.product.countryCode || '', userCountry))
  const uniqueSenegalVendors = useMemo(() => {
    if (!allSenegalDomestic) return []
    const map = new Map<string, string>()
    // product.vendor peut être null (produit sans boutique résolue côté API
    // — voir app/api/products/route.ts mapProduct) : crash en prod trouvé
    // le 2026-08-26 (TypeError: Cannot read properties of undefined
    // (reading 'name')) une fois le panier persisté côté serveur, un item
    // avec vendor manquant pouvant désormais plus facilement entrer dans
    // le panier via la fusion au login que via un ajout manuel classique.
    for (const item of cart) {
      if (item.product.vendor) map.set(item.product.vendor.id, item.product.vendor.name)
    }
    return Array.from(map, ([id, name]) => ({ id, name }))
  }, [cart, allSenegalDomestic])

  const [senegalCity, setSenegalCity] = useState('')
  const [senegalLat, setSenegalLat] = useState<number | null>(null)
  const [senegalLng, setSenegalLng] = useState<number | null>(null)
  const [locatingBuyer, setLocatingBuyer] = useState(false)
  const [domesticQuotes, setDomesticQuotes] = useState<Record<string, { price: number; distance_km: number | null; eta_label: string | null }>>({})
  const [domesticLoading, setDomesticLoading] = useState(false)

  useEffect(() => {
    if (!allSenegalDomestic || !senegalCity || uniqueSenegalVendors.length === 0) return
    let cancelled = false
    setDomesticLoading(true)
    const timer = setTimeout(() => {
      Promise.all(uniqueSenegalVendors.map(async (v) => {
        try {
          const res = await fetch('/api/shipping-domestic/calculate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vendorId: v.id, buyerCity: senegalCity, buyerLat: senegalLat, buyerLng: senegalLng, cartTotal: subtotal }),
          })
          const data = await res.json()
          return [v.id, { price: data.price ?? 0, distance_km: data.distance_km ?? null, eta_label: data.eta_label ?? null }] as const
        } catch {
          return [v.id, { price: shippingRatesConfig.domestic_fallback_usd ?? SENEGAL_DOMESTIC_FALLBACK_USD, distance_km: null, eta_label: null }] as const
        }
      })).then((results) => {
        if (cancelled) return
        setDomesticQuotes(Object.fromEntries(results))
        setDomesticLoading(false)
      })
    }, 500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [allSenegalDomestic, senegalCity, senegalLat, senegalLng, uniqueSenegalVendors, subtotal])

  const domesticReady = allSenegalDomestic && uniqueSenegalVendors.length > 0 && uniqueSenegalVendors.every(v => domesticQuotes[v.id])
  const domesticShippingTotal = useMemo(
    () => uniqueSenegalVendors.reduce((sum, v) => sum + (domesticQuotes[v.id]?.price || 0), 0),
    [uniqueSenegalVendors, domesticQuotes]
  )

  const handleLocateBuyer = () => {
    if (!navigator.geolocation) return
    setLocatingBuyer(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setSenegalLat(position.coords.latitude)
        setSenegalLng(position.coords.longitude)
        setLocatingBuyer(false)
      },
      () => setLocatingBuyer(false),
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  const shipping = isFreeShipping ? 0 : (domesticReady ? domesticShippingTotal : (shippingMethod === 'express' ? expressShipping : standardShipping))
  const total = subtotal + shipping

  if (cart.length === 0) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center py-20">
        <div className="text-center">
          <ShoppingBag size={64} className="mx-auto text-muted-foreground mb-6 opacity-30" />
          <h1 className="text-2xl font-bold text-foreground mb-3">Votre panier est vide</h1>
          <p className="text-muted-foreground mb-8">
            Découvrez nos produits africains authentiques
          </p>
          <Button onClick={onContinueShopping} className="bg-accent text-accent-foreground hover:bg-accent/90">
            Continuer mes achats
          </Button>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-muted/30 py-8 pb-28 lg:pb-8">
      <div className="container mx-auto px-4">
        <button
          type="button"
          onClick={onContinueShopping}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <ArrowLeft size={20} />
          <span>Continuer les achats</span>
        </button>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Cart items */}
          <div className="lg:col-span-2">
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="p-5 border-b border-border flex items-center justify-between gap-3">
                <h1 className="text-lg font-bold text-foreground">
                  Mon panier ({cart.length} article{cart.length > 1 ? 's' : ''})
                </h1>
                {onShareCart && (
                  <button
                    type="button"
                    onClick={onShareCart}
                    className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-accent transition-colors shrink-0"
                  >
                    <Share2 size={14} />
                    Partager mon panier
                  </button>
                )}
              </div>

              <div className="divide-y divide-border">
                {cart.map(item => {
                  const pc = item.product.countryCode || ''
                  const local = isLocalDelivery(pc, userCountry)
                  const africanNeighbor = !local && isSameZoneAfrica(pc, userCountry)
                  const itemShippingUnit = perItemShipping(item, shippingMethod)
                  const itemShippingTotal = itemShippingUnit * item.quantity

                  return (
                    <div key={`${item.product.id}-${item.variation?.id || '0'}`} className="p-5 hover:bg-muted/20 transition-colors">
                      <div className="flex gap-4">
                        {/* Product image */}
                        <div className="relative w-20 h-20 rounded-lg bg-muted overflow-hidden shrink-0">
                          <CartItemImage src={item.product.image} name={item.product.name} />
                        </div>

                        {/* Product info */}
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-foreground text-sm leading-snug line-clamp-2">
                            {item.product.name}
                          </h3>
                          {item.variation?.attributes && (
                            <p className="text-[10px] text-muted-foreground mt-1 uppercase font-bold bg-slate-100 w-fit px-2 py-0.5 rounded">
                              {item.variation.attributes.map((a: any) => `${a.name}: ${a.option}`).join(' · ')}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {item.product.vendor?.name || 'Boutique'}
                            {item.product.country ? ` · ${item.product.country}` : ''}
                          </p>
                          <div className="mt-2 space-y-1">
                            <p className="text-sm font-bold text-foreground">
                              {fp(Number(item.variation?.price || item.product.price))} <span className="text-[10px] text-muted-foreground font-normal">/ unité</span>
                            </p>
                            <p className="flex items-center gap-1 text-[10px]">
                              <Truck size={10} className={local ? 'text-emerald-500' : africanNeighbor ? 'text-blue-500' : 'text-muted-foreground'} />
                              {local
                                ? <span className="text-emerald-600 font-bold">Livraison locale — {fp(itemShippingUnit)}</span>
                                : africanNeighbor
                                ? <span className="text-blue-600 font-bold">Zone Afrique — {fp(itemShippingUnit)}</span>
                                : <span className="text-muted-foreground">International — {fp(itemShippingUnit)}</span>
                              }
                            </p>
                          </div>
                        </div>

                        {/* Subtotal */}
                        <div className="text-right shrink-0">
                          <p className="font-black text-foreground text-sm">
                            {fp(Number(item.variation?.price || item.product.price) * item.quantity)}
                          </p>
                          <p className={`text-[9px] font-bold mt-0.5 ${local ? 'text-emerald-500' : 'text-muted-foreground'}`}>
                            + {fp(itemShippingTotal)} livr.
                          </p>
                        </div>
                      </div>

                      {/* Qty controls + remove */}
                      <div className="flex items-center justify-between mt-3">
                        <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
                          <button
                            type="button"
                            aria-label="Diminuer la quantité"
                            onClick={() => onUpdateQuantity(item.product.id, item.quantity - 1)}
                            className="p-1.5 hover:bg-background rounded transition-colors"
                          >
                            <Minus size={13} />
                          </button>
                          <span className="w-8 text-center font-medium text-sm">{item.quantity}</span>
                          <button
                            type="button"
                            aria-label="Augmenter la quantité"
                            onClick={() => onUpdateQuantity(item.product.id, item.quantity + 1)}
                            className="p-1.5 hover:bg-background rounded transition-colors"
                          >
                            <Plus size={13} />
                          </button>
                        </div>
                        <button
                          type="button"
                          aria-label="Supprimer l'article"
                          onClick={() => onRemoveItem(item.product.id)}
                          className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Order summary */}
          <div>
            <div className="bg-card rounded-xl border border-border p-5 sticky top-24">
              <h2 className="text-base font-bold text-foreground mb-5">Résumé de la commande</h2>

              {isFreeShipping ? (
                <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 mb-4">
                  <Truck size={14} className="text-emerald-600 shrink-0" />
                  <span className="text-xs font-bold text-emerald-700">Livraison offerte !</span>
                </div>
              ) : subtotal > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-4">
                  <p className="text-[11px] text-amber-700 font-medium">
                    Encore <span className="font-black">{fp(FREE_SHIPPING_THRESHOLD - subtotal)}</span> pour la livraison gratuite
                  </p>
                  <div className="mt-1.5 h-1.5 bg-amber-100 rounded-full overflow-hidden">
                    <div className="h-full bg-amber-400 rounded-full transition-all" style={{ width: `${Math.min((subtotal / FREE_SHIPPING_THRESHOLD) * 100, 100)}%` }} />
                  </div>
                </div>
              )}

              <div className="space-y-3 mb-5">
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>Sous-total ({cart.length} article{cart.length > 1 ? 's' : ''})</span>
                  <span className="font-medium text-foreground">{fp(subtotal)}</span>
                </div>
                <div>
                  <div className="flex items-center gap-2 text-primary mb-2">
                    <Truck size={13} />
                    <span className="text-xs font-bold text-foreground">Mode de livraison</span>
                  </div>

                  {allSenegalDomestic && (
                    <div className="mb-2.5">
                      <div className="flex gap-1.5">
                        <Input
                          list="miad-cart-senegal-cities"
                          value={senegalCity}
                          onChange={e => setSenegalCity(e.target.value)}
                          placeholder="Votre ville (Sénégal)"
                          className="h-9 text-xs flex-1"
                        />
                        <datalist id="miad-cart-senegal-cities">
                          {SENEGAL_CITIES.map(c => <option key={c} value={c} />)}
                        </datalist>
                        <button
                          type="button"
                          onClick={handleLocateBuyer}
                          disabled={locatingBuyer}
                          className="h-9 w-9 shrink-0 border border-border rounded-lg flex items-center justify-center hover:bg-muted transition-colors disabled:opacity-50"
                          aria-label="Utiliser ma position"
                        >
                          {locatingBuyer ? <Loader2 size={13} className="animate-spin" /> : <MapPin size={13} />}
                        </button>
                      </div>
                      {senegalCity && !domesticReady && (
                        <p className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1">
                          {domesticLoading ? <><Loader2 size={10} className="animate-spin" /> Calcul du tarif exact…</> : 'Entrez votre ville pour un tarif exact.'}
                        </p>
                      )}
                    </div>
                  )}

                  {domesticReady ? (
                    <div className="p-3 rounded-xl border-2 border-primary bg-primary/5">
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-black text-[10px] uppercase">Livraison nationale — Sénégal</span>
                        <span className="font-bold text-xs text-accent">{isFreeShipping ? 'GRATUIT' : fp(domesticShippingTotal)}</span>
                      </div>
                      <div className="space-y-0.5">
                        {uniqueSenegalVendors.map(v => {
                          const q = domesticQuotes[v.id]
                          if (!q) return null
                          return (
                            <p key={v.id} className="text-[9px] text-muted-foreground">
                              {v.name}{q.distance_km != null ? ` · ${q.distance_km} km` : ''}{q.eta_label ? ` · ${q.eta_label}` : ''} — {fp(q.price)}
                            </p>
                          )
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setShippingMethod('standard')}
                        className={`p-3 rounded-xl border-2 text-left transition-all ${shippingMethod === 'standard' ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-primary/40'}`}
                      >
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="font-black text-[10px] uppercase">Standard</span>
                          {isFreeShipping
                            ? <span className="font-black text-xs text-emerald-600">GRATUIT</span>
                            : <span className="font-bold text-xs text-accent">{fp(standardShipping)}</span>}
                        </div>
                        <p className="text-[9px] text-muted-foreground">1-3 j. (local) · ~20 j. (international)</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShippingMethod('express')}
                        className={`p-3 rounded-xl border-2 text-left transition-all ${shippingMethod === 'express' ? 'border-accent bg-accent/5 shadow-sm' : 'border-border hover:border-accent/40'}`}
                      >
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="font-black text-[10px] uppercase">MIAD Express</span>
                          {isFreeShipping
                            ? <span className="font-black text-xs text-emerald-600">GRATUIT</span>
                            : <span className="font-bold text-xs text-accent">{fp(expressShipping)}</span>}
                        </div>
                        <p className="text-[9px] text-muted-foreground">24-48h (local) · 3-5 j. (international)</p>
                      </button>
                    </div>
                  )}
                </div>
                <div className="border-t border-border pt-3 flex justify-between font-bold text-foreground">
                  <span>Total</span>
                  <span className="text-accent text-lg">{fp(total)}</span>
                </div>
              </div>

              {/* Desktop uniquement (lg+) — sur mobile le bouton est dans la
                  barre fixe ci-dessous, pas ici, sinon il faut défiler toute
                  la carte résumé (sous-total + livraison + ville) pour
                  l'atteindre. Signalé le 2026-08-27 : "on doit défiler tout
                  en bas pour confirmer". */}
              <Button
                onClick={() => {
                  if (typeof window !== 'undefined') {
                    sessionStorage.setItem('miad_shipping_method', shippingMethod)
                  }
                  onCheckout()
                }}
                className="hidden lg:flex w-full py-6 bg-accent text-accent-foreground hover:bg-accent/90 font-bold"
              >
                Procéder au paiement
              </Button>

              <p className="hidden lg:block text-xs text-muted-foreground text-center mt-3">
                Paiement sécurisé · Wave · Orange Money · Carte
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Barre de paiement fixe (mobile/tablette uniquement) — toujours
          visible sans avoir à défiler, contrairement au bouton dans la
          carte résumé ci-dessus (masqué sur cette taille d'écran). pb-24
          sur le conteneur principal (voir plus haut) réserve la place pour
          ne pas que cette barre recouvre le bas du contenu. */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-card border-t border-border px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)]">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[10px] text-muted-foreground font-medium">Total</p>
            <p className="text-lg font-black text-accent">{fp(total)}</p>
          </div>
          <Button
            onClick={() => {
              if (typeof window !== 'undefined') {
                sessionStorage.setItem('miad_shipping_method', shippingMethod)
              }
              onCheckout()
            }}
            className="flex-1 py-6 bg-accent text-accent-foreground hover:bg-accent/90 font-bold"
          >
            Procéder au paiement
          </Button>
        </div>
      </div>
    </main>
  )
}

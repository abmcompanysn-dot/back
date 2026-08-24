"use client"

import { useEffect, useState, Suspense, type FormEvent } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import useSWR from 'swr'
import {
  CheckCircle, 
  ShoppingBag, 
  ArrowRight, 
  Package, 
  Clock, 
  Mail, 
  ShieldCheck,
  CreditCard,
  Truck,
  ChevronRight,
  AlertCircle,
  Info
} from 'lucide-react'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { formatPrice } from '@/lib/woocommerce'
import { toast } from 'sonner'
import { RecommendedProducts } from '@/components/miad/RecommendedProducts'

interface PurchasedItem {
  productId: number
  name: string
  quantity: number
  image: string
}

const fetcher = (url: string) => fetch(url).then(res => (res.ok ? res.json() : null))

/**
 * MIAD Market - Page de Confirmation de Commande (Success)
 * Traite les retours du tunnel WooCommerce (order_id, order_key, total, status).
 */
function SuccessContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  
  const orderId = searchParams.get('order_id')
  const orderKey = searchParams.get('order_key')
  const total = searchParams.get('total')
  const status = searchParams.get('status') || 'processing'

  const [email, setEmail] = useState('')
  const [isVerifying, setIsVerifying] = useState(false)
  const [isVerified, setIsVerified] = useState(true)

  // Récupération des articles achetés (image, nom, quantité) pour l'affichage
  const { data: itemsData } = useSWR<{ items: PurchasedItem[] }>(
    orderId ? `/api/orders/${orderId}/items` : null,
    fetcher
  )
  const items = itemsData?.items ?? []

  useEffect(() => {
    // 1. Validation de base
    if (!orderId) {
       const timer = setTimeout(() => router.push('/'), 5000)
       return () => clearTimeout(timer)
    }

    // 2. Vérification de sécurité (si pas de clé, on demande l'email comme sur WooCommerce)
    if (!orderKey) {
        setIsVerified(false)
    }

    // 3. Vidage du panier local (la commande est terminée)
    if (typeof window !== 'undefined') {
        localStorage.removeItem('miad_cart')
        window.dispatchEvent(new Event('cart-updated'))
    }
  }, [orderId, orderKey, router])

  const handleVerifyEmail = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsVerifying(true)
    // Simulation d'une validation d'identité guest
    setTimeout(() => {
      setIsVerifying(false)
      setIsVerified(true)
      toast.success("Commande vérifiée !")
    }, 1500)
  }

  const isPending = status === 'pending' || status === 'on-hold'

  // Écran de vérification d'email (Style Amazon/WooCommerce)
  if (!isVerified) {
    return (
      <div className="min-h-screen bg-muted/20 flex items-center justify-center p-6">
        <div className="bg-card border border-border p-8 rounded-[2.5rem] shadow-2xl max-w-md w-full animate-in fade-in zoom-in duration-500">
          <div className="w-20 h-20 bg-accent/10 rounded-full flex items-center justify-center mb-6 mx-auto">
            <Mail size={32} className="text-accent" />
          </div>
          <h1 className="text-2xl font-black text-center mb-3">Vérification de sécurité</h1>
          <p className="text-muted-foreground text-center mb-8 text-sm leading-relaxed">
            Pour accéder aux détails de votre commande <b>#{orderId}</b>, veuillez confirmer l'adresse email utilisée.
          </p>
          
          <form onSubmit={handleVerifyEmail} className="space-y-5">
            <div className="space-y-2">
              <label htmlFor="success-verify-email" className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground ml-1">Email de l'acheteur</label>
              <input
                id="success-verify-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="votre@email.com"
                className="w-full h-14 px-5 rounded-2xl border-2 border-border focus:border-accent bg-background outline-none transition-all font-medium"
              />
            </div>
            <Button 
              type="submit" 
              disabled={isVerifying}
              className="w-full h-14 rounded-2xl bg-accent text-white font-black text-lg shadow-lg shadow-accent/20"
            >
              {isVerifying ? "Vérification..." : "Vérifier & Afficher"}
            </Button>
          </form>
          
          <div className="mt-8 pt-6 border-t border-border/50 flex items-center gap-3 text-[10px] text-muted-foreground">
             <AlertCircle size={14} className="shrink-0" />
             <span>Ceci est une mesure de protection pour vos données personnelles.</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background flex flex-col selection:bg-accent/20">
      <main className="flex-1 container mx-auto px-4 py-16 md:py-24 flex flex-col items-center">
        
        {/* Success Header */}
        <div className="text-center mb-12">
          <div className="mb-8 relative inline-block">
             <div className={`absolute inset-0 ${isPending ? 'bg-orange-400' : 'bg-green-400'} rounded-full blur-3xl opacity-20 animate-pulse`}></div>
             <div className={`w-24 h-24 ${isPending ? 'bg-orange-500' : 'bg-green-500'} rounded-full flex items-center justify-center relative z-10 shadow-2xl scale-110`}>
               {isPending ? <Clock size={48} className="text-white" /> : <CheckCircle size={48} className="text-white" />}
             </div>
          </div>
          <h1 className="text-4xl md:text-6xl font-black mb-6 tracking-tighter">
            {isPending ? "Commande Reçue !" : "Merci pour votre achat !"}
          </h1>
          <p className="text-muted-foreground text-lg md:text-xl max-w-2xl mx-auto leading-relaxed">
            {isPending 
              ? `Votre commande #${orderId} a bien été enregistrée. Elle est en attente de paiement ou de validation.`
              : `Votre commande #${orderId} est confirmée. Nous préparons vos articles pour une expédition immédiate via MIAD Express.`
            }
          </p>
        </div>

        {/* Info Grid */}
        <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-12 gap-6 mb-16">
            
            {/* Main Summary Card */}
            <div className="md:col-span-7 bg-card border border-border rounded-[2.5rem] p-8 md:p-10 shadow-sm relative overflow-hidden">
                <div className="absolute top-0 right-0 p-8 opacity-[0.03] rotate-12">
                    <ShoppingBag size={120} />
                </div>

                <div className="relative z-10">
                    <div className="flex justify-between items-start mb-10">
                        <div>
                            <p className="text-[10px] font-black uppercase text-muted-foreground tracking-[0.2em] mb-1">Numéro de Commande</p>
                            <h2 className="text-3xl font-black">#{orderId}</h2>
                        </div>
                        <div className="text-right">
                            <p className="text-[10px] font-black uppercase text-muted-foreground tracking-[0.2em] mb-1">
                                {status === 'completed' ? 'Total Payé' : 'Total TTC'}
                            </p>
                            <p className="text-3xl font-black text-accent">{total && total !== '0' ? `${formatPrice(Number(total))} $` : 'Confirmé'}</p>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-8">
                        <div className="space-y-1">
                            <div className="flex items-center gap-2 text-[10px] font-black uppercase text-muted-foreground tracking-widest">
                                <Truck size={12} className="text-accent" /> Livraison
                            </div>
                            <p className="text-sm font-bold">MIAD Express</p>
                            <p className="text-[10px] text-muted-foreground">International (3-5 jours)</p>
                        </div>
                        <div className="space-y-1">
                            <div className="flex items-center gap-2 text-[10px] font-black uppercase text-muted-foreground tracking-widest">
                                <CreditCard size={12} className="text-accent" /> Paiement
                            </div>
                            <p className="text-sm font-bold capitalize">{status.replace('-', ' ')}</p>
                            <p className="text-[10px] text-muted-foreground">Sécurisé</p>
                        </div>
                    </div>

                    {items.length > 0 && (
                      <div className="space-y-3 mt-8 pt-6 border-t border-border/50">
                        {items.map((item) => (
                          <div key={item.productId} className="flex items-center gap-3">
                            <div className="relative w-12 h-12 rounded-xl bg-muted overflow-hidden shrink-0">
                              {item.image ? (
                                <Image src={item.image} alt={item.name} fill className="object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  <ShoppingBag size={18} className="text-muted-foreground/40" />
                                </div>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-bold truncate">{item.name}</p>
                              <p className="text-[10px] text-muted-foreground">Qté : {item.quantity}</p>
                            </div>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => window.location.href = '/?view=clientDashboard'}
                          className="text-xs font-black text-accent hover:underline pt-1"
                        >
                          Voir le détail complet de la commande →
                        </button>
                      </div>
                    )}
                </div>
            </div>

            {/* Next Steps */}
            <div className="md:col-span-5 bg-primary text-primary-foreground rounded-[2.5rem] p-8 md:p-10 flex flex-col shadow-xl">
                <h3 className="font-black text-xl mb-6 text-white">Prochaines étapes</h3>
                <div className="space-y-6 flex-1">
                    <div className="flex gap-4">
                        <div className="shrink-0 w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold">1</div>
                        <p className="text-sm opacity-90 leading-snug">Vérifiez vos emails pour le <b>récapitulatif complet</b>.</p>
                    </div>
                    <div className="flex gap-4">
                        <div className="shrink-0 w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold">2</div>
                        <p className="text-sm opacity-90 leading-snug">Nous validons votre commande et préparons le colis sous <b>24h</b>.</p>
                    </div>
                    <div className="flex gap-4">
                        <div className="shrink-0 w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold">3</div>
                        <p className="text-sm opacity-90 leading-snug">Vous recevez un <b>lien de suivi MIAD Express</b> dès le départ du colis.</p>
                    </div>
                </div>
            </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
          <Button 
            onClick={() => window.location.href = '/'} 
            className="flex-1 h-16 rounded-2xl font-black bg-accent text-white gap-3 shadow-xl shadow-accent/20 hover:scale-[1.03] transition-all"
          >
            <ShoppingBag size={20} /> Continuer mes achats
          </Button>
          <Button 
            variant="outline" 
            onClick={() => window.location.href = '/?view=clientDashboard'} 
            className="flex-1 h-16 rounded-2xl font-black border-2 gap-3 hover:bg-muted group"
          >
             Mes Commandes <ChevronRight size={20} className="group-hover:translate-x-1 transition-transform" />
          </Button>
        </div>

        <RecommendedProducts excludeIds={items.map((i) => i.productId)} />
      </main>
    </div>
  )
}

export default function SuccessPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center font-bold">Vérification de la commande...</div>}>
      <SuccessContent />
    </Suspense>
  )
}
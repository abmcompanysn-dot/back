"use client"
import React, { useState } from 'react'
import { 
  ArrowLeft, MessageSquare, ShieldCheck, Truck, CreditCard, ShoppingBag, 
  XCircle, RotateCcw, ChevronRight, Search, Info, LifeBuoy, FileText, 
  Lock, Zap, UserCheck
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const helpTopics = [
  { title: "Passer une commande", icon: ShoppingBag, desc: "Apprenez à sélectionner vos produits et valider votre panier." },
  { title: "Payer une commande", icon: CreditCard, desc: "Options de paiement sécurisées : Orange Money, Wave, Carte bancaire." },
  { title: "Suivre votre colis", icon: Truck, desc: "Suivez l'acheminement de votre commande en temps réel." },
  { title: "Annuler une commande", icon: XCircle, desc: "Conditions et étapes pour annuler un achat non expédié." },
  { title: "Retour & remboursements", icon: RotateCcw, desc: "Politique de retour de 7 jours et modalités de remboursement." },
]

const topicContent: Record<string, React.ReactNode> = {
  "Passer une commande": (
    <div className="space-y-4">
      <p>Passer une commande sur MIAD Market est simple et sécurisé :</p>
      <ol className="list-decimal pl-5 space-y-3">
        <li>Parcourez les rayons ou recherchez un produit spécifique.</li>
        <li>Sélectionnez vos options (taille, couleur) et cliquez sur <b>"Ajouter au panier"</b>.</li>
        <li>Accédez à votre panier et cliquez sur <b>"Procéder au paiement"</b>.</li>
        <li>Remplissez vos informations de livraison avec précision.</li>
        <li>Choisissez votre mode de paiement (Orange Money, Wave, Carte) et validez.</li>
      </ol>
    </div>
  ),
  "Payer une commande": (
    <div className="space-y-6">
      <p>Nous proposons plusieurs solutions de paiement sécurisées et adaptées au continent africain :</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="p-5 border rounded-3xl bg-orange-50 border-orange-200">
          <h4 className="font-black text-orange-700 flex items-center gap-2 uppercase text-xs tracking-widest mb-2">Orange Money</h4>
          <p className="text-xs text-orange-600 leading-relaxed">Paiement instantané. Saisissez votre numéro, confirmez avec votre code secret sur votre mobile.</p>
        </div>
        <div className="p-5 border rounded-3xl bg-blue-50 border-blue-200">
          <h4 className="font-black text-blue-700 flex items-center gap-2 uppercase text-xs tracking-widest mb-2">Wave</h4>
          <p className="text-xs text-blue-600 leading-relaxed">Scannez le QR Code ou validez via l'application Wave pour un paiement sans frais supplémentaires.</p>
        </div>
        <div className="p-5 border rounded-3xl bg-slate-50 border-slate-200">
          <h4 className="font-black text-slate-700 flex items-center gap-2 uppercase text-xs tracking-widest mb-2">Cartes Bancaires</h4>
          <p className="text-xs text-slate-600 leading-relaxed">Visa et Mastercard acceptées. Transaction sécurisée par cryptage SSL et 3D Secure.</p>
        </div>
      </div>
    </div>
  ),
  "Suivre votre colis": (
    <div className="space-y-4">
      <p>Toutes nos expéditions internationales sont gérées exclusivement par notre service logistique <b>MIAD Express</b> :</p>
      <ul className="list-disc pl-5 space-y-2 text-sm leading-relaxed">
        <li>Dès l'expédition, un numéro de suivi (Tracking Number) vous est envoyé par email.</li>
        <li>Le délai de livraison varie entre 3 et 5 jours ouvrables selon la destination.</li>
        <li>Vous pouvez suivre l'acheminement en temps réel sur notre plateforme avec votre numéro de suivi.</li>
      </ul>
    </div>
  ),
  "Annuler une commande": (
    <div className="space-y-4 text-sm leading-relaxed">
      <p>Vous avez changé d'avis ? Voici comment annuler :</p>
      <ul className="list-disc pl-5 space-y-2">
        <li>L'annulation est possible <b>uniquement</b> si le statut est "En attente" ou "En cours".</li>
        <li>Si le colis est déjà remis à <b>MIAD Express</b>, l'annulation n'est plus possible.</li>
        <li>Le remboursement intégral sera crédité sous 48h à 72h sur votre compte.</li>
      </ul>
    </div>
  ),
  "Retour & remboursements": (
    <div className="space-y-4 text-sm leading-relaxed">
      <p>Votre confiance est notre priorité. Notre politique de retour :</p>
      <ul className="list-disc pl-5 space-y-2">
        <li>Délai de rétractation : <b>7 jours</b> après la réception du colis.</li>
        <li>Le produit doit être retourné dans son état d'origine, non porté et non lavé.</li>
        <li>Une fois le retour validé, le remboursement est effectué sous 5 jours ouvrés.</li>
      </ul>
    </div>
  ),
  "Privacy Policy": (
    <div className="space-y-4 text-sm leading-relaxed">
      <h2 className="text-xl font-bold">Politique de Confidentialité</h2>
      <p>Chez MIAD Market, nous prenons la protection de vos données très au sérieux.</p>
      <p>Nous collectons uniquement les informations nécessaires au traitement de vos commandes et à l'amélioration de votre expérience. Vos données ne sont jamais vendues à des tiers.</p>
    </div>
  ),
  "Legacy & Respect": (
    <div className="space-y-4 text-sm leading-relaxed">
      <h2 className="text-xl font-bold">Mentions Légales & Respect</h2>
      <p>MIAD Market est une infrastructure commerciale unifiée. Nous exigeons un respect mutuel entre vendeurs et acheteurs.</p>
      <p>Toute forme de fraude ou de comportement irrespectueux entraîne une suspension immédiate du compte.</p>
    </div>
  )
}

const popularSolutions = [
  { label: "Suivre mon colis", icon: Truck, topic: "Suivre votre colis" },
  { label: "Retourner l'article", icon: RotateCcw, topic: "Retour & remboursements" },
  { label: "État du remboursement", icon: Zap, topic: "Payer une commande" },
  { label: "Problème produit", icon: Info, topic: "Passer une commande" },
  { label: "Annuler commande", icon: XCircle, topic: "Annuler une commande" },
  { label: "Vendeur muet", icon: MessageSquare, topic: "Passer une commande" },
];

export function HelpCenter({ activeTopic, onTopicClick }: { activeTopic?: string, onBack: () => void, onTopicClick: (t: string) => void, onOpenChat?: () => void }) {
  const [search, setSearch] = useState('');

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Hero Section Style AliExpress */}
      <div className="bg-slate-900 py-16 md:py-24 text-white text-center relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-full opacity-10 pointer-events-none">
          <div className="absolute top-10 left-10 w-64 h-64 rounded-full bg-accent blur-3xl" />
          <div className="absolute bottom-10 right-10 w-96 h-96 rounded-full bg-primary blur-3xl" />
        </div>
        
        <div className="container mx-auto px-4">
          <h1 className="text-3xl md:text-6xl font-black uppercase tracking-tighter mb-6">
            {activeTopic ? activeTopic : "Aide MIAD Market"}
          </h1>
          <p className="opacity-80 max-w-xl mx-auto text-sm md:text-lg font-medium mb-10">
            {activeTopic ? "Guide d'utilisation et support." : "Bonjour, comment pouvons-nous vous aider aujourd'hui ?"}
          </p>
          
          {!activeTopic && (
            <div className="max-w-2xl mx-auto relative group">
              <div className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-accent transition-colors">
                <Search size={24} />
              </div>
              <Input 
                placeholder="Rechercher une question (remboursement, livraison...)" 
                className="h-16 pl-16 pr-8 rounded-full bg-white text-slate-900 border-none shadow-2xl text-lg focus-visible:ring-4 ring-accent/20"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Solutions Rapides */}
      {!activeTopic && (
        <div className="container mx-auto px-4 -mt-10 mb-16 relative z-20">
          <div className="bg-white rounded-[2.5rem] shadow-2xl p-8 md:p-12 border border-slate-100">
            <h3 className="font-black text-xs uppercase tracking-widest text-slate-400 mb-8 text-center">Solutions Populaires</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-6">
              {popularSolutions.map((sol) => (
                <button
                  type="button"
                  key={sol.label}
                  onClick={() => onTopicClick(sol.topic)}
                  className="flex flex-col items-center gap-4 group transition-all"
                >
                  <div className="w-16 h-16 rounded-3xl bg-slate-50 flex items-center justify-center text-slate-400 group-hover:bg-accent group-hover:text-white transition-all shadow-sm group-hover:shadow-lg group-hover:-translate-y-1">
                    <sol.icon size={28} />
                  </div>
                  <span className="text-[10px] font-black uppercase tracking-tighter text-slate-600 text-center">{sol.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Navigation Rapide (AliExpress Style) */}
      <div className="container mx-auto px-4 py-8">
        {!activeTopic && (
          <div className="flex gap-4 overflow-x-auto pb-8 scrollbar-hide">
            {[
              { label: "Knowledge Base", icon: LifeBuoy },
              { label: "Privacy Policy", icon: Lock, topic: "Privacy Policy" },
              { label: "Legacy & Respect", icon: ShieldCheck, topic: "Legacy & Respect" },
              { label: "Account Management", icon: UserCheck },
              { label: "Orders & Payments", icon: CreditCard },
            ].map((nav) => (
              <button
                type="button"
                key={nav.label}
                onClick={() => nav.topic && onTopicClick(nav.topic)}
                className="flex items-center gap-3 px-6 py-4 bg-white rounded-2xl border border-slate-200 shadow-sm shrink-0 hover:border-accent transition-colors"
              >
                <nav.icon size={18} className="text-accent" />
                <span className="text-xs font-black uppercase tracking-widest text-slate-700">{nav.label}</span>
              </button>
            ))}
          </div>
        )}

        {/* Contenu principal */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-8">
            {activeTopic ? (
               <div className="bg-white rounded-[2.5rem] shadow-xl border border-slate-100 overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="p-8 md:p-12">
                  <button
                    type="button"
                    onClick={() => onTopicClick('')}
                    className="flex items-center gap-2 text-accent font-black text-[10px] uppercase tracking-widest mb-8 hover:gap-3 transition-all"
                  >
                    <ArrowLeft size={14} /> Retour aux sujets
                  </button>
                  
                  <div className="prose prose-slate max-w-none text-slate-600">
                    {topicContent[activeTopic] || (
                      <div className="py-20 text-center opacity-30">
                         <LifeBuoy size={48} className="mx-auto mb-4" />
                         <p>Contenu en cours de rédaction...</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {helpTopics.map((topic) => (
                  <button
                    type="button"
                    key={topic.title}
                    onClick={() => onTopicClick(topic.title)}
                    className="bg-white p-8 rounded-[2rem] border transition-all text-left group hover:shadow-xl border-slate-200"
                  >
                    <div className="w-14 h-14 rounded-2xl bg-slate-50 flex items-center justify-center mb-6 group-hover:bg-accent text-accent group-hover:text-white transition-all shadow-sm border border-accent/10">
                      <topic.icon size={28} className="transition-colors" />
                    </div>
                    <h3 className="font-black uppercase text-sm mb-2 group-hover:text-accent transition-colors">{topic.title}</h3>
                    <p className="text-slate-500 text-xs leading-relaxed line-clamp-2">{topic.desc}</p>
                    <div className="mt-4 flex items-center gap-1 text-[10px] font-black text-accent/80 group-hover:text-accent transition-all uppercase tracking-widest">
                      En savoir plus <ChevronRight size={12} className="text-accent" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Sidebar Aide */}
          <div className="lg:col-span-4 space-y-6">

            {/* Service Records */}
            <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
               <div className="flex items-center gap-4 mb-6">
                 <div className="p-3 bg-blue-50 text-blue-600 rounded-2xl"><FileText size={20} /></div>
                 <h4 className="font-bold text-slate-900">Historique des tickets</h4>
               </div>
               <p className="text-xs text-slate-500 mb-6">Consultez vos demandes de support précédentes et le suivi de vos litiges.</p>
               <Button variant="outline" className="w-full border-slate-900 text-slate-900 font-black h-12 rounded-xl text-[10px] uppercase tracking-widest">ACCÉDER À L'HISTORIQUE</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
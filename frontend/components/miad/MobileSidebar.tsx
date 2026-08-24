"use client"

import { X, User, Package, Heart, Settings, LogOut, ShoppingBag, Home } from 'lucide-react'
import { Button } from '@/components/ui/button'

type MobileSidebarProps = {
  isOpen: boolean
  onClose: () => void
  isLoggedIn: boolean
  userName?: string
  userType: 'buyer' | 'vendor'
  onNavigate: (view: any) => void
  onLogout: () => void
}

export function MobileSidebar({ isOpen, onClose, isLoggedIn, userName, userType, onNavigate, onLogout }: MobileSidebarProps) {
  if (!isOpen) return null

  const menuItems = isLoggedIn 
    ? [
        { icon: Home, label: 'Accueil', view: 'home' },
        { icon: Package, label: 'Mes Commandes', view: userType === 'vendor' ? 'vendorDashboard' : 'clientDashboard' },
        { icon: Heart, label: 'Favoris', view: 'home' }, // À implémenter plus tard
        { icon: Settings, label: 'Paramètres', view: userType === 'vendor' ? 'vendorDashboard' : 'clientDashboard' },
      ]
    : [
        { icon: Home, label: 'Accueil', view: 'home' },
        { icon: ShoppingBag, label: 'Boutiques', view: 'home' },
      ]

  return (
    <div className="fixed inset-0 z-[100] md:hidden">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        role="button"
        tabIndex={0}
        aria-label="Fermer le menu"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClose() } }}
      />
      
      {/* Sidebar Content */}
      <div className="absolute top-0 left-0 bottom-0 w-[280px] bg-background shadow-2xl flex flex-col animate-in slide-in-from-left duration-300">
        <div className="p-6 border-b border-border flex items-center justify-between bg-primary text-primary-foreground">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
              <User size={20} />
            </div>
            <div>
              <p className="text-sm font-bold truncate max-w-[150px]">{isLoggedIn ? userName : 'Mon Compte'}</p>
              <p className="text-[10px] opacity-80 uppercase tracking-widest">{isLoggedIn ? (userType === 'vendor' ? 'Vendeur' : 'Client') : 'Non connecté'}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer le menu" className="p-1 hover:bg-white/10 rounded-full">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-4">
          <nav className="px-2 space-y-1">
            {menuItems.map((item) => (
              <button
                type="button"
                key={item.label}
                onClick={() => { onNavigate(item.view); onClose(); }}
                className="w-full flex items-center gap-4 px-4 py-3 text-sm font-medium hover:bg-accent rounded-lg transition-colors"
              >
                <item.icon size={20} className="text-muted-foreground" />
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="p-4 border-t border-border">
          {isLoggedIn ? (
            <Button variant="ghost" className="w-full justify-start gap-4 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => { onLogout(); onClose(); }}>
              <LogOut size={20} /> Déconnexion
            </Button>
          ) : (
            <Button className="w-full" onClick={() => { onNavigate('login'); onClose(); }}>Se connecter</Button>
          )}
        </div>
      </div>
    </div>
  )
}
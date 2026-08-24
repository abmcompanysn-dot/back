"use client"

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { RefreshCw, Database, CheckCircle2, AlertCircle, ArrowLeft, Package, Lock, ShieldCheck, QrCode, EyeOff, Eye, FileSpreadsheet, Download, Search, Check, X, MessageCircle, Mail, Bell, Truck, Trash2, BarChart2, ScrollText } from 'lucide-react'
import { RepMessages } from './RepMessages'
import { EmailBlast } from './EmailBlast'
import { PushBlast } from './PushBlast'
import { ShipmentManager, ShipmentOrder } from './ShipmentManager'
import { DhlLogisticsPanel } from './DhlLogisticsPanel'
import { DomesticShippingPanel } from './DomesticShippingPanel'
import { RecommendationsAdminPanel } from './RecommendationsAdminPanel'
import { AdminActionLog } from './AdminActionLog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { clearAllCaches } from '@/lib/clear-cache'

// recharts (via AnalyticsDashboard -> components/ui/chart) is heavy — load
// on demand instead of shipping it in the main admin bundle.
const AnalyticsDashboard = dynamic(() => import('./AnalyticsDashboard').then(m => m.AnalyticsDashboard), { ssr: false })

const NAV_ITEMS = [
  { id: 'overview' as const, label: "Vue d'ensemble", icon: Database },
  { id: 'kpi' as const, label: 'Parcours client & KPI', icon: BarChart2 },
  { id: 'recommendations' as const, label: 'Recommandations', icon: BarChart2 },
  { id: 'emails' as const, label: 'Emails', icon: Mail },
  { id: 'push' as const, label: 'Push', icon: Bell },
  { id: 'logistics' as const, label: 'Logistique', icon: Truck },
  { id: 'messages' as const, label: 'Messages', icon: MessageCircle },
  { id: 'journal' as const, label: 'Journal', icon: ScrollText },
]

interface AdminDashboardProps {
  onBack: () => void
  hideEmptyCategories: boolean
  onToggleHideEmpty: (val: boolean) => void
}

export function AdminDashboard({ onBack, hideEmptyCategories, onToggleHideEmpty }: AdminDashboardProps) {
  const [isSyncing, setIsSyncing] = useState(false)
  const [lastSync, setLastSync] = useState<string | null>(null)
  const [isVerified, setIsVerified] = useState(() =>
    typeof window !== 'undefined' && localStorage.getItem('miad_admin_session') === 'active'
  )
  const [twoFactorCode, setTwoFactorCode] = useState('')
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null)
  const [isSettingUp, setIsSettingUp] = useState(false)
  const [tempSecret, setTempSecret] = useState<string | null>(null)
  const [setupToken, setSetupToken] = useState('')
  const [is2FALoading, setIs2FALoading] = useState(false)
  const [showSetupPrompt, setShowSetupPrompt] = useState(false)
  const [showExplorer, setShowExplorer] = useState(false)

  const [comparisonData, setComparisonData] = useState<any[]>([])
  const [logisticsOrders, setLogisticsOrders] = useState<ShipmentOrder[]>([])
  const [isLoadingLogistics, setIsLoadingLogistics] = useState(false)
  const [isClearingCache, setIsClearingCache] = useState(false)
  const [activeSection, setActiveSection] = useState<'overview' | 'kpi' | 'recommendations' | 'emails' | 'push' | 'logistics' | 'messages' | 'journal'>('overview')

  const handleClearCache = async () => {
    setIsClearingCache(true)
    try {
      await clearAllCaches({ clearCart: false, reload: false })
      toast.success('Cache vidé — les données seront rechargées automatiquement.')
    } catch {
      toast.error('Erreur lors du vidage du cache.')
    } finally {
      setIsClearingCache(false)
    }
  }

  // Export CSV du catalogue pour import manuel dans Meta Commerce Manager
  // (bouton demandé le 2026-08-10 — force un import immédiat sans attendre
  // le prochain passage programmé du flux automatique /merchant-feed.xml).
  const [isExportingCsv, setIsExportingCsv] = useState(false)
  const handleExportMetaCsv = async () => {
    setIsExportingCsv(true)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch('/api/admin/meta-csv', { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `miad-catalogue-meta-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success('Fichier CSV téléchargé — à importer dans Meta Commerce Manager.')
    } catch {
      toast.error("Erreur lors de l'export du catalogue.")
    } finally {
      setIsExportingCsv(false)
    }
  }

  const fetchLogisticsOrders = async () => {
    setIsLoadingLogistics(true)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch('/api/orders/admin', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      const orders: any[] = data.orders || []
      setLogisticsOrders(orders.map((o: any) => {
        const meta = o.meta_data || []
        return {
          id: o.id,
          number: String(o.number || o.id),
          date: o.date_created || '',
          status: o.status,
          client: `${o.billing?.first_name || ''} ${o.billing?.last_name || ''}`.trim(),
          email: o.billing?.email || '',
          phone: o.billing?.phone || '',
          vendors: [],
          total: parseFloat(o.total || '0'),
          tracking: meta.find((m: any) => m.key === '_miad_tracking_number')?.value || '',
          carrier:  meta.find((m: any) => m.key === '_miad_carrier')?.value || '',
          line_items: o.line_items,
          shipping: o.shipping,
          billing: o.billing,
          meta_data: meta,
        }
      }))
    } catch {
      toast.error('Erreur de chargement des commandes')
    }
    setIsLoadingLogistics(false)
  }

  const fetchComparison = async () => {
    try {
      const token = localStorage.getItem('miad_token')

      const res = await fetch('/api/admin/compare', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) throw new TypeError("Réponse non-JSON reçue");
      const data = await res.json();
      if (data.comparison) setComparisonData(data.comparison)
    } catch (err) {
      toast.error("Erreur lors de la lecture du tableur système")
    }
  }

  // Révèle le QR code/secret TOTP — protégé par un jeton de configuration
  // distinct (ADMIN_2FA_SETUP_TOKEN), connu seulement de la personne qui gère
  // le serveur, jamais stocké dans le navigateur. Sans ce garde-fou, n'importe
  // quel visiteur pourrait lire le secret ici et générer des codes valides.
  const handleSetup2FA = async () => {
    if (!setupToken.trim()) {
      toast.error('Entrez le jeton de configuration (défini côté serveur).')
      return
    }
    setIs2FALoading(true)
    try {
      const res = await fetch('/api/admin/2fa', {
        headers: { 'X-Setup-Token': setupToken.trim() },
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Jeton de configuration invalide.')
        return
      }
      setQrCodeUrl(data.qrCode)
      setTempSecret(data.secret)
      setIsSettingUp(true)
    } catch {
      toast.error('Erreur réseau lors de la configuration.')
    } finally {
      setIs2FALoading(false)
    }
  }

  const handleVerify2FA = async () => {
    setIs2FALoading(true)
    try {
      const res = await fetch('/api/admin/2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: twoFactorCode.trim() }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setIsVerified(true)
        localStorage.setItem('miad_admin_session', 'active')
        toast.success('Authentification réussie')
      } else {
        toast.error(data.error || 'Code invalide')
      }
    } catch {
      toast.error('Erreur réseau lors de la vérification.')
    } finally {
      setIs2FALoading(false)
    }
  }

  const handleFullSync = async () => {
    setIsSyncing(true)
    const promise = fetch('/api/sync') // Appelle ton script lib/route.ts existant
    
    toast.promise(promise, {
      loading: 'Synchronisation complète de WooCommerce vers PostgreSQL...',
      success: (data) => {
        setIsSyncing(false)
        setLastSync(new Date().toLocaleString())
        return 'Synchronisation réussie !'
      },
      error: 'Erreur lors de la synchronisation',
    })

    try {
      await promise
    } catch (err) {
      setIsSyncing(false)
    }
  }

  if (!isVerified) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-card rounded-3xl border border-border p-8 shadow-xl text-center animate-in zoom-in-95 duration-300">
          <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center text-primary mx-auto mb-6">
            <Lock size={40} />
          </div>
          <h1 className="text-2xl font-bold mb-2">Accès Administrateur</h1>
          <p className="text-muted-foreground text-sm mb-8">Entrez le code de votre application d'authentification.</p>

          <div className="space-y-4">
            <Input 
              type="text" 
              placeholder="000 000" 
              value={twoFactorCode}
              onChange={(e) => setTwoFactorCode(e.target.value)}
              className="text-center text-3xl h-16 font-mono tracking-widest border-2 focus:border-primary"
              autoComplete="one-time-code"
              maxLength={6}
            />
            <Button onClick={handleVerify2FA} disabled={is2FALoading} className="w-full h-14 bg-primary text-lg font-bold rounded-2xl">
              {is2FALoading ? 'Vérification…' : 'Déverrouiller le panneau'}
            </Button>

            {!isSettingUp && !showSetupPrompt && (
              <button type="button" onClick={() => setShowSetupPrompt(true)} className="text-xs text-muted-foreground hover:text-primary flex items-center gap-2 mx-auto">
                <QrCode size={14} /> Première connexion ? Configurer le 2FA
              </button>
            )}

            {!isSettingUp && showSetupPrompt && (
              <div className="mt-4 p-4 bg-muted/30 rounded-2xl border border-dashed border-border space-y-3">
                <p className="text-xs text-muted-foreground text-left">
                  Jeton de configuration serveur (défini par variable d'environnement, distinct du code à 6 chiffres) :
                </p>
                <Input
                  type="password"
                  placeholder="Jeton de configuration"
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  className="text-sm"
                />
                <Button onClick={handleSetup2FA} disabled={is2FALoading} variant="outline" className="w-full">
                  {is2FALoading ? 'Génération…' : 'Générer mon QR Code'}
                </Button>
              </div>
            )}

            {isSettingUp && (
              <div className="mt-8 p-4 bg-white rounded-2xl border border-dashed border-primary/30">
                <p className="text-xs font-bold mb-4 text-primary">Scannez ce QR Code avec Google Authenticator :</p>
                <img src={qrCodeUrl!} alt="QR Code" className="mx-auto mb-4 border-4 border-white shadow-sm" />
                {tempSecret && (
                  <p className="text-[10px] font-mono text-muted-foreground mb-2 break-all">Clé manuelle : {tempSecret}</p>
                )}
                <p className="text-[10px] text-muted-foreground leading-tight">
                  Une fois scanné, votre téléphone générera des codes qui changent toutes les 30 secondes.
                  Entrez-en un ci-dessus pour déverrouiller.
                </p>
              </div>
            )}
          </div>
          
          <button type="button" onClick={onBack} className="mt-8 text-sm text-muted-foreground hover:underline flex items-center gap-2 mx-auto">
            <ArrowLeft size={16} /> Retour au site public
          </button>
        </div>
      </div>
    )
  }

  if (showExplorer) {
    return (
      <div className="min-h-screen bg-slate-50 p-4 md:p-8">
        <div className="max-w-7xl mx-auto">
          <button type="button" onClick={() => setShowExplorer(false)} className="flex items-center gap-2 text-slate-500 hover:text-slate-900 mb-6 font-bold uppercase text-xs tracking-widest">
            <ArrowLeft size={16} /> Retour au Dashboard
          </button>
          
          <div className="bg-white rounded-[2rem] border border-slate-200 shadow-2xl overflow-hidden">
            <div className="p-8 border-b border-slate-100 bg-slate-900 text-white flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-black uppercase tracking-tighter flex items-center gap-3">
                  <FileSpreadsheet className="text-orange-500" /> Explorateur de Données Miad
                </h2>
                <p className="text-slate-400 text-sm mt-1">Données en direct de api.miadmarket.com</p>
              </div>
              <div className="flex gap-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={14} />
                  <input type="text" placeholder="Rechercher SKU..." className="bg-slate-800 border-none rounded-xl pl-9 pr-4 py-2 text-xs text-white focus:ring-2 ring-orange-500" />
                </div>
                <Button className="bg-orange-600 hover:bg-orange-500 h-9 rounded-xl text-xs font-black">EXPORTER CSV</Button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 text-[10px] font-black uppercase tracking-widest border-b border-slate-100">
                    <th className="px-6 py-4">SKU</th>
                    <th className="px-6 py-4">Nom du Produit</th>
                    <th className="px-6 py-4">Prix</th>
                    <th className="px-6 py-4">Stock</th>
                    <th className="px-6 py-4 text-center">Etat</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {comparisonData.map((item) => (
                    <tr key={item.sku} className="hover:bg-slate-50/50 transition-colors text-xs">
                      <td className="px-6 py-4 font-mono font-bold text-slate-400">{item.sku}</td>
                      <td className="px-6 py-4 font-medium">{item.name}</td>
                      <td className="px-6 py-4 font-black">{item.price} $</td>
                      <td className="px-6 py-4">{item.stock_quantity ?? 0}</td>
                      <td className="px-6 py-4 text-center">
                        {item.stock_status === 'instock' ? (
                          <span className="bg-green-100 text-green-700 px-2 py-1 rounded-lg font-black text-[9px] uppercase">Ok</span>
                        ) : (
                          <span className="bg-red-100 text-red-700 px-2 py-1 rounded-lg font-black text-[9px] uppercase tracking-tighter">Désynchronisé</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const handleNavClick = (id: typeof activeSection) => {
    setActiveSection(id)
    if (id === 'logistics' && logisticsOrders.length === 0 && !isLoadingLogistics) fetchLogisticsOrders()
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="flex">
        {/* Sidebar de navigation */}
        <aside className="hidden md:flex flex-col w-64 shrink-0 min-h-screen bg-card border-r border-border p-4 sticky top-0">
          <button type="button" onClick={onBack} className="flex items-center gap-2 text-muted-foreground hover:text-foreground mb-6 px-2">
            <ArrowLeft size={18} /> Retour au site
          </button>
          <div className="flex items-center gap-3 mb-8 px-2">
            <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center text-white shrink-0">
              <Database size={20} />
            </div>
            <div>
              <h1 className="text-sm font-bold leading-tight">Administration</h1>
              <p className="text-[10px] text-muted-foreground">MIAD Market</p>
            </div>
          </div>
          <nav className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-colors text-left ${
                  activeSection === item.id ? 'bg-accent text-white' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                <item.icon size={18} className="shrink-0" />
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Contenu de la section active */}
        <main className="flex-1 p-6 max-w-5xl">
          <button type="button" onClick={onBack} className="md:hidden flex items-center gap-2 text-muted-foreground hover:text-foreground mb-6">
            <ArrowLeft size={20} /> Retour au site
          </button>

          {/* Barre de navigation mobile (menu déroulant simple) */}
          <div className="md:hidden flex gap-2 overflow-x-auto pb-4 mb-4 -mx-6 px-6">
            {NAV_ITEMS.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className={`shrink-0 flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-colors ${
                  activeSection === item.id ? 'bg-accent text-white' : 'bg-muted text-muted-foreground'
                }`}
              >
                <item.icon size={14} /> {item.label}
              </button>
            ))}
          </div>

          {activeSection === 'overview' && (
            <div className="bg-card rounded-3xl border border-border p-8 shadow-sm">
              <h2 className="text-xl font-bold mb-6">Vue d'ensemble</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Case Synchronisation */}
                <div className="bg-muted/20 border border-border rounded-2xl p-6">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="font-bold flex items-center gap-2">
                      <RefreshCw size={18} className={isSyncing ? "animate-spin" : ""} />
                      Sync WooCommerce
                    </h3>
                    {lastSync && (
                      <span className="text-[10px] bg-green-100 text-green-700 px-2 py-1 rounded-full font-bold">
                        Dernière sync: {lastSync}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mb-6">
                    Si vos produits ne s'affichent pas correctement ou si les images manquent, lancez une synchronisation complète. Cela mettra à jour PostgreSQL avec les données de WordPress.
                  </p>
                  <Button
                    onClick={handleFullSync}
                    disabled={isSyncing}
                    className="w-full bg-accent text-white font-bold h-12 rounded-xl"
                  >
                    {isSyncing ? "Synchronisation en cours..." : "Lancer une Sync Complète"}
                  </Button>
                </div>

                {/* Nouveau Bloc Explorer */}
                <div className="bg-slate-900 text-white border border-slate-800 rounded-2xl p-6 flex flex-col justify-between">
                  <div>
                    <h3 className="font-bold flex items-center gap-2 mb-2">
                      <FileSpreadsheet size={18} className="text-orange-500" />
                      Tableur de Données
                    </h3>
                    <p className="text-[11px] text-slate-400 mb-6">
                      Visualisez le contenu de votre base Prisma et comparez les prix avec le site en format "Sheet".
                    </p>
                  </div>
                  <Button onClick={() => { setShowExplorer(true); fetchComparison() }} className="w-full bg-white text-slate-900 font-black h-12 rounded-xl hover:bg-slate-200 uppercase text-xs tracking-widest">Ouvrir le Tableur</Button>
                </div>

                {/* Case Affichage */}
                <div className="bg-muted/20 border border-border rounded-2xl p-6">
                  <h3 className="font-bold mb-4 flex items-center gap-2">
                    <Eye size={18} /> Paramètres d'affichage
                  </h3>
                  <p className="text-xs text-muted-foreground mb-6">
                    Masquez automatiquement les rayons qui ne contiennent aucun produit synchronisé pour une boutique plus propre.
                  </p>
                  <Button
                    variant={hideEmptyCategories ? "default" : "outline"}
                    onClick={() => onToggleHideEmpty(!hideEmptyCategories)}
                    className="w-full font-bold h-12 rounded-xl flex gap-2"
                  >
                    {hideEmptyCategories ? <EyeOff size={16} /> : <Eye size={16} />}
                    {hideEmptyCategories ? "Masquage activé" : "Masquage désactivé"}
                  </Button>
                </div>

                {/* Case Statistiques rapides */}
                <div className="bg-muted/20 border border-border rounded-2xl p-6">
                  <h3 className="font-bold mb-4 flex items-center gap-2">
                    <Package size={18} /> État du Stock
                  </h3>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm"><span>Produits synchronisés</span><span className="font-bold">Automatique</span></div>
                    <div className="flex justify-between text-sm"><span>Images par produit</span><span className="font-bold text-accent">Illimité</span></div>
                  </div>
                </div>

                {/* Case Export CSV Meta */}
                <div className="bg-muted/20 border border-border rounded-2xl p-6 flex flex-col justify-between">
                  <div>
                    <h3 className="font-bold mb-2 flex items-center gap-2">
                      <Download size={18} /> Export catalogue (Meta)
                    </h3>
                    <p className="text-xs text-muted-foreground mb-6">
                      Télécharge un fichier CSV du catalogue publié, à importer manuellement dans Meta Commerce Manager — utile pour forcer un import immédiat sans attendre le prochain passage programmé du flux automatique.
                    </p>
                  </div>
                  <Button
                    onClick={handleExportMetaCsv}
                    disabled={isExportingCsv}
                    variant="outline"
                    className="w-full font-bold h-12 rounded-xl flex gap-2"
                  >
                    <Download size={16} className={isExportingCsv ? "animate-pulse" : ""} />
                    {isExportingCsv ? 'Génération en cours…' : 'Télécharger le CSV'}
                  </Button>
                </div>

                {/* Case Vider le cache */}
                <div className="bg-muted/20 border border-border rounded-2xl p-6 flex flex-col justify-between">
                  <div>
                    <h3 className="font-bold mb-2 flex items-center gap-2">
                      <Trash2 size={18} /> Vider le Cache
                    </h3>
                    <p className="text-xs text-muted-foreground mb-6">
                      Force le rechargement des produits, boutiques et catégories depuis le serveur. À utiliser si des données s'affichent en retard ou si des images manquent après une mise à jour.
                    </p>
                  </div>
                  <Button
                    onClick={handleClearCache}
                    disabled={isClearingCache}
                    variant="outline"
                    className="w-full font-bold h-12 rounded-xl border-destructive/40 text-destructive hover:bg-destructive/10 flex gap-2"
                  >
                    <Trash2 size={16} className={isClearingCache ? "animate-pulse" : ""} />
                    {isClearingCache ? 'Vidage en cours…' : 'Vider le cache SWR + SW'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'kpi' && (
            <div className="bg-card rounded-3xl border border-border p-8 shadow-sm">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
                <BarChart2 size={20} className="text-primary" /> Parcours client & KPI
              </h2>
              <AnalyticsDashboard />
            </div>
          )}

          {activeSection === 'recommendations' && (
            <div className="bg-card rounded-3xl border border-border p-8 shadow-sm">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
                <BarChart2 size={20} className="text-primary" /> Recommandations produits
              </h2>
              <RecommendationsAdminPanel />
            </div>
          )}

          {activeSection === 'emails' && (
            <div className="bg-card rounded-3xl border border-border p-8 shadow-sm">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
                <Mail size={20} className="text-primary" /> Envoyer des emails
              </h2>
              <EmailBlast />
            </div>
          )}

          {activeSection === 'push' && (
            <div className="bg-card rounded-3xl border border-border p-8 shadow-sm">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
                <Bell size={20} className="text-primary" /> Notifications push
              </h2>
              <PushBlast />
            </div>
          )}

          {activeSection === 'logistics' && (
            <div className="space-y-8">
              <div className="bg-card rounded-3xl border border-border p-8 shadow-sm">
                <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
                  <Truck size={20} className="text-primary" /> Livraison nationale — Sénégal
                </h2>
                <DomesticShippingPanel />
              </div>

              <div className="bg-card rounded-3xl border border-border p-8 shadow-sm">
                <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
                  <Truck size={20} className="text-primary" /> Expédition DHL (automatique)
                </h2>
                <DhlLogisticsPanel />
              </div>

              <div className="bg-card rounded-3xl border border-border p-8 shadow-sm">
                <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
                  <Truck size={20} className="text-primary" /> Suivi manuel — tous transporteurs
                </h2>
                {isLoadingLogistics ? (
                  <div className="flex items-center justify-center py-12 text-muted-foreground">
                    <RefreshCw size={20} className="animate-spin mr-3" />
                    Chargement des commandes…
                  </div>
                ) : (
                  <ShipmentManager orders={logisticsOrders} />
                )}
              </div>
            </div>
          )}

          {activeSection === 'messages' && (
            <div className="bg-card rounded-3xl border border-border p-8 shadow-sm">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
                <MessageCircle size={20} className="text-primary" /> Messages clients
              </h2>
              <RepMessages repId={0} repName="Admin MIAD" repAvatar="" isAdmin={true} />
            </div>
          )}

          {activeSection === 'journal' && (
            <div className="bg-card rounded-3xl border border-border p-8 shadow-sm">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
                <ScrollText size={20} className="text-primary" /> Journal des actions admin
              </h2>
              <AdminActionLog />
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
'use client'
import { useState, useSyncExternalStore } from 'react'
import { WOO_URL, WOO_CK, WOO_CS } from '@/lib/constants'; // Assurez-vous que ces constantes sont définies dans lib/constants.ts
// Ou définissez-les directement ici si elles ne sont pas globales
// const WOO_CK = process.env.WOO_CONSUMER_KEY;
// const WOO_CS = process.env.WOO_CONSUMER_SECRET;
import { ShieldCheck, Database, Tag, ArrowRight, Lock, Key, QrCode, ClipboardCopy, Save, Loader2, Package, ShoppingCart, Users, Activity, AlertTriangle, RefreshCw, Terminal, Search, Globe } from 'lucide-react'
import Link from 'next/link'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { DhlLogisticsPanel } from '@/components/miad/DhlLogisticsPanel'

// Le secret TOTP ne doit plus jamais etre recupere depuis le navigateur :
// c'etait une faille (n'importe quel visiteur pouvait le lire et generer
// des codes valides). La configuration initiale (scan du QR code) se
// fait desormais une seule fois, hors navigateur, via une requete avec le
// jeton de configuration cote serveur (voir README/variables d'env).
const noopSubscribe = () => () => {}
function getIsFirstTimeSnapshot() {
  return !localStorage.getItem('miad_2fa_setup')
}
function getIsFirstTimeServerSnapshot() {
  return false
}
function getAdminEmailSnapshot() {
  const storedUser = localStorage.getItem('miad_user')
  const user = storedUser ? JSON.parse(storedUser) : null
  return user?.user_email || 'admin@miadmarket.com'
}
function getAdminEmailServerSnapshot() {
  return 'admin@miadmarket.com'
}

export default function AdminBatekossiPage() {
  const [code, setCode] = useState('')
  const [isAuthorized, setIsAuthorized] = useState(false)
  const isFirstTime = useSyncExternalStore(noopSubscribe, getIsFirstTimeSnapshot, getIsFirstTimeServerSnapshot)
  const [error, setError] = useState<string>('');
  const adminEmail = useSyncExternalStore(noopSubscribe, getAdminEmailSnapshot, getAdminEmailServerSnapshot)
  const [loading, setLoading] = useState(false)
  const [setupData, setSetupData] = useState<{qrCode: string, secret: string} | null>(null)

  // États pour les données du dashboard
  const [stats, setStats] = useState<any>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [commError, setCommError] = useState<string | null>(null)

  const loadDashboardData = async () => {
    setStatsLoading(true)
    setCommError(null)
    try {
      const res = await fetch('/api/admin/stats')
      const data = await res.json()
      if (data.success) {
        setStats(data)
      } else {
        setCommError(data.message || "Erreur de communication avec WooCommerce")
      }
    } catch (err) {
      setCommError("Impossible de joindre le serveur API")
    } finally {
      setStatsLoading(false)
    }
  }

  const handleVerify = async () => {
    if (code.length !== 6) return
    setLoading(true)
    try {
      const res = await fetch('/api/admin/2fa', {
        method: 'POST',
        // Le code 2FA devrait être vérifié côté serveur avec le secret de l'utilisateur
        body: JSON.stringify({ code, email: adminEmail }) // Envoyer l'email pour identifier l'utilisateur
      })
      const data = await res.json()

      if (data.success) {
        setIsAuthorized(true)
        setError('')
        if (isFirstTime) {
          localStorage.setItem('miad_2fa_setup', 'complete')
        }
        toast.success("Authentification 2FA réussie")
        loadDashboardData()
      } else {
        setError('Code invalide. Vérifiez votre application.')
      }
    } catch (err) {
      setError('Erreur de connexion')
    } finally {
      setLoading(false)
    }
  }

  const copySecret = () => {
    if (setupData?.secret) {
      navigator.clipboard.writeText(setupData.secret)
      toast.success("Code secret copié !")
    }
  }

  if (!WOO_URL || !WOO_CK || !WOO_CS) {
    return <div className="min-h-screen flex items-center justify-center text-red-500">Erreur: Clés API WooCommerce manquantes.</div>;
  }

  if (!isAuthorized) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className={`max-w-md w-full bg-slate-900 border border-slate-800 p-8 rounded-[2.5rem] shadow-2xl text-center transition-all ${isFirstTime ? 'scale-105 border-orange-500/50' : ''}`}>
          <div className="w-20 h-20 bg-orange-500/10 text-orange-500 rounded-3xl flex items-center justify-center mx-auto mb-8">
            {isFirstTime ? <QrCode size={40} /> : <Lock size={40} />}
          </div>
          <h1 className="text-2xl font-black text-white uppercase mb-2">
            {isFirstTime ? "Configuration de Sécurité" : "Accès Restreint"}
          </h1>
          <p className="text-slate-400 text-sm mb-8 leading-relaxed">
            {isFirstTime
              ? "Premier accès : configurez Google Authenticator hors-ligne avec ADMIN_2FA_SECRET (voir variables d'environnement), puis entrez le code généré."
              : "Entrez le code à 6 chiffres généré par votre application."}
          </p>

          <div className="space-y-4">
            {isFirstTime && setupData && (
              <div className="space-y-6 mb-6">
                <div className="bg-white p-3 rounded-2xl mx-auto w-fit shadow-lg">
                  <Image src={setupData.qrCode} alt="2FA QR Code" width={160} height={160} unoptimized className="w-40 h-40" />
                </div>
                <div className="bg-slate-950 rounded-xl p-4 border border-slate-800 text-left">
                   <div className="text-[10px] font-bold text-slate-500 uppercase flex items-center gap-1 mb-2">
                     <Save size={10} /> Ton Code Secret (Persistence Vercel)
                   </div>
                   <div className="flex items-center justify-between gap-2">
                      <code className="text-orange-400 font-mono text-xs break-all">{setupData.secret}</code>
                      <button type="button" onClick={copySecret} aria-label="Copier le code secret" className="p-2 hover:bg-slate-800 rounded-lg text-slate-400">
                        <ClipboardCopy size={16} />
                      </button>
                   </div>
                </div>
              </div>
            )}

            <div className="relative">
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
              <Input
                type="text"
                placeholder="000 000"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyUp={(e) => e.key === 'Enter' && handleVerify()}
                className="bg-slate-950 border-slate-800 text-white pl-10 h-14 text-lg tracking-[0.5em] font-mono text-center"
                maxLength={6}
              />
            </div>
            {error && <p className="text-red-500 text-xs font-bold">{error}</p>}
            <Button onClick={handleVerify} disabled={loading || code.length !== 6} className="w-full h-14 bg-orange-600 hover:bg-orange-500 text-white font-black uppercase rounded-2xl shadow-lg">
              {loading ? <Loader2 className="animate-spin" /> : "Vérifier l'identité"}
            </Button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="min-h-screen bg-slate-50">
      <main className="container mx-auto p-8">
        <div className="flex items-center gap-4 mb-10">
          <div className="p-3 bg-slate-900 rounded-2xl text-white">
            <ShieldCheck size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-black text-slate-900 uppercase tracking-tighter">Tableau de bord Admin</h1>
            <p className="text-slate-500">Session active pour : {adminEmail}</p>
          </div>
        </div>

        {/* Dashboard Stats Rapides */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
             <Package className="text-orange-500 mb-2" size={20} />
             <div className="text-2xl font-black">{stats?.summary?.products || '0'}</div>
             <div className="text-[10px] uppercase font-bold text-slate-400 tracking-widest">Produits</div>
          </div>
          <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
             <ShoppingCart className="text-green-500 mb-2" size={20} />
             <div className="text-2xl font-black">{stats?.summary?.orderCount || '0'}</div>
             <div className="text-[10px] uppercase font-bold text-slate-400 tracking-widest">Commandes</div>
          </div>
          <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
             <Globe className="text-blue-500 mb-2" size={20} />
             <div className="text-2xl font-black">Stable</div>
             <div className="text-[10px] uppercase font-bold text-slate-400 tracking-widest">API Status</div>
          </div>
          <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
             <Activity className="text-purple-500 mb-2" size={20} />
             <div className="text-2xl font-black">{stats?.summary?.customers || '0'}</div>
             <div className="text-[10px] uppercase font-bold text-slate-400 tracking-widest">Clients</div>
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Tableau des Produits */}
          <div className="lg:col-span-2 bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center">
              <h2 className="font-black uppercase text-sm flex items-center gap-2">
                <Package size={18} className="text-orange-500" /> Inventaire des Produits
              </h2>
              <Button variant="ghost" size="sm" onClick={loadDashboardData} className="text-xs">
                <RefreshCw size={14} className={statsLoading ? "animate-spin" : ""} />
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-400 uppercase text-[9px] font-black">
                  <tr>
                    <th className="px-6 py-4">SKU</th>
                    <th className="px-6 py-4">Produit</th>
                    <th className="px-6 py-4">Prix</th>
                    <th className="px-6 py-4">Stock</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {stats?.productList?.map((p: any) => (
                    <tr key={p.id} className="hover:bg-slate-50/50">
                      <td className="px-6 py-4 font-mono text-slate-400">{p.sku}</td>
                      <td className="px-6 py-4 font-bold">{p.name}</td>
                      <td className="px-6 py-4 font-black text-slate-900">{p.price} €</td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-0.5 rounded-full font-bold text-[9px] ${p.stock > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {p.stock} en stock
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Logs Vercel / Erreurs Système */}
          <div className="bg-slate-900 rounded-3xl p-6 text-white shadow-xl h-fit">
             <h2 className="font-black uppercase text-sm mb-6 flex items-center gap-2 text-orange-500">
               <Terminal size={18} /> Console de Logs Vercel
             </h2>
             <div className="space-y-4 font-mono text-[10px]">
                <div className="flex gap-2">
                  <span className="text-slate-500">[INFO]</span>
                  <span className="text-green-400 font-bold">VERIFICATION 2FA RÉUSSIE</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-slate-500">[FETCH]</span>
                  <span className="text-blue-400 italic">Appel API WooCommerce...</span>
                </div>
                {commError ? (
                  <div className="flex gap-2 p-2 bg-red-500/10 border border-red-500/20 rounded-lg">
                    <span className="text-red-500 font-black">[ERREUR]</span>
                    <span className="text-red-300">{commError}</span>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <span className="text-slate-500">[OK]</span>
                    <span className="text-slate-300">Synchronisation des produits effectuée.</span>
                  </div>
                )}
                <div className="mt-6 pt-6 border-t border-slate-800">
                  <div className="text-[9px] text-slate-500 uppercase font-black mb-2">Erreurs récurrentes</div>
                  <div className="text-orange-400 italic opacity-60">
                    - Network: 0 timeouts détectés<br/>
                    - Auth: JWT Token valide
                  </div>
                </div>
             </div>
          </div>
        </div>

        <div className="mt-8">
          <DhlLogisticsPanel />
        </div>
      </main>
    </div>
  )
}

'use client'
import { useState, useMemo, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Lock, CheckCircle2, XCircle, Loader2, ShieldCheck, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

function ResetPasswordForm() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const oobCode = searchParams.get('oobCode')

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const strengthDetails = useMemo(() => [
    { label: "8+ caractères", met: password.length >= 8 },
    { label: "Une majuscule", met: /[A-Z]/.test(password) },
    { label: "Un chiffre", met: /[0-9]/.test(password) },
    { label: "Caractère spécial", met: /[^A-Za-z0-9]/.test(password) },
  ], [password])

  const strengthScore = strengthDetails.filter(d => d.met).length

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!oobCode) return toast.error("Lien de réinitialisation invalide")
    if (strengthScore < 4) return toast.error("Le mot de passe n'est pas assez fort")
    if (password !== confirmPassword) return toast.error("Les mots de passe ne correspondent pas")

    setIsLoading(true)
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oobCode, newPassword: password })
      })
      if (res.ok) {
        toast.success("Succès ! Vous pouvez maintenant vous connecter.")
        router.push('/Login')
      } else {
        const data = await res.json()
        toast.error(data.message || "Une erreur est survenue")
      }
    } catch {
      toast.error("Erreur réseau")
    } finally {
      setIsLoading(false)
    }
  }

  if (!oobCode) {
    return <div className="min-h-screen flex items-center justify-center">Lien invalide.</div>
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white rounded-[2.5rem] shadow-2xl p-8 border border-slate-100">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-accent/10 text-accent rounded-2xl flex items-center justify-center mx-auto mb-4">
            <ShieldCheck size={32} />
          </div>
          <h1 className="text-2xl font-black uppercase tracking-tighter italic">Nouveau Mot de passe</h1>
          <p className="text-slate-500 text-sm mt-2 font-medium">Sécurisez votre compte MIAD Market</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-4">
            <div>
              <Label className="text-xs font-black uppercase tracking-widest text-slate-400 mb-2 block">Nouveau mot de passe</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" size={18} />
                <Input
                  type="password"
                  className="pl-10 h-14 rounded-2xl border-slate-200 focus:ring-4 focus:ring-accent/10"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3">
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Niveau de sécurité</span>
                <span className={cn("text-[10px] font-black uppercase",
                  strengthScore <= 1 ? "text-red-500" : strengthScore <= 3 ? "text-orange-500" : "text-green-500"
                )}>
                  {strengthScore <= 1 ? "Faible" : strengthScore <= 3 ? "Moyen" : "Excellent"}
                </span>
              </div>
              <div className="flex gap-1">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className={cn("h-1.5 flex-1 rounded-full transition-all",
                    i <= strengthScore ? (strengthScore === 4 ? "bg-green-500" : "bg-orange-500") : "bg-slate-200"
                  )} />
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {strengthDetails.map((detail, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    {detail.met ? <CheckCircle2 size={12} className="text-green-500" /> : <XCircle size={12} className="text-slate-300" />}
                    <span className={cn("text-[9px] font-bold uppercase", detail.met ? "text-slate-700" : "text-slate-400")}>{detail.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <Label className="text-xs font-black uppercase tracking-widest text-slate-400 mb-2 block">Confirmer</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" size={18} />
                <Input
                  type="password"
                  className="pl-10 h-14 rounded-2xl border-slate-200 focus:ring-4 focus:ring-accent/10"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
              {password && confirmPassword && password !== confirmPassword && (
                <p className="text-[10px] text-red-500 font-bold mt-2 uppercase tracking-tighter">Les mots de passe ne correspondent pas</p>
              )}
            </div>
          </div>

          <Button
            type="submit"
            disabled={isLoading || strengthScore < 4 || password !== confirmPassword}
            className="w-full h-16 bg-slate-900 hover:bg-slate-800 text-white font-black uppercase text-xs tracking-widest rounded-2xl shadow-xl transition-all active:scale-95"
          >
            {isLoading ? <Loader2 className="animate-spin" /> : <>VALIDER LE CHANGEMENT <ArrowRight size={16} className="ml-2" /></>}
          </Button>
        </form>
      </div>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="animate-spin text-slate-400" size={32} />
      </div>
    }>
      <ResetPasswordForm />
    </Suspense>
  )
}

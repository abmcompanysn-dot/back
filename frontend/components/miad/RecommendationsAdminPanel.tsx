"use client"

import { useState } from 'react'
import useSWR from 'swr'
import { RefreshCw, Sparkles, Mail, AlertTriangle, LayoutGrid, List } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface StatusData {
  lastRun: string | null
  ordersScanned: number
  totalPairRows: number
  error?: string
  wpStatus?: number
  wpBody?: string
}

interface PreviewEntry {
  email: string
  name: string
  products: string[]
}

interface PreviewData {
  sent: number
  skipped: number
  totalCustomers: number
  preview: PreviewEntry[]
  error?: string
  wpStatus?: number
  wpBody?: string
}

function formatWpError(data: { error?: string; wpStatus?: number; wpBody?: string }): string {
  if (!data.error) return ''
  const detail = data.wpStatus || data.wpBody
    ? ` (${data.wpStatus ? `WP HTTP ${data.wpStatus}` : ''}${data.wpBody ? ` — ${data.wpBody.slice(0, 300)}` : ''})`
    : ''
  return `${data.error}${detail}`
}

const fetchStatusData = async (url: string): Promise<StatusData> => {
  try {
    const token = localStorage.getItem('miad_token')
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: 'no-store',
    })
    return await res.json()
  } catch {
    return { lastRun: null, ordersScanned: 0, totalPairRows: 0, error: 'Impossible de charger le statut.' }
  }
}

export function RecommendationsAdminPanel() {
  const { data: status, isLoading: isLoadingStatus, mutate: refetchStatus } = useSWR<StatusData>(
    '/api/recommendations/admin',
    fetchStatusData
  )
  const [isRecomputing, setIsRecomputing] = useState(false)
  const [isSendingEmails, setIsSendingEmails] = useState(false)
  const [confirmSendEmails, setConfirmSendEmails] = useState(false)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [previewData, setPreviewData] = useState<PreviewData | null>(null)
  const [template, setTemplate] = useState<'grid' | 'list'>('grid')

  const handleRecompute = async () => {
    setIsRecomputing(true)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch('/api/recommendations/admin', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = await res.json()
      if (data.error) {
        toast.error(data.error)
      } else {
        toast.success(`Recalcul terminé — ${data.orders_scanned ?? 0} commandes analysées, ${data.pairs_found ?? 0} paires trouvées.`)
      }
      await refetchStatus()
    } catch {
      toast.error('Erreur lors du recalcul.')
    } finally {
      setIsRecomputing(false)
    }
  }

  const handleSendEmails = async () => {
    if (!confirmSendEmails) {
      setIsLoadingPreview(true)
      try {
        const token = localStorage.getItem('miad_token')
        const res = await fetch(`/api/recommendations/send-emails/preview?template=${template}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: 'no-store',
        })
        const data = await res.json()
        if (data.error) {
          toast.error(formatWpError(data), { duration: 15000 })
        } else {
          setPreviewData(data)
          setConfirmSendEmails(true)
        }
      } catch {
        toast.error("Erreur lors de l'aperçu.")
      } finally {
        setIsLoadingPreview(false)
      }
      return
    }
    setIsSendingEmails(true)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch(`/api/recommendations/send-emails?template=${template}`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = await res.json()
      if (data.error) {
        toast.error(formatWpError(data), { duration: 15000 })
      } else {
        const failedPart = data.failed ? `, ${data.failed} échec(s) d'envoi` : ''
        const message = `${data.sent ?? 0} email(s) envoyé(s)${failedPart}, ${data.skipped ?? 0} client(s) sans recommandation disponible (sur ${data.totalCustomers ?? 0} au total).`
        if (data.failed > 0) {
          toast.warning(message)
        } else {
          toast.success(message)
        }
      }
    } catch {
      toast.error("Erreur lors de l'envoi des emails.")
    } finally {
      setIsSendingEmails(false)
      setConfirmSendEmails(false)
      setPreviewData(null)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Calcule "Achetés ensemble" à partir des vraies commandes WooCommerce (relance automatique tous les jours).
      </p>
      {isLoadingStatus ? (
        <p className="text-xs text-muted-foreground">Chargement du statut…</p>
      ) : status?.error ? (
        <div className="text-xs text-destructive space-y-1">
          <p>{status.error}</p>
          {(status.wpStatus || status.wpBody) && (
            <p className="text-[10px] text-destructive/70 break-all">
              {status.wpStatus ? `WP HTTP ${status.wpStatus}` : ''}{status.wpBody ? ` — ${status.wpBody.slice(0, 300)}` : ''}
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-muted/30 rounded-xl p-3 text-center border border-border" suppressHydrationWarning>
            <p className="text-sm font-black">{status?.lastRun ? new Date(status.lastRun + 'Z').toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : 'Jamais'}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Dernier calcul</p>
          </div>
          <div className="bg-muted/30 rounded-xl p-3 text-center border border-border">
            <p className="text-lg font-black">{status?.ordersScanned ?? 0}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Commandes analysées</p>
          </div>
          <div className="bg-muted/30 rounded-xl p-3 text-center border border-border">
            <p className="text-lg font-black">{status?.totalPairRows ?? 0}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Paires en base</p>
          </div>
        </div>
      )}
      <Button onClick={handleRecompute} disabled={isRecomputing} className="w-full gap-2">
        <Sparkles size={16} className={isRecomputing ? 'animate-pulse' : ''} />
        {isRecomputing ? 'Recalcul en cours…' : 'Recalculer maintenant'}
      </Button>

      <div className="pt-4 border-t border-border space-y-3">
        <p className="text-xs text-muted-foreground">
          Envoie à chaque client ayant déjà commandé un email avec SES produits recommandés personnalisés (pas le même email pour tout le monde).
        </p>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => !confirmSendEmails && setTemplate('grid')}
            disabled={confirmSendEmails}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold transition-colors disabled:opacity-50 ${template === 'grid' ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-background hover:bg-muted'}`}
          >
            <LayoutGrid size={13} /> Grille catalogue
          </button>
          <button
            type="button"
            onClick={() => !confirmSendEmails && setTemplate('list')}
            disabled={confirmSendEmails}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold transition-colors disabled:opacity-50 ${template === 'list' ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-background hover:bg-muted'}`}
          >
            <List size={13} /> Liste classique
          </button>
        </div>

        {confirmSendEmails && previewData && (
          <div className="space-y-2">
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <p className="text-xs font-bold">
                {previewData.sent} client{previewData.sent > 1 ? 's' : ''} vont recevoir un vrai email
                {previewData.skipped > 0 ? ` (${previewData.skipped} sans recommandation disponible, ignorés)` : ''}.
                Clique à nouveau pour confirmer, ou ignore ce message pour annuler.
              </p>
            </div>
            {previewData.preview.length > 0 && (
              <div className="max-h-48 overflow-y-auto rounded-xl border border-border divide-y divide-border">
                {previewData.preview.map((entry, i) => (
                  <div key={i} className="px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold">{entry.name}</span>
                      <span className="text-muted-foreground">{entry.email}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{entry.products.join(', ')}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <Button
          onClick={handleSendEmails}
          disabled={isSendingEmails || isLoadingPreview}
          variant={confirmSendEmails ? 'default' : 'outline'}
          className={`w-full gap-2 ${confirmSendEmails ? 'bg-amber-600 hover:bg-amber-700' : ''}`}
        >
          <Mail size={16} className={(isSendingEmails || isLoadingPreview) ? 'animate-pulse' : ''} />
          {isSendingEmails ? 'Envoi en cours…' : isLoadingPreview ? 'Chargement de l\'aperçu…' : confirmSendEmails ? 'Confirmer l\'envoi' : 'Envoyer les recommandations par email'}
        </Button>
      </div>
    </div>
  )
}

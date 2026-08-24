"use client"

import { useEffect, useState } from 'react'
import { CreditCard, Trash2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

interface SavedCard {
  id: string
  brand: string
  last4: string
  expMonth: number
  expYear: number
}

const BRAND_LABELS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
}

// Gestion des cartes enregistrées en dehors du checkout (voir aussi
// SavedCardPicker.tsx, utilisé lui au moment de payer — même API
// /api/payment-methods, UI différente car ici pas de notion de "sélection").
export function PaymentMethodsSection({ token }: { token: string | null }) {
  const [cards, setCards] = useState<SavedCard[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    if (!token) { setIsLoading(false); return }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/payment-methods', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json().catch(() => null)
        if (!cancelled && data?.success) setCards(data.paymentMethods || [])
      } catch {
        // Silencieux : la section affichera juste "aucune carte enregistrée".
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [token])

  const handleDelete = async (id: string) => {
    if (!token) return
    if (!window.confirm('Supprimer cette carte enregistrée ?')) return
    setDeletingId(id)
    try {
      const res = await fetch('/api/payment-methods', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethodId: id }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.success) throw new Error(data?.error || 'Échec de la suppression')
      setCards(prev => prev.filter(c => c.id !== id))
      toast.success('Carte supprimée.')
    } catch (e: any) {
      toast.error(e.message || 'Impossible de supprimer cette carte.')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="p-6 border-b border-border">
        <h2 className="font-bold text-foreground text-lg">Moyens de paiement</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Cartes enregistrées lors d'un paiement par carte (case "Enregistrer cette carte" au checkout).
        </p>
      </div>

      <div className="p-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm font-bold text-muted-foreground py-4">
            <Loader2 size={16} className="animate-spin" /> Chargement…
          </div>
        ) : cards.length === 0 ? (
          <div className="text-center py-8">
            <CreditCard size={32} className="mx-auto text-muted-foreground opacity-30 mb-3" />
            <p className="text-sm text-muted-foreground">Aucune carte enregistrée pour l'instant.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Cochez "Enregistrer cette carte" lors de votre prochain paiement par carte pour la retrouver ici.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {cards.map(card => (
              <div
                key={card.id}
                className="w-full p-4 bg-white rounded-2xl border border-border flex items-center gap-3"
              >
                <CreditCard size={20} className="text-muted-foreground shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-bold">
                    {BRAND_LABELS[card.brand] || card.brand.toUpperCase()} •••• {card.last4}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Expire {String(card.expMonth).padStart(2, '0')}/{card.expYear}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(card.id)}
                  disabled={deletingId === card.id}
                  aria-label="Supprimer cette carte"
                  className="p-2 text-muted-foreground hover:text-destructive transition-colors shrink-0"
                >
                  {deletingId === card.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

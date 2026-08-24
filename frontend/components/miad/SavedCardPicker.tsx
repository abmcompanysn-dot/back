"use client"

import { useEffect, useState } from 'react'
import { CreditCard, Plus, Trash2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

export interface SavedCard {
  id: string
  brand: string
  last4: string
  expMonth: number
  expYear: number
}

interface SavedCardPickerProps {
  token: string
  selected: string | 'new'
  onSelect: (id: string | 'new') => void
  saveNewCard: boolean
  onSaveNewCardChange: (value: boolean) => void
}

// Pas de set d'icônes de marque de carte dans ce dépôt — badge texte à partir
// de pm.card.brand (déjà en clair côté Stripe), pas de nouvel asset à gérer.
const BRAND_LABELS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
}

export function SavedCardPicker({ token, selected, onSelect, saveNewCard, onSaveNewCardChange }: SavedCardPickerProps) {
  const [cards, setCards] = useState<SavedCard[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/payment-methods', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json().catch(() => null)
        if (!cancelled && data?.success) {
          const list: SavedCard[] = data.paymentMethods || []
          setCards(list)
          // Pré-sélectionne la première carte enregistrée si aucune sélection encore faite.
          if (list.length > 0 && selected === 'new') onSelect(list[0].id)
        }
      } catch {
        // Silencieux : au pire le client tape une nouvelle carte, flux inchangé.
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const handleDelete = async (id: string) => {
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
      if (selected === id) onSelect('new')
      toast.success('Carte supprimée.')
    } catch (e: any) {
      toast.error(e.message || 'Impossible de supprimer cette carte.')
    } finally {
      setDeletingId(null)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs font-bold text-muted-foreground py-3">
        <Loader2 size={14} className="animate-spin" /> Chargement de vos cartes enregistrées…
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {cards.map(card => (
        <div
          key={card.id}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(card.id)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect(card.id) }}
          className={`w-full p-4 bg-white rounded-2xl border-2 transition-all flex items-center gap-3 cursor-pointer ${
            selected === card.id ? 'border-accent shadow-md' : 'border-slate-100 hover:border-accent/30'
          }`}
        >
          <CreditCard size={20} className={selected === card.id ? 'text-accent' : 'text-muted-foreground'} />
          <div className="flex-1 text-left">
            <p className="text-sm font-bold">
              {BRAND_LABELS[card.brand] || card.brand.toUpperCase()} •••• {card.last4}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Expire {String(card.expMonth).padStart(2, '0')}/{card.expYear}
            </p>
          </div>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); handleDelete(card.id) }}
            disabled={deletingId === card.id}
            aria-label="Supprimer cette carte"
            className="p-2 text-muted-foreground hover:text-destructive transition-colors"
          >
            {deletingId === card.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
          </button>
        </div>
      ))}

      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect('new')}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect('new') }}
        className={`w-full p-4 bg-white rounded-2xl border-2 transition-all flex items-center gap-3 cursor-pointer ${
          selected === 'new' ? 'border-accent shadow-md' : 'border-slate-100 hover:border-accent/30'
        }`}
      >
        <Plus size={20} className={selected === 'new' ? 'text-accent' : 'text-muted-foreground'} />
        <p className="text-sm font-bold">Ajouter une nouvelle carte</p>
      </div>

      {selected === 'new' && (
        <label className="flex items-center gap-2 pl-1 pt-1 text-xs font-bold text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={saveNewCard}
            onChange={e => onSaveNewCardChange(e.target.checked)}
            className="w-4 h-4 accent-accent"
          />
          Enregistrer cette carte pour mes prochains achats
        </label>
      )}
    </div>
  )
}

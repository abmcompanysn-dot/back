// Badge de statut : couleur sémantique + libellé FR lisible + pastille.
// Remplace l'affichage du statut brut (payment_expired, pending, ok…)
// signalé illisible dans la revue UX 2026-09-02.
const GREEN = new Set(['ok', 'paid', 'confirmed', 'active', 'completed', 'delivered', 'sent', 'published', 'approved', 'shipped', 'succeeded'])
const ORANGE = new Set(['pending', 'pending_payment', 'sending', 'queued', 'awaiting', 'processing', 'draft', 'degraded', 'on_hold', 'on-hold', 'partially_paid'])
const RED = new Set(['down', 'failed', 'cancelled', 'canceled', 'refunded', 'rejected', 'expired', 'payment_expired', 'suspended', 'error'])

// Libellés FR — clé = statut brut normalisé (minuscule). Un statut inconnu
// garde son texte brut, jamais une erreur d'affichage.
const LABELS: Record<string, string> = {
  ok: 'OK',
  down: 'Hors service',
  degraded: 'Dégradé',
  paid: 'Payé',
  pending: 'En attente',
  pending_payment: 'Attente paiement',
  payment_expired: 'Paiement expiré',
  partially_paid: 'Partiellement payé',
  processing: 'En préparation',
  shipped: 'Expédié',
  delivered: 'Livré',
  completed: 'Terminé',
  cancelled: 'Annulé',
  canceled: 'Annulé',
  refunded: 'Remboursé',
  failed: 'Échoué',
  expired: 'Expiré',
  succeeded: 'Réussi',
  confirmed: 'Confirmé',
  approved: 'Approuvé',
  rejected: 'Rejeté',
  suspended: 'Suspendu',
  active: 'Actif',
  draft: 'Brouillon',
  published: 'Publié',
  sent: 'Envoyé',
  sending: 'Envoi…',
  queued: 'En file',
  on_hold: 'En pause',
  'on-hold': 'En pause',
  mixed: 'Statut mixte',
}

function colorFor(status: string): 'green' | 'orange' | 'red' | 'gray' {
  const s = status.toLowerCase()
  if (GREEN.has(s)) return 'green'
  if (ORANGE.has(s)) return 'orange'
  if (RED.has(s)) return 'red'
  return 'gray'
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="badge badge-gray">—</span>
  const s = status.toLowerCase()
  const label = LABELS[s] || status
  return <span className={`badge badge-dot badge-${colorFor(status)}`}>{label}</span>
}

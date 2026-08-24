// Regroupe les libellés de statut connus (across orders/payments/vendors)
// en 4 couleurs sémantiques — vert = validé, orange = en attente, rouge =
// échoué/annulé, gris = neutre/inconnu (fallback sûr, jamais une erreur
// d'affichage pour un statut pas encore vu ici).
const GREEN = new Set(['ok', 'paid', 'confirmed', 'active', 'completed', 'delivered', 'sent', 'published', 'approved', 'shipped'])
const ORANGE = new Set(['pending', 'pending_payment', 'sending', 'queued', 'awaiting', 'processing', 'draft', 'degraded'])
const RED = new Set(['down', 'failed', 'cancelled', 'canceled', 'refunded', 'rejected', 'expired', 'suspended'])

function colorFor(status: string): 'green' | 'orange' | 'red' | 'gray' {
  const s = status.toLowerCase()
  if (GREEN.has(s)) return 'green'
  if (ORANGE.has(s)) return 'orange'
  if (RED.has(s)) return 'red'
  return 'gray'
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="badge badge-gray">—</span>
  return <span className={`badge badge-${colorFor(status)}`}>{status}</span>
}

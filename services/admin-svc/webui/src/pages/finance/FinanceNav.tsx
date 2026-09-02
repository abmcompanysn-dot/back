import { NavLink } from 'react-router-dom'

const SUBTABS = [
  { path: '/admin/finance', label: "Vue d'ensemble", end: true },
  // Distincte de "Transactions" (confirmées uniquement) — "Paiements"
  // montre TOUS les statuts (en attente/échoué compris), pour vérifier
  // si l'argent d'une commande précise est vraiment arrivé.
  { path: '/admin/finance/payments', label: 'Paiements' },
  { path: '/admin/finance/transactions', label: 'Transactions' },
  { path: '/admin/vendors/payouts', label: 'Retraits & Payouts' },
  { path: '/admin/finance/gateways', label: 'Passerelles de Paiement' },
]

export function FinanceNav() {
  return (
    <nav className="subnav">
      {SUBTABS.map((t) => (
        <NavLink key={t.path} to={t.path} end={t.end} className={({ isActive }) => (isActive ? 'active' : '')}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  )
}

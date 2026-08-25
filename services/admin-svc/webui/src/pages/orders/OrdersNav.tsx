import { NavLink } from 'react-router-dom'

const SUBTABS = [
  { path: '/admin/orders', label: 'Toutes les commandes', end: true },
  { path: '/admin/orders/pending', label: 'En attente de traitement' },
  { path: '/admin/orders/returns', label: 'Retours & Litiges' },
]

export function OrdersNav() {
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

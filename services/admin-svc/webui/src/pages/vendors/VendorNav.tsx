import { NavLink } from 'react-router-dom'

const SUBTABS = [
  { path: '/admin/vendors', label: 'Tous les Vendeurs', end: true },
  { path: '/admin/vendors/kyc', label: "Demandes d'inscription" },
  { path: '/admin/vendors/new', label: 'Ajouter un Vendeur' },
  { path: '/admin/vendors/payouts', label: 'Retraits & Payouts' },
]

export function VendorNav() {
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

import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'

const TABS = [
  { path: '/admin/', label: "Vue d'ensemble", end: true },
  { path: '/admin/orders', label: 'Commandes' },
  { path: '/admin/products', label: 'Produits' },
  { path: '/admin/vendors', label: 'Boutiques' },
  { path: '/admin/customers', label: 'Clients' },
  { path: '/admin/payments', label: 'Paiements' },
  { path: '/admin/shipping', label: 'Livraison' },
  { path: '/admin/marketing', label: 'Marketing' },
  { path: '/admin/email-templates', label: 'Modèles de messages' },
  { path: '/admin/security', label: 'Sécurité' },
  { path: '/admin/system', label: 'Système' },
]

export function Layout() {
  const { logout } = useAuth()
  return (
    <div>
      <header className="app-header">
        <h1>MIAD Market — Administration</h1>
        <button className="btn-ghost" onClick={logout}>
          Déconnexion
        </button>
      </header>
      <nav className="app-nav">
        {TABS.map((tab) => (
          <NavLink
            key={tab.path}
            to={tab.path}
            end={tab.end}
            className={({ isActive }) => (isActive ? 'active' : '')}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}

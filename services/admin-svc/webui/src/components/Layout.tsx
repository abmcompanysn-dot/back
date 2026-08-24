import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'

// Icônes en emoji : pas de bibliothèque d'icônes externe (cohérent avec
// le reste du dépôt — client HTTP fait main, TOTP en Go pur, etc.), et
// s'affiche correctement sans police web supplémentaire.
const TABS = [
  { path: '/admin/', label: "Tableau de bord", icon: '📊', end: true },
  { path: '/admin/products', label: 'Catalogue', icon: '🛍️' },
  { path: '/admin/vendors', label: 'Vendeurs', icon: '🏬' },
  { path: '/admin/orders', label: 'Commandes', icon: '🧾' },
  { path: '/admin/customers', label: 'Clients', icon: '👥' },
  { path: '/admin/shipping', label: 'Livraison', icon: '🚚' },
  { path: '/admin/marketing', label: 'Marketing', icon: '📣' },
  { path: '/admin/email-templates', label: 'Modèles de messages', icon: '✉️' },
  { path: '/admin/payments', label: 'Finances', icon: '💳' },
  { path: '/admin/security', label: 'Sécurité', icon: '🔐' },
  { path: '/admin/system', label: 'Système', icon: '⚙️' },
]

const PAGE_TITLES: Record<string, string> = {
  '/admin/': "Tableau de bord",
  '/admin/products': 'Catalogue',
  '/admin/vendors': 'Vendeurs',
  '/admin/orders': 'Commandes',
  '/admin/customers': 'Clients',
  '/admin/shipping': 'Livraison',
  '/admin/marketing': 'Marketing',
  '/admin/email-templates': 'Modèles de messages',
  '/admin/payments': 'Finances',
  '/admin/security': 'Sécurité',
  '/admin/system': 'Système',
}

export function Layout() {
  const { logout } = useAuth()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('miad_admin_sidebar') === 'collapsed')

  function toggle() {
    setCollapsed((v) => {
      const next = !v
      localStorage.setItem('miad_admin_sidebar', next ? 'collapsed' : 'expanded')
      return next
    })
  }

  const location = useLocation()
  const currentTitle = PAGE_TITLES[location.pathname] ?? 'MIAD Market'

  return (
    <div className="app-shell">
      <aside className={`app-sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-brand">
          {!collapsed && <span className="brand-name">MIAD Market</span>}
          <button className="sidebar-toggle" onClick={toggle} title={collapsed ? 'Étendre' : 'Réduire'}>
            {collapsed ? '»' : '«'}
          </button>
        </div>
        <nav className="sidebar-nav">
          {TABS.map((tab) => (
            <NavLink
              key={tab.path}
              to={tab.path}
              end={tab.end}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
              title={collapsed ? tab.label : undefined}
            >
              <span className="icon">{tab.icon}</span>
              {!collapsed && <span>{tab.label}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className="btn-ghost" onClick={logout} style={{ width: '100%' }}>
            {collapsed ? '⏻' : 'Déconnexion'}
          </button>
        </div>
      </aside>

      <div className="app-content">
        <header className="app-topbar">
          <h1>{currentTitle}</h1>
        </header>
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

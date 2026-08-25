import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import {
  IconChevronLeft,
  IconChevronRight,
  IconCatalog,
  IconConfiguration,
  IconCustomers,
  IconDashboard,
  IconFinance,
  IconImage,
  IconLogout,
  IconMail,
  IconMarketing,
  IconOrders,
  IconSecurity,
  IconShipping,
  IconStore,
  IconSystem,
} from './Icons'

const TABS = [
  { path: '/admin/', label: "Tableau de bord", icon: IconDashboard, end: true },
  { path: '/admin/catalog/products', label: 'Catalogue', icon: IconCatalog },
  { path: '/admin/media', label: 'Médiathèque', icon: IconImage },
  { path: '/admin/vendors', label: 'Vendeurs', icon: IconStore },
  { path: '/admin/orders', label: 'Commandes', icon: IconOrders },
  { path: '/admin/users', label: 'Utilisateurs', icon: IconCustomers },
  { path: '/admin/shipping', label: 'Livraison', icon: IconShipping },
  { path: '/admin/marketing', label: 'Marketing', icon: IconMarketing },
  { path: '/admin/email-templates', label: 'Modèles de messages', icon: IconMail },
  { path: '/admin/finance', label: 'Finances', icon: IconFinance },
  { path: '/admin/security', label: 'Sécurité', icon: IconSecurity },
  { path: '/admin/system', label: 'Système', icon: IconSystem },
  { path: '/admin/configuration', label: 'Configuration', icon: IconConfiguration },
]

const PAGE_TITLES: Record<string, string> = {
  '/admin/': "Tableau de bord",
  '/admin/catalog/products': 'Catalogue',
  '/admin/catalog/products/new': 'Catalogue',
  '/admin/catalog/brands': 'Catalogue',
  '/admin/catalog/categories': 'Catalogue',
  '/admin/catalog/reviews': 'Catalogue',
  '/admin/media': 'Médiathèque',
  '/admin/vendors': 'Vendeurs',
  '/admin/orders': 'Commandes',
  '/admin/users': 'Utilisateurs',
  '/admin/shipping': 'Livraison',
  '/admin/marketing': 'Marketing',
  '/admin/email-templates': 'Modèles de messages',
  '/admin/payments': 'Finances',
  '/admin/security': 'Sécurité',
  '/admin/system': 'Système',
  '/admin/configuration': 'Configuration',
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
  const currentTitle =
    PAGE_TITLES[location.pathname] ??
    (location.pathname.startsWith('/admin/catalog/') ? 'Catalogue' : 'MIAD Market')

  return (
    <div className="app-shell">
      <aside className={`app-sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-brand">
          {!collapsed && <span className="brand-name">MIAD Market</span>}
          <button className="sidebar-toggle" onClick={toggle} title={collapsed ? 'Étendre' : 'Réduire'}>
            {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
          </button>
        </div>
        <nav className="sidebar-nav">
          {TABS.map((tab) => {
            const Icon = tab.icon
            return (
              <NavLink
                key={tab.path}
                to={tab.path}
                end={tab.end}
                className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
                title={collapsed ? tab.label : undefined}
              >
                <span className="icon">
                  <Icon />
                </span>
                {!collapsed && <span>{tab.label}</span>}
              </NavLink>
            )
          })}
        </nav>
        <div className="sidebar-footer">
          <button className="btn-ghost" onClick={logout} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start', gap: 10 }}>
            <IconLogout />
            {!collapsed && <span>Déconnexion</span>}
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

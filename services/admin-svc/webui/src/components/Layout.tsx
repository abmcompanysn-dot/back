import { useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
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
  IconSearch,
  IconSecurity,
  IconShipping,
  IconStore,
  IconSystem,
} from './Icons'

const TABS = [
  { path: '/admin/', label: 'Tableau de bord', icon: IconDashboard, end: true },
  { path: '/admin/catalog/products', label: 'Catalogue', icon: IconCatalog },
  { path: '/admin/media', label: 'Médiathèque', icon: IconImage },
  { path: '/admin/vendors', label: 'Vendeurs', icon: IconStore },
  { path: '/admin/orders', label: 'Commandes', icon: IconOrders },
  { path: '/admin/users', label: 'Utilisateurs', icon: IconCustomers },
  { path: '/admin/shipping', label: 'Livraison', icon: IconShipping },
  { path: '/admin/currencies', label: 'Devises', icon: IconFinance },
  { path: '/admin/marketing', label: 'Marketing', icon: IconMarketing },
  { path: '/admin/email-templates', label: 'Modèles de messages', icon: IconMail },
  { path: '/admin/finance', label: 'Finances', icon: IconFinance },
  { path: '/admin/payment-routing', label: 'Mobile Money', icon: IconFinance },
  { path: '/admin/security', label: 'Sécurité', icon: IconSecurity },
  { path: '/admin/system', label: 'Système', icon: IconSystem },
  { path: '/admin/configuration', label: 'Configuration', icon: IconConfiguration },
]

// Fil d'Ariane : segment de menu + éventuelle sous-page. Le topbar affiche
// « Catalogue › Produits » plutôt qu'un titre unique qui doublonnait avec
// le <h2> de chaque page (revue UX 2026-09-02).
const SECTION: Record<string, string> = {
  '/admin/': 'Tableau de bord',
  '/admin/catalog': 'Catalogue',
  '/admin/media': 'Médiathèque',
  '/admin/vendors': 'Vendeurs',
  '/admin/orders': 'Commandes',
  '/admin/users': 'Utilisateurs',
  '/admin/shipping': 'Livraison',
  '/admin/currencies': 'Devises',
  '/admin/marketing': 'Marketing',
  '/admin/email-templates': 'Modèles de messages',
  '/admin/finance': 'Finances',
  '/admin/payments': 'Finances',
  '/admin/payment-routing': 'Mobile Money',
  '/admin/security': 'Sécurité',
  '/admin/system': 'Système',
  '/admin/configuration': 'Configuration',
}
const SUBPAGE: Record<string, string> = {
  '/admin/catalog/products': 'Produits',
  '/admin/catalog/products/new': 'Nouveau produit',
  '/admin/catalog/brands': 'Marques',
  '/admin/catalog/categories': 'Catégories & attributs',
  '/admin/catalog/reviews': 'Avis',
  '/admin/catalog/pending': 'En attente',
  '/admin/catalog/variations-maintenance': 'Maintenance variations',
  '/admin/vendors/new': 'Nouveau vendeur',
  '/admin/vendors/kyc': 'Demandes KYC',
  '/admin/vendors/payouts': 'Retraits & payouts',
  '/admin/vendors/map': 'Carte des boutiques',
  '/admin/finance/transactions': 'Transactions',
  '/admin/finance/gateways': 'Passerelles',
  '/admin/users/roles': 'Rôles',
  '/admin/orders/returns': 'Retours',
}

function crumbs(pathname: string): { section: string; sub?: string } {
  const sub = SUBPAGE[pathname]
  // section = plus long préfixe connu
  const key =
    Object.keys(SECTION)
      .filter((k) => k !== '/admin/' && pathname.startsWith(k))
      .sort((a, b) => b.length - a.length)[0] ?? (pathname === '/admin/' ? '/admin/' : '')
  return { section: SECTION[key] ?? 'MIAD Market', sub }
}

export function Layout() {
  const { logout, email } = useAuth()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('miad_admin_sidebar') === 'collapsed')
  const [q, setQ] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  function toggle() {
    setCollapsed((v) => {
      const next = !v
      localStorage.setItem('miad_admin_sidebar', next ? 'collapsed' : 'expanded')
      return next
    })
  }

  // Recherche globale : route selon le préfixe tapé, sinon commandes par défaut.
  function onSearch(e: React.FormEvent) {
    e.preventDefault()
    const term = q.trim()
    if (!term) return
    const enc = encodeURIComponent(term)
    if (/@/.test(term)) navigate(`/admin/users?q=${enc}`)
    else if (/^\d{3,}$/.test(term)) navigate(`/admin/orders?q=${enc}`)
    else navigate(`/admin/catalog/products?q=${enc}`)
    setQ('')
  }

  const location = useLocation()
  const { section, sub } = crumbs(location.pathname)

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
          <button
            className="btn-ghost"
            onClick={logout}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start', gap: 10 }}
          >
            <IconLogout />
            {!collapsed && <span>Déconnexion</span>}
          </button>
        </div>
      </aside>

      <div className="app-content">
        <header className="app-topbar">
          <div className="topbar-crumbs">
            <span className="crumb-section">{section}</span>
            {sub && (
              <>
                <span className="crumb-sep">›</span>
                <span className="crumb-sub">{sub}</span>
              </>
            )}
          </div>

          <form className="topbar-search" onSubmit={onSearch}>
            <span className="topbar-search-icon">
              <IconSearch />
            </span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Rechercher un produit, une commande, un email…"
            />
          </form>

          <div className="topbar-user">
            <button className="topbar-user-btn" onClick={() => setMenuOpen((v) => !v)}>
              <span className="topbar-avatar">{(email || 'A').slice(0, 1).toUpperCase()}</span>
              <span className="topbar-email">{email || 'Admin'}</span>
            </button>
            {menuOpen && (
              <div className="topbar-menu" onMouseLeave={() => setMenuOpen(false)}>
                <button onClick={() => { setMenuOpen(false); navigate('/admin/security') }}>Sécurité (2FA)</button>
                <button onClick={logout}>Déconnexion</button>
              </div>
            )}
          </div>
        </header>
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

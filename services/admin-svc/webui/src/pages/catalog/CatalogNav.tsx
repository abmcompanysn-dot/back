import { NavLink } from 'react-router-dom'

const SUBTABS = [
  { path: '/admin/catalog/products', label: 'Tous les produits', end: true },
  { path: '/admin/catalog/products/new', label: 'Ajouter un produit' },
  { path: '/admin/catalog/categories', label: 'Catégories & Attributs' },
  { path: '/admin/catalog/brands', label: 'Marques' },
  { path: '/admin/catalog/reviews', label: 'Avis & Modération' },
  { path: '/admin/catalog/pending', label: 'Produits en attente' },
  { path: '/admin/catalog/variations-maintenance', label: 'Maintenance variations' },
]

export function CatalogNav() {
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

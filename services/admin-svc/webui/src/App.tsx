import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { Layout } from './components/Layout'
import { Login } from './pages/Login'
import { Overview } from './pages/Overview'
import {
  CUSTOMER_COLUMNS,
  ListView,
  ORDER_COLUMNS,
  PAYMENT_COLUMNS,
  VENDOR_COLUMNS,
} from './pages/ListView'
import { Shipping } from './pages/Shipping'
import { Marketing } from './pages/Marketing'
import { EmailTemplates } from './pages/EmailTemplates'
import { Security } from './pages/Security'
import { System } from './pages/System'
import { AllProducts } from './pages/catalog/AllProducts'
import { ProductForm } from './pages/catalog/ProductForm'
import { Brands } from './pages/catalog/Brands'
import { CategoriesAttributes } from './pages/catalog/CategoriesAttributes'
import { Reviews } from './pages/catalog/Reviews'
import { IconCustomers, IconFinance, IconOrders, IconStore } from './components/Icons'

const emptyIconProps = { width: 40, height: 40, strokeWidth: 1.4 } as const

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth()
  if (!isAuthenticated) return <Navigate to="/admin/login" replace />
  return <>{children}</>
}

function AppRoutes() {
  const { isAuthenticated } = useAuth()
  return (
    <Routes>
      <Route
        path="/admin/login"
        element={isAuthenticated ? <Navigate to="/admin/" replace /> : <Login />}
      />
      <Route
        path="/admin"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Overview />} />
        <Route
          path="orders"
          element={
            <ListView
              path="/admin/api/orders"
              columns={ORDER_COLUMNS}
              title="Commandes"
              subtitle="Suivi des commandes multi-boutiques"
              emptyIcon={<IconOrders {...emptyIconProps} />}
              emptyTitle="Aucune commande enregistrée pour le moment"
              emptyDescription="Les nouvelles commandes de vos clients apparaîtront ici automatiquement."
            />
          }
        />
        <Route path="products" element={<Navigate to="/admin/catalog/products" replace />} />
        <Route path="catalog" element={<Navigate to="/admin/catalog/products" replace />} />
        <Route path="catalog/products" element={<AllProducts />} />
        <Route path="catalog/products/new" element={<ProductForm />} />
        <Route path="catalog/products/:id/edit" element={<ProductForm />} />
        <Route path="catalog/brands" element={<Brands />} />
        <Route path="catalog/categories" element={<CategoriesAttributes />} />
        <Route path="catalog/reviews" element={<Reviews />} />
        <Route
          path="vendors"
          element={
            <ListView
              path="/admin/api/vendors"
              columns={VENDOR_COLUMNS}
              title="Vendeurs"
              subtitle="Boutiques de la marketplace"
              emptyIcon={<IconStore {...emptyIconProps} />}
              emptyTitle="Aucune boutique enregistrée"
              emptyDescription="Les nouvelles boutiques apparaîtront ici après inscription."
            />
          }
        />
        <Route
          path="customers"
          element={
            <ListView
              path="/admin/api/customers"
              columns={CUSTOMER_COLUMNS}
              title="Clients"
              subtitle="Comptes acheteurs"
              emptyIcon={<IconCustomers {...emptyIconProps} />}
              emptyTitle="Aucun client inscrit pour le moment"
            />
          }
        />
        <Route
          path="payments"
          element={
            <ListView
              path="/admin/api/payments"
              columns={PAYMENT_COLUMNS}
              title="Finances"
              subtitle="Transactions et paiements"
              emptyIcon={<IconFinance {...emptyIconProps} />}
              emptyTitle="Aucune transaction pour le moment"
            />
          }
        />
        <Route path="shipping" element={<Shipping />} />
        <Route path="marketing" element={<Marketing />} />
        <Route path="email-templates" element={<EmailTemplates />} />
        <Route path="security" element={<Security />} />
        <Route path="system" element={<System />} />
      </Route>
      <Route path="*" element={<Navigate to="/admin/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  )
}

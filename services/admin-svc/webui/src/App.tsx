import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { Layout } from './components/Layout'
import { Login } from './pages/Login'
import { Overview } from './pages/Overview'
import { CUSTOMER_COLUMNS, ListView, PAYMENT_COLUMNS } from './pages/ListView'
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
import { MediaLibrary } from './pages/media/MediaLibrary'
import { AllVendors } from './pages/vendors/AllVendors'
import { VendorDetail } from './pages/vendors/VendorDetail'
import { VendorKYC } from './pages/vendors/VendorKYC'
import { NewVendor } from './pages/vendors/NewVendor'
import { Payouts } from './pages/vendors/Payouts'
import { AllOrders } from './pages/orders/AllOrders'
import { OrderDetail } from './pages/orders/OrderDetail'
import { Returns } from './pages/orders/Returns'
import { IconCustomers, IconFinance } from './components/Icons'

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
        <Route path="orders" element={<AllOrders />} />
        <Route
          path="orders/pending"
          element={
            <AllOrders
              fixedStatuses={['pending_payment', 'paid', 'processing']}
              title="Commandes en attente de traitement"
              subtitle="Paiement en attente, payées ou en préparation"
            />
          }
        />
        <Route path="orders/returns" element={<Returns />} />
        <Route path="orders/:id" element={<OrderDetail />} />
        <Route path="products" element={<Navigate to="/admin/catalog/products" replace />} />
        <Route path="catalog" element={<Navigate to="/admin/catalog/products" replace />} />
        <Route path="catalog/products" element={<AllProducts />} />
        <Route path="catalog/products/new" element={<ProductForm />} />
        <Route path="catalog/products/:id/edit" element={<ProductForm />} />
        <Route path="catalog/brands" element={<Brands />} />
        <Route path="catalog/categories" element={<CategoriesAttributes />} />
        <Route path="catalog/reviews" element={<Reviews />} />
        <Route path="media" element={<MediaLibrary />} />
        <Route path="vendors" element={<AllVendors />} />
        <Route path="vendors/new" element={<NewVendor />} />
        <Route path="vendors/kyc" element={<VendorKYC />} />
        <Route path="vendors/payouts" element={<Payouts />} />
        <Route path="vendors/:id" element={<VendorDetail />} />
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

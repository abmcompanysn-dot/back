import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { Layout } from './components/Layout'
import { Login } from './pages/Login'
import { ForceTotpSetup } from './pages/ForceTotpSetup'
import { Overview } from './pages/Overview'
import { AllUsers } from './pages/users/AllUsers'
import { CustomerDetail } from './pages/users/CustomerDetail'
import { AdminRoles } from './pages/users/AdminRoles'
import { Shipping } from './pages/Shipping'
import { Currencies } from './pages/Currencies'
import { TestOrder } from './pages/TestOrder'
import { ClientErrors } from './pages/ClientErrors'
import { Marketing } from './pages/Marketing'
import { EmailTemplates } from './pages/EmailTemplates'
import { Security } from './pages/Security'
import { System } from './pages/System'
import { Configuration } from './pages/Configuration'
import { PaymentRouting } from './pages/PaymentRouting'
import { WhatsAppLogs } from './pages/WhatsAppLogs'
import { AllProducts } from './pages/catalog/AllProducts'
import { ProductForm } from './pages/catalog/ProductForm'
import { Brands } from './pages/catalog/Brands'
import { CategoriesAttributes } from './pages/catalog/CategoriesAttributes'
import { Reviews } from './pages/catalog/Reviews'
import { PendingProducts } from './pages/catalog/PendingProducts'
import { VariationsMaintenance } from './pages/catalog/VariationsMaintenance'
import { MediaLibrary } from './pages/media/MediaLibrary'
import { AllVendors } from './pages/vendors/AllVendors'
import { VendorDetail } from './pages/vendors/VendorDetail'
import { VendorKYC } from './pages/vendors/VendorKYC'
import { NewVendor } from './pages/vendors/NewVendor'
import { Payouts } from './pages/vendors/Payouts'
import { VendorMap } from './pages/vendors/VendorMap'
import { AllOrders } from './pages/orders/AllOrders'
import { OrderDetail } from './pages/orders/OrderDetail'
import { Returns } from './pages/orders/Returns'
import { FinanceOverview } from './pages/finance/FinanceOverview'
import { PaymentsAll } from './pages/finance/PaymentsAll'
import { Transactions } from './pages/finance/Transactions'
import { Gateways } from './pages/finance/Gateways'

// RequireAuth bloque aussi sur ForceTotpSetup si totpSetupRequired (2FA
// obligatoire, voir auth.tsx) — un admin ne peut atteindre AUCUNE route
// du dashboard tant qu'il n'a pas configuré et confirmé sa 2FA.
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, totpSetupRequired } = useAuth()
  if (!isAuthenticated) return <Navigate to="/admin/login" replace />
  if (totpSetupRequired) return <ForceTotpSetup />
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
        <Route path="catalog/pending" element={<PendingProducts />} />
        <Route path="catalog/variations-maintenance" element={<VariationsMaintenance />} />
        <Route path="media" element={<MediaLibrary />} />
        <Route path="vendors" element={<AllVendors />} />
        <Route path="vendors/new" element={<NewVendor />} />
        <Route path="vendors/kyc" element={<VendorKYC />} />
        <Route path="vendors/payouts" element={<Payouts />} />
        <Route path="vendors/map" element={<VendorMap />} />
        <Route path="vendors/:id" element={<VendorDetail />} />
        <Route path="customers" element={<Navigate to="/admin/users" replace />} />
        <Route path="users" element={<AllUsers />} />
        <Route path="users/customers/:id" element={<CustomerDetail />} />
        <Route path="users/roles" element={<AdminRoles />} />
        <Route path="payments" element={<Navigate to="/admin/finance" replace />} />
        <Route path="finance" element={<FinanceOverview />} />
        <Route path="finance/payments" element={<PaymentsAll />} />
        <Route path="finance/transactions" element={<Transactions />} />
        <Route path="finance/gateways" element={<Gateways />} />
        <Route path="shipping" element={<Shipping />} />
        <Route path="currencies" element={<Currencies />} />
        <Route path="test-order" element={<TestOrder />} />
        <Route path="client-errors" element={<ClientErrors />} />
        <Route path="marketing" element={<Marketing />} />
        <Route path="email-templates" element={<EmailTemplates />} />
        <Route path="security" element={<Security />} />
        <Route path="system" element={<System />} />
        <Route path="configuration" element={<Configuration />} />
        <Route path="payment-routing" element={<PaymentRouting />} />
        <Route path="whatsapp-logs" element={<WhatsAppLogs />} />
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

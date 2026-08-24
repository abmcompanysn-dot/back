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
  PRODUCT_COLUMNS,
  VENDOR_COLUMNS,
} from './pages/ListView'
import { Shipping } from './pages/Shipping'
import { Marketing } from './pages/Marketing'
import { EmailTemplates } from './pages/EmailTemplates'
import { Security } from './pages/Security'
import { System } from './pages/System'

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
        <Route path="orders" element={<ListView path="/admin/api/orders" columns={ORDER_COLUMNS} />} />
        <Route
          path="products"
          element={<ListView path="/admin/api/products" columns={PRODUCT_COLUMNS} />}
        />
        <Route path="vendors" element={<ListView path="/admin/api/vendors" columns={VENDOR_COLUMNS} />} />
        <Route
          path="customers"
          element={<ListView path="/admin/api/customers" columns={CUSTOMER_COLUMNS} />}
        />
        <Route
          path="payments"
          element={<ListView path="/admin/api/payments" columns={PAYMENT_COLUMNS} />}
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

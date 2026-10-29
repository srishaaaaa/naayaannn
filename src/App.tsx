import './index.css'
import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuthStore, useProductStore, useVariantStore, useAdminAuthStore } from './store/store'
import { BRAND_EN } from './lib/brand'
import { clearLocalOrders } from './lib/ordersFallback'
import { LowStockAlarmModal } from './components/dashboard/LowStockAlarmModal'
import { ConfirmDeleteHost } from './components/common/ConfirmDeleteDialog'
import { useLowStockMonitor } from './hooks/useLowStockMonitor'
import { alarmSound } from './lib/alarmAudio'
import { db, isDatabaseConfigured } from './lib/db'
import { supabaseAuth, isSupabaseAuthConfigured } from './lib/supabaseAuth'

function lazyWithRetry<T extends React.ComponentType<any>>(
  factory: () => Promise<{ default: T }>
) {
  return lazy(async () => {
    try {
      return await factory()
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (
        errMsg.includes('Failed to fetch dynamically imported module') ||
        errMsg.includes('Importing a module script failed') ||
        errMsg.includes('MIME type') ||
        errMsg.includes('error loading dynamically imported module')
      ) {
        const lastReload = sessionStorage.getItem('chunk_reload_ts')
        const now = Date.now()
        if (!lastReload || now - Number(lastReload) > 10000) {
          sessionStorage.setItem('chunk_reload_ts', String(now))
          window.location.reload()
          return new Promise(() => {}) // Hold suspense while reloading
        }
      }
      throw err
    }
  })
}

const Dashboard = lazyWithRetry(() => import('./pages/Dashboard'))
const Pos = lazyWithRetry(() => import('./pages/Pos'))
const DigitalInvoice = lazyWithRetry(() => import('./pages/DigitalInvoice'))
const Login = lazyWithRetry(() => import('./pages/Login'))
const AdminLogin = lazyWithRetry(() => import('./pages/AdminLogin'))

function LoadingSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bgMain">
      <span className="h-10 w-10 animate-spin rounded-full border-4 border-[#F3F4F6] border-t-primary-soft" />
    </div>
  )
}

function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((state) => state.user)
  const loading = useAuthStore((state) => state.loading)

  if (loading) return <LoadingSpinner />
  return user ? <Navigate to="/dashboard" replace /> : <>{children}</>
}

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { isLoggedIn, role } = useAdminAuthStore()
  const location = useLocation()
  if (!isLoggedIn || (role !== 'admin' && role !== 'staff')) {
    return <Navigate to="/admin-login" state={{ from: location }} replace />
  }
  return <>{children}</>
}

function AdminOnlyGuard({ children }: { children: React.ReactNode }) {
  const { isLoggedIn, role } = useAdminAuthStore()
  const location = useLocation()
  if (!isLoggedIn) {
    return <Navigate to="/admin-login" state={{ from: location }} replace />
  }
  if (role !== 'admin') {
    return <Navigate to="/dashboard" replace />
  }
  return <>{children}</>
}

function PosGuard({ children }: { children: React.ReactNode }) {
  const { isLoggedIn } = useAdminAuthStore()
  const location = useLocation()
  if (!isLoggedIn) {
    return <Navigate to="/admin-login" state={{ from: location }} replace />
  }
  return <>{children}</>
}

function AppShell() {
  const initialize = useAuthStore((state) => state.initialize)
  const fetchProducts = useProductStore((state) => state.fetchProducts)
  const fetchVariants = useVariantStore((state) => state.fetchVariants)
  const refetchVariants = useVariantStore((state) => state.refetchVariants)
  const { isLoggedIn, role } = useAdminAuthStore()

  const hasStaffOrAdminAccess = Boolean(isLoggedIn && (role === 'admin' || role === 'staff'))
  // The invoice page is what customers see, so the low-stock alarm never shows or sounds there
  const { pathname } = useLocation()
  const onCustomerPage = pathname.startsWith('/invoice')
  const stockAlarmEnabled = hasStaffOrAdminAccess && !onCustomerPage
  useLowStockMonitor(stockAlarmEnabled, role)
  useEffect(() => {
    if (onCustomerPage) alarmSound.stopAlert()
  }, [onCustomerPage])

  useEffect(() => {
    document.title = BRAND_EN
  }, [])

  useEffect(() => {
    clearLocalOrders()

    if (!isSupabaseAuthConfigured) {
      void initialize()
      return
    }

    const { data: { subscription } } = supabaseAuth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
        void initialize()
      }
    })

    void initialize()

    return () => subscription.unsubscribe()
  }, [initialize])

  useEffect(() => {
    // Shop data is only readable with a portal session; load it once signed in
    if (!hasStaffOrAdminAccess) return
    void fetchProducts(true)
    void fetchVariants()

    if (!isDatabaseConfigured) {
      return
    }

    // A change on the server always reloads (a cached list would keep showing deleted items)
    const productChannel = db
      .channel('admin-products-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
        void fetchProducts(true)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'product_variants' }, () => {
        void refetchVariants()
      })
      .subscribe()

    // Coming back to the app (tab switch, phone unlock) shows the current catalogue
    const refreshOnReturn = () => {
      if (document.visibilityState !== 'visible') return
      void fetchProducts(true)
      void refetchVariants()
    }
    document.addEventListener('visibilitychange', refreshOnReturn)

    return () => {
      void db.removeChannel(productChannel)
      document.removeEventListener('visibilitychange', refreshOnReturn)
    }
  }, [fetchProducts, fetchVariants, refetchVariants, hasStaffOrAdminAccess])

  return (
    <div className="ios-app-shell w-full max-w-[100vw] bg-bgMain print:block print:h-auto print:overflow-visible">
      <main className="h-full print:block print:h-auto print:min-h-0 print:overflow-visible">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route
            path="/login"
            element={
              <PublicOnlyRoute>
                <Suspense fallback={<LoadingSpinner />}>
                  <Login />
                </Suspense>
              </PublicOnlyRoute>
            }
          />
          <Route
            path="/admin-login"
            element={
              <Suspense fallback={<LoadingSpinner />}>
                <AdminLogin />
              </Suspense>
            }
          />
          {/* Common Admin & Staff Portal Routes */}
          <Route
            element={
              <AdminGuard>
                <Suspense fallback={<LoadingSpinner />}>
                  <Dashboard />
                </Suspense>
              </AdminGuard>
            }
          >
            <Route path="/admin" element={<Dashboard />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/advance-orders" element={<Dashboard />} />
            <Route path="/expenses" element={<Dashboard />} />
            <Route path="/dashboard/expenses" element={<Dashboard />} />
          </Route>

          {/* Admin-Only Dedicated Routes */}
          <Route
            element={
              <AdminOnlyGuard>
                <Suspense fallback={<LoadingSpinner />}>
                  <Dashboard />
                </Suspense>
              </AdminOnlyGuard>
            }
          >
            <Route path="/whatsapp-center" element={<Dashboard />} />
            <Route path="/pos-analytics" element={<Dashboard />} />
          </Route>
          <Route
            path="/pos"
            element={
              <PosGuard>
                <Suspense fallback={<LoadingSpinner />}>
                  <Pos />
                </Suspense>
              </PosGuard>
            }
          />
          <Route
            path="/invoice/:id"
            element={
              <Suspense fallback={<LoadingSpinner />}>
                <DigitalInvoice />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>

      {/* Global Low Stock Sound & Visual Alarm for Admin and Staff Panels */}
      {stockAlarmEnabled && <LowStockAlarmModal />}
      <ConfirmDeleteHost />
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  )
}


/**
 * MIAD Market - Suivi léger du parcours client (dashboard KPI admin)
 *
 * Envoie des événements anonymes (pas de PII) vers /api/analytics/track,
 * qui relaie vers WordPress. Utilise sendBeacon quand disponible pour ne
 * jamais bloquer la navigation ni échouer silencieusement au unload
 * (ex: événement checkout_complete juste avant la redirection).
 */

export type AnalyticsEventType =
  | 'page_view'
  | 'product_view'
  | 'add_to_cart'
  | 'remove_from_cart'
  | 'checkout_start'
  | 'checkout_step'
  | 'checkout_complete'
  | 'payment_attempt'
  | 'payment_failed'
  | 'payment_success'
  | 'cart_abandoned'
  | 'search'

interface TrackEventParams {
  productId?: number | string
  searchQuery?: string
  path?: string
  checkoutStepNumber?: number
  paymentFailureReason?: string
  deviceType?: 'mobile' | 'tablet' | 'desktop'
  cartValue?: number
  metadata?: Record<string, unknown>
}

const SESSION_STORAGE_KEY = 'miad_analytics_session_id'

function getSessionId(): string {
  if (typeof window === 'undefined') return 'server'
  let id = sessionStorage.getItem(SESSION_STORAGE_KEY)
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, '').slice(0, 32)
    sessionStorage.setItem(SESSION_STORAGE_KEY, id)
  }
  return id
}

function getUserId(): string | undefined {
  try {
    const raw = localStorage.getItem('miad_user')
    if (!raw) return undefined
    const id = JSON.parse(raw)?.id
    return id != null ? String(id) : undefined
  } catch {
    return undefined
  }
}

function detectDeviceType(): 'mobile' | 'tablet' | 'desktop' {
  const w = window.innerWidth
  if (w < 640) return 'mobile'
  if (w < 1024) return 'tablet'
  return 'desktop'
}

export function trackEvent(eventType: AnalyticsEventType, params: TrackEventParams = {}): void {
  if (typeof window === 'undefined') return

  const payload = {
    eventType,
    sessionId: getSessionId(),
    userId: getUserId(),
    productId: params.productId,
    searchQuery: params.searchQuery,
    path: params.path ?? window.location.pathname,
    referrer: document.referrer || undefined,
    checkoutStepNumber: params.checkoutStepNumber,
    paymentFailureReason: params.paymentFailureReason,
    deviceType: params.deviceType ?? detectDeviceType(),
    cartValue: params.cartValue,
    metadata: params.metadata,
  }

  const body = JSON.stringify(payload)

  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' })
      navigator.sendBeacon('/api/analytics/track', blob)
      return
    }
  } catch {
    // sendBeacon peut échouer sur certains navigateurs/politiques — on retombe sur fetch
  }

  fetch('/api/analytics/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {
    // Le tracking ne doit jamais faire échouer l'expérience utilisateur
  })
}

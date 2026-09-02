// marketing-events — envoie les événements standard vers le Pixel Meta
// (fbq) et la Conversions API Meta (via /api/meta/capi), en plus du suivi
// interne trackEvent(). Appeler ces fonctions à CÔTÉ de trackEvent(), aux
// mêmes points du parcours.
//
// Dédup Pixel ↔ CAPI : chaque événement porte un eventID commun, Meta
// fusionne les deux côtés (docs "Redundant setup").

type Params = Record<string, unknown>

function fbq(): ((...args: unknown[]) => void) | null {
  if (typeof window === 'undefined') return null
  const f = (window as unknown as { fbq?: (...args: unknown[]) => void }).fbq
  return typeof f === 'function' ? f : null
}

function newEventId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

// Envoi serveur-à-serveur (CAPI) — best effort, ne bloque jamais l'UI.
function sendCapi(eventName: string, eventId: string, customData: Params) {
  if (typeof window === 'undefined') return
  if (!(window as any).__miadMarketing?.capi_enabled) return
  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'website',
        event_source_url: window.location.href,
        user_data: {
          client_user_agent: navigator.userAgent,
          // fbp / fbc lus des cookies posés par le Pixel — améliorent le
          // matching sans PII.
          fbp: getCookie('_fbp') || undefined,
          fbc: getCookie('_fbc') || undefined,
        },
        custom_data: customData,
      },
    ],
  }
  fetch('/api/meta/capi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {})
}

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return m ? decodeURIComponent(m[1]) : null
}

function track(eventName: string, customData: Params = {}) {
  const eventId = newEventId()
  const q = fbq()
  if (q) q('track', eventName, customData, { eventID: eventId })
  sendCapi(eventName, eventId, customData)
}

// ── Événements standard Meta ────────────────────────────────────────────

export function mktViewContent(p: { id: string | number; name?: string; price?: number; currency?: string }) {
  track('ViewContent', {
    content_type: 'product',
    content_ids: [String(p.id)],
    content_name: p.name,
    value: p.price,
    currency: p.currency || 'USD',
  })
}

export function mktAddToCart(p: { id: string | number; name?: string; price?: number; qty?: number; currency?: string }) {
  track('AddToCart', {
    content_type: 'product',
    content_ids: [String(p.id)],
    content_name: p.name,
    value: (p.price ?? 0) * (p.qty ?? 1),
    currency: p.currency || 'USD',
  })
}

export function mktInitiateCheckout(p: { value: number; numItems: number; contentIds: string[]; currency?: string }) {
  track('InitiateCheckout', {
    content_type: 'product',
    content_ids: p.contentIds,
    num_items: p.numItems,
    value: p.value,
    currency: p.currency || 'USD',
  })
}

export function mktPurchase(p: { orderId: string | number; value: number; contentIds: string[]; currency?: string }) {
  track('Purchase', {
    content_type: 'product',
    content_ids: p.contentIds,
    order_id: String(p.orderId),
    value: p.value,
    currency: p.currency || 'USD',
  })
}

export function mktSearch(query: string) {
  track('Search', { search_string: query })
}

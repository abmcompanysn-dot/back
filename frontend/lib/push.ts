'use client'

/**
 * Utilitaires Firebase Cloud Messaging (FCM)
 * - Demande la permission de notification
 * - Obtient le token FCM
 * - Enregistre le token sur le serveur
 */

export async function initPushNotifications(): Promise<string | null> {
  if (typeof window === 'undefined' || !('Notification' in window)) return null
  if (!('serviceWorker' in navigator)) return null

  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return null

    const { getMessaging, getToken } = await import('firebase/messaging')
    const { app } = await import('./firebase')

    const messaging = getMessaging(app)

    const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY
    if (!vapidKey) {
      console.warn('[Push] NEXT_PUBLIC_FIREBASE_VAPID_KEY manquant')
      return null
    }

    // Enregistrer le service worker FCM
    const swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
      scope: '/',
    })

    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: swReg,
    })

    return token || null
  } catch (err) {
    console.warn('[Push] Erreur initialisation FCM:', err)
    return null
  }
}

export async function saveTokenToServer(token: string, userId?: number): Promise<void> {
  try {
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, user_id: userId }),
    })
  } catch {}
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  )
}

export function getNotificationPermission(): NotificationPermission | null {
  if (typeof window === 'undefined' || !('Notification' in window)) return null
  return Notification.permission
}

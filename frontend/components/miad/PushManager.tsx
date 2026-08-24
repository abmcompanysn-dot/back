'use client'

import { useEffect, useRef } from 'react'
import { initPushNotifications, saveTokenToServer, isPushSupported } from '@/lib/push'

/**
 * Initialise silencieusement les push notifications FCM.
 * - Ne demande la permission qu'après une interaction utilisateur
 *   (triggered par les pages qui passent autoRequest=true)
 * - Sauvegarde le token FCM sur le serveur WordPress
 */
export default function PushManager({ autoRequest = false }: { autoRequest?: boolean }) {
  const initialized = useRef(false)

  useEffect(() => {
    if (initialized.current) return
    if (!isPushSupported()) return

    const alreadyGranted = typeof window !== 'undefined'
      && 'Notification' in window
      && Notification.permission === 'granted'

    const run = async () => {
      initialized.current = true
      const token = await initPushNotifications()
      if (token) {
        await saveTokenToServer(token)
        if (typeof window !== 'undefined') {
          localStorage.setItem('fcm_token', token)
        }
      }
    }

    if (alreadyGranted || autoRequest) {
      run()
    }
  }, [autoRequest])

  return null
}

"use client"

import { useEffect, useState } from 'react'
import Script from 'next/script'

// MarketingScripts — injecte le Pixel Meta (Facebook/Instagram) et
// Google Analytics 4 AU RUNTIME, à partir de la config éditable en
// back-office (admin-svc /marketing-config, proxifiée par
// /api/marketing-config). Rien n'est chargé si les identifiants ne sont
// pas renseignés — aucun impact perf ni RGPD tant que ce n'est pas
// configuré.
//
// Le suivi d'événements (ViewContent, AddToCart, Purchase…) est déclenché
// depuis lib/marketing-events.ts, appelé à côté de trackEvent().

interface MarketingConfig {
  meta_pixel_id?: string
  ga_measurement_id?: string
  capi_enabled?: boolean
}

export function MarketingScripts() {
  const [cfg, setCfg] = useState<MarketingConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/marketing-config')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) {
          setCfg(d)
          if (typeof window !== 'undefined') {
            ;(window as any).__miadMarketing = d
          }
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const pixelId = cfg?.meta_pixel_id?.trim()
  const gaId = cfg?.ga_measurement_id?.trim()

  return (
    <>
      {pixelId && (
        <>
          <Script id="meta-pixel" strategy="afterInteractive">
            {`
              !function(f,b,e,v,n,t,s)
              {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
              n.callMethod.apply(n,arguments):n.queue.push(arguments)};
              if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
              n.queue=[];t=b.createElement(e);t.async=!0;
              t.src=v;s=b.getElementsByTagName(e)[0];
              s.parentNode.insertBefore(t,s)}(window,document,'script',
              'https://connect.facebook.net/en_US/fbevents.js');
              fbq('init', '${pixelId}');
              fbq('track', 'PageView');
            `}
          </Script>
          <noscript>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              height="1"
              width="1"
              style={{ display: 'none' }}
              alt=""
              src={`https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1`}
            />
          </noscript>
        </>
      )}

      {gaId && (
        <>
          <Script src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`} strategy="afterInteractive" />
          <Script id="ga4" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', '${gaId}');
            `}
          </Script>
        </>
      )}
    </>
  )
}

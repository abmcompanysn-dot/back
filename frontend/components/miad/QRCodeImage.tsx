'use client'
import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'

interface QRCodeImageProps {
  url: string
  size?: number
  className?: string
}

export function QRCodeImage({ url, size = 200, className }: QRCodeImageProps) {
  const [dataUrl, setDataUrl] = useState<string>('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!url) return
    let cancelled = false
    import('qrcode').then(QRCode => {
      QRCode.toDataURL(url, {
        width: size,
        margin: 2,
        color: { dark: '#0f172a', light: '#ffffff' },
        errorCorrectionLevel: 'H',
      }).then(dataUrl => {
        if (!cancelled) {
          setDataUrl(dataUrl)
          setLoading(false)
        }
      })
    })
    return () => { cancelled = true }
  }, [url, size])

  if (loading) {
    return (
      <div
        style={{ width: size, height: size }}
        className="flex items-center justify-center bg-slate-50 rounded-2xl"
      >
        <Loader2 size={32} className="animate-spin text-slate-300" />
      </div>
    )
  }

  return (
    <img
      src={dataUrl}
      alt="QR Code"
      width={size}
      height={size}
      className={className}
    />
  )
}

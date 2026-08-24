'use client'
import { useState } from 'react'
import { Share2, Link2, Check, MessageCircle, Facebook, Twitter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface ShareButtonProps {
  title: string
  description?: string
  url: string
  image?: string
  className?: string
  variant?: 'icon' | 'full'
}

export function ShareButton({ title, description, url, image, className, variant = 'full' }: ShareButtonProps) {
  const [copied, setCopied] = useState(false)

  const absoluteUrl = url.startsWith('http') ? url : `https://www.miadmarket.com${url}`

  const copyLink = async () => {
    await navigator.clipboard.writeText(absoluteUrl)
    setCopied(true)
    toast.success('Lien copié !')
    setTimeout(() => setCopied(false), 2000)
  }

  const shareNative = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title, text: description || title, url: absoluteUrl })
      } catch {
        // annulé par l'utilisateur
      }
    } else {
      await copyLink()
    }
  }

  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${title}\n${absoluteUrl}`)}`
  const facebookUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(absoluteUrl)}`
  const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(absoluteUrl)}`

  if (typeof navigator !== 'undefined' && navigator.share && variant === 'icon') {
    return (
      <button
        type="button"
        onClick={shareNative}
        className={cn(
          'flex items-center justify-center w-10 h-10 rounded-full bg-white/80 backdrop-blur hover:bg-white shadow transition-all active:scale-95',
          className
        )}
        aria-label="Partager"
      >
        <Share2 size={18} className="text-slate-700" />
      </button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={variant === 'icon' ? 'icon' : 'sm'}
          className={cn(
            'rounded-full border-slate-200 bg-white hover:bg-slate-50 text-slate-700 shadow-sm',
            variant === 'full' && 'gap-2 px-4',
            className
          )}
          aria-label="Partager"
        >
          <Share2 size={16} />
          {variant === 'full' && <span className="text-xs font-bold uppercase tracking-wide">Partager</span>}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-52 rounded-2xl shadow-xl border-slate-100 p-1">
        <DropdownMenuItem
          className="flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer"
          onClick={copyLink}
        >
          {copied ? (
            <Check size={16} className="text-green-500 shrink-0" />
          ) : (
            <Link2 size={16} className="text-slate-500 shrink-0" />
          )}
          <span className="text-sm font-medium">{copied ? 'Lien copié !' : 'Copier le lien'}</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator className="my-1" />

        <DropdownMenuItem asChild>
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer"
          >
            <MessageCircle size={16} className="text-green-500 shrink-0" />
            <span className="text-sm font-medium">WhatsApp</span>
          </a>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <a
            href={facebookUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer"
          >
            <Facebook size={16} className="text-blue-600 shrink-0" />
            <span className="text-sm font-medium">Facebook</span>
          </a>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <a
            href={twitterUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer"
          >
            <Twitter size={16} className="text-sky-500 shrink-0" />
            <span className="text-sm font-medium">X / Twitter</span>
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

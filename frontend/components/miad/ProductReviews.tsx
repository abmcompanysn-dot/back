"use client"

import { useCallback, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import Image from 'next/image'
import { Star, Loader2, ImagePlus, X, ThumbsUp, ShieldCheck, Users, ChevronDown } from 'lucide-react'
import { Button } from '../ui/button'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

type ApiReview = {
  id: number
  reviewer: string
  country: string
  avatar: string
  rating: number
  title: string
  review: string
  photos: string[]
  date: string
  verified: boolean
  isCommunity: boolean
  helpfulCount: number
}
type ApiHeader = {
  average: number
  count: number
  stars: Record<string, number>
  withPhotos: number
  photoStrip: string[]
  hasMore: boolean
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

function flagUrl(cc: string) {
  return cc && cc.length === 2 ? `https://flagcdn.com/w20/${cc.toLowerCase()}.png` : ''
}
function fmtDate(iso: string) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return ''
  }
}

interface ProductReviewsProps {
  product: { id: string | number; name: string; rating?: number }
  user?: { sub?: number | string; email?: string; name?: string; display_name?: string } | null
}

export function ProductReviews({ product, user }: ProductReviewsProps) {
  const pid = Number(product.id)
  const [sort, setSort] = useState<'recent' | 'top' | 'photos'>('recent')
  const [ratingFilter, setRatingFilter] = useState<number | 0>(0)
  const [onlyPhotos, setOnlyPhotos] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

  const key = useMemo(() => {
    const q = new URLSearchParams({ product_id: String(pid), sort })
    if (ratingFilter) q.set('rating', String(ratingFilter))
    if (onlyPhotos) q.set('with_photos', 'true')
    return `/api/reviews?${q}`
  }, [pid, sort, ratingFilter, onlyPhotos])

  const { data, mutate, isLoading } = useSWR<{ reviews: ApiReview[]; header: ApiHeader | null }>(key, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  })
  const reviews = data?.reviews ?? []
  const header = data?.header

  const avg = header?.average || product.rating || 0
  const count = header?.count || 0
  const stars = header?.stars || { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
  const photoStrip = header?.photoStrip || []

  const [helpful, setHelpful] = useState<Record<number, number>>({})
  const voteHelpful = useCallback(async (id: number) => {
    if (helpful[id]) return
    setHelpful((h) => ({ ...h, [id]: 1 }))
    try {
      const res = await fetch(`/api/reviews/${id}/helpful`, { method: 'POST' })
      const d = await res.json()
      if (d?.counted === false) toast.message('Vous avez déjà voté pour cet avis')
    } catch {
      /* silencieux */
    }
  }, [helpful])

  return (
    <div>
      <div className="flex items-center gap-2 mb-6">
        <div className="w-1 h-5 bg-accent rounded-full" />
        <h2 className="text-xl font-black uppercase tracking-tight">
          Avis clients {count > 0 && <span className="text-muted-foreground">({count})</span>}
        </h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-10">
        {/* ── Colonne gauche : résumé + form ── */}
        <div className="md:col-span-4 space-y-6">
          <div className="bg-muted/40 p-7 rounded-3xl text-center">
            <p className="text-5xl font-black">{avg ? avg.toFixed(1) : '—'}</p>
            <div className="flex justify-center gap-1 my-3">
              {[...Array(5)].map((_, i) => (
                <Star
                  key={i}
                  size={18}
                  className={cn('fill-orange-400 text-orange-400', i >= Math.round(avg) && 'text-slate-200 fill-slate-200')}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest">
              {count > 0 ? `${count} avis` : 'Aucun avis pour le moment'}
            </p>
          </div>

          {count > 0 && (
            <div className="space-y-2">
              {[5, 4, 3, 2, 1].map((s) => {
                const c = stars[String(s)] || 0
                const pct = count > 0 ? Math.round((c / count) * 100) : 0
                const active = ratingFilter === s
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setRatingFilter(active ? 0 : s)}
                    className={cn(
                      'w-full flex items-center gap-3 text-xs font-bold rounded-lg px-2 py-1.5 transition-colors',
                      active ? 'bg-accent/10 text-accent' : 'hover:bg-muted'
                    )}
                  >
                    <span className="w-10 text-left flex items-center gap-0.5">
                      {s}
                      <Star size={11} className="fill-orange-400 text-orange-400" />
                    </span>
                    <span className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <span className="block h-full bg-orange-400" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="w-9 text-right text-muted-foreground">{c}</span>
                  </button>
                )
              })}
              {header && header.withPhotos > 0 && (
                <button
                  type="button"
                  onClick={() => setOnlyPhotos((v) => !v)}
                  className={cn(
                    'w-full mt-1 flex items-center justify-center gap-2 text-xs font-bold rounded-lg px-2 py-2 border transition-colors',
                    onlyPhotos ? 'border-accent text-accent bg-accent/5' : 'border-border hover:bg-muted'
                  )}
                >
                  <ImagePlus size={14} /> Avec photos ({header.withPhotos})
                </button>
              )}
            </div>
          )}

          {user?.sub ? (
            <Button
              onClick={() => setShowForm((v) => !v)}
              className="w-full rounded-2xl h-12 font-black uppercase tracking-wide"
            >
              {showForm ? 'Fermer' : 'Écrire un avis'}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground text-center leading-relaxed">
              Connectez-vous et achetez ce produit pour laisser un avis vérifié.
            </p>
          )}

          {showForm && user?.sub && (
            <ReviewForm
              productId={pid}
              onDone={() => {
                setShowForm(false)
                mutate()
              }}
            />
          )}
        </div>

        {/* ── Colonne droite : bandeau photos + tri + liste ── */}
        <div className="md:col-span-8 space-y-6">
          {photoStrip.length > 0 && (
            <div>
              <p className="text-[11px] font-black uppercase tracking-widest text-muted-foreground mb-3">
                Photos des clients
              </p>
              <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
                {photoStrip.map((src) => (
                  <button
                    key={src}
                    type="button"
                    onClick={() => setLightbox(src)}
                    className="relative shrink-0 w-20 h-20 rounded-xl overflow-hidden border border-border/50 bg-muted"
                  >
                    <Image src={src} alt="Photo d'avis" fill sizes="80px" className="object-cover" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {count > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              {(
                [
                  ['recent', 'Plus récents'],
                  ['top', 'Mieux notés'],
                  ['photos', 'Avec photos'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSort(k)}
                  className={cn(
                    'text-xs font-bold rounded-full px-3.5 py-1.5 border transition-colors',
                    sort === k ? 'border-accent text-accent bg-accent/5' : 'border-border text-muted-foreground hover:bg-muted'
                  )}
                >
                  {label}
                </button>
              ))}
              {(ratingFilter > 0 || onlyPhotos) && (
                <button
                  type="button"
                  onClick={() => {
                    setRatingFilter(0)
                    setOnlyPhotos(false)
                  }}
                  className="text-xs font-bold text-accent underline underline-offset-2"
                >
                  Réinitialiser les filtres
                </button>
              )}
            </div>
          )}

          {isLoading ? (
            <div className="py-16 text-center text-muted-foreground">
              <Loader2 size={24} className="mx-auto animate-spin opacity-40" />
            </div>
          ) : reviews.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Star size={40} className="mx-auto mb-4 opacity-20" />
              <p className="font-bold text-sm">Aucun avis {ratingFilter || onlyPhotos ? 'pour ce filtre' : "pour l'instant"}</p>
              <p className="text-xs mt-1">Soyez le premier à partager votre expérience.</p>
            </div>
          ) : (
            <ul className="space-y-7 list-none p-0 m-0">
              {reviews.map((rev) => {
                const hc = rev.helpfulCount + (helpful[rev.id] || 0)
                return (
                  <li key={rev.id} className="border-b border-border/60 pb-7 last:border-0">
                    <div className="flex justify-between items-start mb-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-full overflow-hidden bg-muted flex items-center justify-center font-black text-muted-foreground text-sm shrink-0">
                          {rev.avatar ? (
                            <Image src={rev.avatar} alt={rev.reviewer} width={40} height={40} className="object-cover w-full h-full" />
                          ) : (
                            (rev.reviewer || 'C')[0].toUpperCase()
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-black flex items-center gap-1.5 flex-wrap">
                            <span className="truncate">{rev.reviewer}</span>
                            {flagUrl(rev.country) && (
                              <Image
                                src={flagUrl(rev.country)}
                                alt={rev.country}
                                width={16}
                                height={11}
                                className="rounded-[2px] border border-border/40"
                              />
                            )}
                            {rev.verified ? (
                              <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-600 text-[8px] px-1.5 py-0.5 rounded-full uppercase tracking-tighter font-black">
                                <ShieldCheck size={9} /> Achat vérifié
                              </span>
                            ) : rev.isCommunity ? (
                              <span className="inline-flex items-center gap-1 bg-slate-100 text-slate-500 text-[8px] px-1.5 py-0.5 rounded-full uppercase tracking-tighter font-black">
                                <Users size={9} /> Avis de la communauté
                              </span>
                            ) : null}
                          </p>
                          <div className="flex gap-0.5 mt-0.5">
                            {[...Array(5)].map((_, i) => (
                              <Star
                                key={i}
                                size={11}
                                className={cn('fill-orange-400 text-orange-400', i >= rev.rating && 'text-slate-200 fill-slate-200')}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                      <span className="text-[10px] text-muted-foreground font-bold uppercase shrink-0" suppressHydrationWarning>
                        {fmtDate(rev.date)}
                      </span>
                    </div>

                    {rev.title && <p className="text-sm font-bold mb-1">{rev.title}</p>}
                    {rev.review && <p className="text-sm text-foreground/80 leading-relaxed">{rev.review}</p>}

                    {rev.photos.length > 0 && (
                      <div className="flex gap-2 mt-3 flex-wrap">
                        {rev.photos.map((src) => (
                          <button
                            key={src}
                            type="button"
                            onClick={() => setLightbox(src)}
                            className="relative w-16 h-16 rounded-lg overflow-hidden border border-border/50 bg-muted"
                          >
                            <Image src={src} alt="" fill sizes="64px" className="object-cover" />
                          </button>
                        ))}
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => voteHelpful(rev.id)}
                      className={cn(
                        'mt-3 inline-flex items-center gap-1.5 text-[11px] font-bold rounded-full border px-3 py-1 transition-colors',
                        helpful[rev.id] ? 'border-accent text-accent bg-accent/5' : 'border-border text-muted-foreground hover:bg-muted'
                      )}
                    >
                      <ThumbsUp size={12} /> Utile{hc > 0 ? ` · ${hc}` : ''}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      {lightbox && (
        <div
          role="button"
          tabIndex={0}
          onClick={() => setLightbox(null)}
          onKeyDown={(e) => e.key === 'Escape' && setLightbox(null)}
          className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6"
        >
          <button
            type="button"
            aria-label="Fermer"
            className="absolute top-5 right-5 w-11 h-11 rounded-full bg-white/10 text-white flex items-center justify-center"
          >
            <X size={22} />
          </button>
          <div className="relative w-full max-w-2xl aspect-square">
            <Image src={lightbox} alt="Photo d'avis" fill sizes="90vw" className="object-contain" />
          </div>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   Mini-formulaire : réservé aux acheteurs vérifiés.
   1. choisir la commande livrée + le produit à noter
   2. étoiles + titre + texte + upload photos (4 max)
   ───────────────────────────────────────────────────────────── */
function ReviewForm({ productId, onDone }: { productId: number; onDone: () => void }) {
  const [orderId, setOrderId] = useState('')
  const [rating, setRating] = useState(0)
  const [hover, setHover] = useState(0)
  const [title, setTitle] = useState('')
  const [comment, setComment] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const uploadPhotos = async (files: FileList | File[]) => {
    const remaining = 4 - photos.length
    const list = Array.from(files).slice(0, remaining)
    if (list.length === 0) return
    setUploading(true)
    try {
      for (const f of list) {
        const fd = new FormData()
        fd.append('file', f)
        const res = await fetch('/api/reviews/upload', { method: 'POST', body: fd })
        const d = await res.json()
        if (d?.url) setPhotos((p) => [...p, d.url])
        else toast.error(d?.message || "Échec de l'upload d'une photo")
      }
    } finally {
      setUploading(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!orderId.trim()) return toast.error('Indiquez le numéro de la commande concernée')
    if (rating === 0) return toast.error('Choisissez une note de 1 à 5 étoiles')
    if (comment.trim().length < 10) return toast.error('Avis trop court (10 caractères minimum)')
    setSending(true)
    try {
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: productId,
          order_id: Number(orderId.trim().replace(/\D/g, '')) || orderId.trim(),
          rating,
          title: title.trim(),
          review: comment.trim(),
          photos,
        }),
      })
      const d = await res.json()
      if (d.success) {
        toast.success(d.message || 'Avis envoyé')
        onDone()
      } else {
        toast.error(d.message || "Erreur lors de l'envoi")
      }
    } catch {
      toast.error('Impossible de joindre le serveur')
    } finally {
      setSending(false)
    }
  }

  return (
    <form onSubmit={submit} className="bg-white p-5 rounded-3xl border border-border shadow-lg space-y-4">
      <p className="font-black uppercase text-[11px] tracking-widest text-muted-foreground text-center">
        Votre avis
      </p>

      <label className="block">
        <span className="text-[11px] font-bold text-muted-foreground">N° de commande (achat livré)</span>
        <input
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          placeholder="ex. 10428"
          className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
        />
      </label>

      <div className="flex flex-col items-center gap-1">
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((s) => (
            <button
              key={s}
              type="button"
              onMouseEnter={() => setHover(s)}
              onMouseLeave={() => setHover(0)}
              onClick={() => setRating(s)}
              className="p-0.5"
            >
              <Star
                size={26}
                className={cn(
                  'transition-colors',
                  (hover || rating) >= s ? 'fill-orange-400 text-orange-400' : 'text-slate-200 fill-slate-200'
                )}
              />
            </button>
          ))}
        </div>
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Titre (facultatif)"
        maxLength={120}
        className="w-full rounded-xl border border-border px-3 py-2 text-sm"
      />
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Décrivez votre expérience avec ce produit…"
        rows={4}
        maxLength={1500}
        className="w-full rounded-xl border border-border px-3 py-2 text-sm resize-none"
      />

      {/* photos */}
      <div>
        <div className="flex gap-2 flex-wrap">
          {photos.map((src) => (
            <div key={src} className="relative w-16 h-16 rounded-lg overflow-hidden border border-border">
              <Image src={src} alt="" fill sizes="64px" className="object-cover" />
              <button
                type="button"
                onClick={() => setPhotos((p) => p.filter((x) => x !== src))}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black text-white flex items-center justify-center"
              >
                <X size={11} />
              </button>
            </div>
          ))}
          {photos.length < 4 && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-16 h-16 rounded-lg border-2 border-dashed border-border flex items-center justify-center text-muted-foreground hover:border-accent hover:text-accent transition-colors"
            >
              {uploading ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} />}
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && uploadPhotos(e.target.files)}
        />
        <p className="text-[10px] text-muted-foreground mt-1.5">Jusqu&apos;à 4 photos.</p>
      </div>

      <Button type="submit" disabled={sending} className="w-full rounded-2xl h-11 font-black uppercase tracking-wide">
        {sending ? <Loader2 size={16} className="animate-spin" /> : 'Publier mon avis'}
      </Button>
    </form>
  )
}

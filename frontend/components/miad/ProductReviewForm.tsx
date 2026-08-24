"use client"
import React, { useState } from 'react'
import { Star, Loader2, Send } from 'lucide-react'
import { Button } from '../ui/button'
import { toast } from 'sonner'

interface ProductReviewFormProps {
  productId: number
  productName: string
  user?: { email?: string; display_name?: string; name?: string; [key: string]: any } | null
  onReviewSubmitted?: () => void
}

export function ProductReviewForm({ productId, productName, user, onReviewSubmitted }: ProductReviewFormProps) {
  const [rating, setRating] = useState(0)
  const [hoverRating, setHoverRating] = useState(0)
  const [comment, setComment] = useState('')
  const [name, setName] = useState(user?.display_name || user?.name || '')
  const [email, setEmail] = useState(user?.email || '')
  const [isPending, setIsPending] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  if (submitted) {
    return (
      <div className="p-8 border-2 border-dashed border-green-200 rounded-[2.5rem] text-center bg-green-50/50">
        <div className="w-12 h-12 bg-green-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Star className="text-green-500 fill-green-500" size={24} />
        </div>
        <p className="text-green-700 font-black text-sm mb-1">Merci pour votre avis !</p>
        <p className="text-green-600 text-xs">Il sera publié après validation par notre équipe.</p>
      </div>
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (rating === 0) return toast.error('Choisissez une note de 1 à 5 étoiles')
    if (comment.trim().length < 10) return toast.error('Votre avis est trop court (10 caractères minimum)')
    if (!name.trim()) return toast.error('Votre nom est requis')
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) return toast.error('Adresse email invalide')

    setIsPending(true)
    try {
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: productId,
          rating,
          review: comment.trim(),
          reviewer: name.trim(),
          reviewer_email: email.trim(),
        }),
      })
      const data = await res.json()
      if (data.success) {
        setSubmitted(true)
        onReviewSubmitted?.()
      } else {
        toast.error(data.message || "Erreur lors de l'envoi")
      }
    } catch {
      toast.error('Impossible de joindre le serveur')
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="bg-white p-6 md:p-8 rounded-4xl border border-slate-100 shadow-xl overflow-hidden mt-8">
      <h3 className="font-black uppercase text-xs mb-6 tracking-widest text-slate-500 text-center">
        DONNEZ VOTRE AVIS
      </h3>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Étoiles */}
        <div className="flex flex-col items-center gap-2">
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => setRating(star)}
                onMouseEnter={() => setHoverRating(star)}
                onMouseLeave={() => setHoverRating(0)}
                aria-label={`${star} étoile${star > 1 ? 's' : ''}`}
                className="transition-transform active:scale-90"
              >
                <Star
                  size={26}
                  className={`transition-colors ${(hoverRating || rating) >= star ? 'fill-yellow-400 text-yellow-400' : 'text-slate-200'}`}
                />
              </button>
            ))}
          </div>
          {rating > 0 && (
            <p className="text-xs font-bold text-slate-400">
              {['', 'Très mauvais', 'Mauvais', 'Correct', 'Bien', 'Excellent !'][rating]}
            </p>
          )}
        </div>

        {/* Nom et email */}
        <div className="grid grid-cols-2 gap-3">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Votre nom"
            maxLength={100}
            className="rounded-2xl px-4 py-3 bg-slate-50 border border-slate-100 focus:ring-2 focus:ring-accent/20 outline-none text-sm transition-all"
          />
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="Votre email"
            maxLength={200}
            className="rounded-2xl px-4 py-3 bg-slate-50 border border-slate-100 focus:ring-2 focus:ring-accent/20 outline-none text-sm transition-all"
          />
        </div>

        {/* Texte de l'avis */}
        <textarea
          value={comment}
          onChange={e => setComment(e.target.value)}
          placeholder="Décrivez votre expérience avec ce produit..."
          maxLength={1000}
          className="w-full min-h-[110px] rounded-2xl px-5 py-4 bg-slate-50 border border-slate-100 focus:ring-2 focus:ring-accent/20 outline-none text-sm resize-none transition-all"
        />
        <p className="text-[10px] text-slate-300 text-right -mt-3">{comment.length}/1000</p>

        <p className="text-[10px] text-slate-400 text-center">
          Votre email ne sera pas affiché. L'avis sera vérifié avant publication.
        </p>

        <Button
          type="submit"
          disabled={isPending}
          className="w-full h-14 bg-accent hover:bg-accent/90 text-white rounded-2xl font-black uppercase text-xs tracking-widest gap-3 shadow-lg shadow-accent/20 transition-transform active:scale-95"
        >
          {isPending ? <Loader2 className="animate-spin" size={18} /> : <><Send size={16} /> PUBLIER MON AVIS</>}
        </Button>
      </form>
    </div>
  )
}

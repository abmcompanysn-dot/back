"use client"

import { useState } from 'react'
import useSWR from 'swr'
import { Send, Smartphone, Loader2, CheckCircle2, AlertCircle, Bell } from 'lucide-react'

interface Stats {
  devices: number
  devices_linked: number
}

interface SendResult {
  ok: boolean
  sent?: number
}

const TEMPLATES = [
  { label: 'Promotion', title: '🔥 Offre exclusive MIAD Market', text: "Jusqu'à -50% sur une sélection de produits africains, jusqu'à ce week-end !" },
  { label: 'Nouveautés', title: '🌍 Nouvelles arrivées', text: 'Nos vendeurs viennent d\'ajouter de nouvelles créations artisanales. Venez découvrir !' },
  { label: 'Message personnalisé', title: '', text: '' },
]

const statsFetcher = (url: string) => {
  const token = localStorage.getItem('miad_token')
  if (!token) return Promise.resolve(null)
  return fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
}

export function PushBlast() {
  const [title, setTitle]       = useState('')
  const [text, setText]         = useState('')
  const [url, setUrl]           = useState('')
  const [sending, setSending]   = useState(false)
  const [result, setResult]     = useState<SendResult | null>(null)
  const [template, setTemplate] = useState(0)

  const { data: stats } = useSWR<Stats>('/api/admin/push', statsFetcher)

  const applyTemplate = (idx: number) => {
    setTemplate(idx)
    setTitle(TEMPLATES[idx].title)
    setText(TEMPLATES[idx].text)
  }

  const handleSend = async () => {
    if (!title.trim() || !text.trim()) return
    setSending(true)
    setResult(null)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch('/api/admin/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title, text, url }),
      })
      const data = await res.json()
      setResult({ ok: res.ok && data.success !== false, sent: data.sent })
    } catch {
      setResult({ ok: false })
    }
    setSending(false)
  }

  return (
    <div className="space-y-5">

      {result && (
        <div className={`flex items-start gap-3 p-4 rounded-xl border ${result.ok ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          {result.ok
            ? <CheckCircle2 size={18} className="text-green-600 shrink-0 mt-0.5" />
            : <AlertCircle  size={18} className="text-red-600 shrink-0 mt-0.5" />
          }
          <div className="text-sm">
            {result.ok ? (
              <p className="font-bold text-green-800">
                Envoyée à <strong>{result.sent ?? 0}</strong> appareil{(result.sent ?? 0) > 1 ? 's' : ''}
              </p>
            ) : (
              <p className="font-bold text-red-700">Erreur lors de l'envoi. Vérifiez les logs.</p>
            )}
          </div>
          <button type="button" onClick={() => setResult(null)} className="ml-auto text-xs text-muted-foreground hover:underline">Fermer</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* Left: Composer */}
        <div className="space-y-4">

          <div>
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-2">Template rapide</p>
            <div className="flex flex-wrap gap-2">
              {TEMPLATES.map((t, i) => (
                <button
                  type="button"
                  key={t.label}
                  onClick={() => applyTemplate(i)}
                  className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${template === i ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-border hover:bg-muted'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-border bg-background text-xs">
            <Smartphone size={14} className="text-primary shrink-0" />
            <span>
              <span className="font-bold">Destinataires : tous les appareils abonnés</span>
              <span className="block text-[10px] text-muted-foreground mt-0.5">Notification native, uniquement les visiteurs ayant accepté les notifications.</span>
            </span>
          </div>

          <div>
            <label htmlFor="push-blast-title" className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-1.5">Titre</label>
            <input
              id="push-blast-title"
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Titre de la notification…"
              maxLength={65}
              className="w-full h-10 px-3 border border-border rounded-xl bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label htmlFor="push-blast-text" className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-1.5">Message</label>
            <textarea
              id="push-blast-text"
              value={text}
              onChange={e => setText(e.target.value)}
              rows={4}
              maxLength={180}
              placeholder="Votre message ici…"
              className="w-full px-3 py-2.5 border border-border rounded-xl bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            />
          </div>

          <div>
            <label htmlFor="push-blast-url" className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-1.5">Lien au clic (optionnel)</label>
            <input
              id="push-blast-url"
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://www.miadmarket.com/…"
              className="w-full h-10 px-3 border border-border rounded-xl bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <button
            type="button"
            onClick={handleSend}
            disabled={sending || !title.trim() || !text.trim()}
            className="w-full h-12 bg-primary text-primary-foreground rounded-xl font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-40 hover:bg-primary/90 transition-colors"
          >
            {sending
              ? <><Loader2 size={16} className="animate-spin" />Envoi en cours…</>
              : <><Send size={15} />Envoyer{stats ? ` (${stats.devices.toLocaleString()})` : ''}</>
            }
          </button>
        </div>

        {/* Right: Preview */}
        <div className="space-y-3">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Aperçu</p>

          <div className="border border-border rounded-2xl overflow-hidden bg-muted/20 p-4" style={{ minHeight: 200 }}>
            <div className="bg-white rounded-2xl shadow-md p-3.5 flex gap-3 items-start border border-border/50">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <Bell size={18} className="text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-bold text-foreground truncate">{title || 'Titre de la notification'}</p>
                  <span className="text-[9px] text-muted-foreground shrink-0">maintenant</span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{text || 'Votre message apparaîtra ici…'}</p>
                <p className="text-[9px] text-muted-foreground/70 mt-1">miadmarket.com</p>
              </div>
            </div>
          </div>

          {stats && (
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-muted/30 rounded-xl p-3 text-center border border-border">
                <p className="text-lg font-black">{stats.devices.toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Appareils abonnés</p>
              </div>
              <div className="bg-muted/30 rounded-xl p-3 text-center border border-border">
                <p className="text-lg font-black">{stats.devices_linked.toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Liés à un compte</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

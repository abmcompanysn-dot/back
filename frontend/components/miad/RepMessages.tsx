"use client"

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import { Send, MessageCircle, User, Loader2, ChevronLeft, Mail, RefreshCw } from 'lucide-react'

interface Reply {
  from: 'rep' | 'admin' | 'client'
  name: string
  text: string
  at: string
}

interface Message {
  id: number
  client_name: string
  client_email: string
  message: string
  rep_id: number
  rep_name: string
  country: string
  status: 'new' | 'replied' | 'closed'
  replies: Reply[]
  created_at: string
}

interface RepMessagesProps {
  repId: number
  repName: string
  repAvatar: string
  isAdmin?: boolean
}

const STATUS_LABEL: Record<string, string> = {
  new:     'Nouveau',
  replied: 'Répondu',
  closed:  'Fermé',
}

const STATUS_COLOR: Record<string, string> = {
  new:     'bg-red-100 text-red-700',
  replied: 'bg-blue-100 text-blue-700',
  closed:  'bg-gray-100 text-gray-500',
}

function fmtDate(str: string) {
  if (!str) return ''
  const d = new Date(str)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  return isToday
    ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function RepMessages({ repName, repAvatar, isAdmin = false }: RepMessagesProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [active, setActive]     = useState<Message | null>(null)
  const [text, setText]         = useState('')
  const [sending, setSending]   = useState(false)
  const [loading, setLoading]   = useState(true)
  const [filter, setFilter]     = useState('')

  const fetchMessages = useCallback(async () => {
    const token = localStorage.getItem('miad_token')
    if (!token) { setLoading(false); return }
    const params = new URLSearchParams()
    if (filter) params.set('status', filter)
    try {
      const res = await fetch(`/api/messages?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      if (res.ok) {
        const data = await res.json()
        if (data.messages) {
          setMessages(data.messages)
          if (active) {
            const updated = (data.messages as Message[]).find(m => m.id === active.id)
            if (updated) setActive(updated)
          }
        }
      }
    } catch {}
    setLoading(false)
  }, [filter, active?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchMessages()
    const id = setInterval(fetchMessages, 30_000)
    return () => clearInterval(id)
  }, [fetchMessages])

  const sendReply = async () => {
    if (!text.trim() || !active || sending) return
    const t = text.trim()
    setText('')
    setSending(true)
    const token = localStorage.getItem('miad_token')
    try {
      await fetch(`/api/messages/${active.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          text: t,
          from_name: repName,
          from_role: isAdmin ? 'admin' : 'rep',
          client_email: active.client_email,
          client_name: active.client_name,
        }),
      })
      await fetchMessages()
    } catch {}
    setSending(false)
  }

  const setStatus = async (id: number, status: string) => {
    const token = localStorage.getItem('miad_token')
    await fetch(`/api/messages/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status }),
    })
    await fetchMessages()
  }

  const totalNew = messages.filter(m => m.status === 'new').length

  if (loading) {
    return (
      <div className="bg-card rounded-2xl border border-border flex items-center justify-center" style={{ height: '520px' }}>
        <Loader2 size={28} className="animate-spin text-primary" />
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border flex flex-col items-center justify-center py-16 text-center shadow-sm">
        <MessageCircle size={40} className="text-muted-foreground/30 mb-3" />
        <p className="font-bold text-muted-foreground">Aucun message</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-xs">
          Les messages clients apparaîtront ici dès qu'ils vous contactent.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm flex" style={{ minHeight: '520px', maxHeight: '680px' }}>

      {/* ── List ─────────────────────────────────────────────────── */}
      <div className={`w-full md:w-72 shrink-0 border-r border-border flex flex-col ${active ? 'hidden md:flex' : 'flex'}`}>
        <div className="px-4 py-3.5 border-b border-border flex items-center justify-between shrink-0">
          <div>
            <h3 className="font-black text-xs uppercase tracking-widest">Messages</h3>
            {totalNew > 0 && (
              <p className="text-[11px] text-red-600 font-bold mt-0.5">
                {totalNew} nouveau{totalNew > 1 ? 'x' : ''}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <select
              value={filter}
              onChange={e => setFilter(e.target.value)}
              aria-label="Filtrer par statut"
              className="text-[11px] border border-border rounded-lg px-1.5 py-1 bg-background"
            >
              <option value="">Tous</option>
              <option value="new">Nouveaux</option>
              <option value="replied">Répondus</option>
              <option value="closed">Fermés</option>
            </select>
            <button type="button" onClick={fetchMessages} aria-label="Actualiser les messages" className="p-1 rounded hover:bg-muted transition-colors">
              <RefreshCw size={13} className="text-muted-foreground" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-border">
          {messages.map(m => (
            <button
              key={m.id}
              type="button"
              onClick={() => { setActive(m); setText('') }}
              className={`w-full text-left px-4 py-3.5 hover:bg-muted/30 transition-colors ${active?.id === m.id ? 'bg-primary/5 border-l-2 border-primary pl-3.5' : ''}`}
            >
              <div className="flex items-start gap-2.5">
                <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                  <User size={15} className="text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1 mb-0.5">
                    <p className="text-xs font-bold truncate">{m.client_name}</p>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold shrink-0 ${STATUS_COLOR[m.status] || 'bg-gray-100 text-gray-500'}`}>
                      {STATUS_LABEL[m.status] || m.status}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">{m.message}</p>
                  <p className="text-[10px] text-muted-foreground/50 mt-0.5">{fmtDate(m.created_at)}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Detail ───────────────────────────────────────────────── */}
      {active ? (
        <div className="flex-1 flex flex-col min-w-0 min-h-0">

          {/* Header */}
          <div className="px-4 py-3 border-b border-border flex items-center gap-3 shrink-0 bg-muted/20">
            <button type="button" onClick={() => setActive(null)} aria-label="Retour à la liste" className="md:hidden p-1.5 rounded-lg hover:bg-muted transition-colors shrink-0">
              <ChevronLeft size={18} />
            </button>
            <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0">
              <User size={15} className="text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm truncate">{active.client_name}</p>
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5">
                <Mail size={10} />{active.client_email}
              </span>
            </div>
            <select
              value={active.status}
              onChange={e => setStatus(active.id, e.target.value)}
              aria-label="Statut de la conversation"
              className="text-[11px] border border-border rounded-lg px-2 py-1 bg-background shrink-0"
            >
              <option value="new">Nouveau</option>
              <option value="replied">Répondu</option>
              <option value="closed">Fermé</option>
            </select>
          </div>

          {/* Thread */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">

            {/* Original message */}
            <div className="flex items-start gap-2.5">
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                <User size={14} className="text-muted-foreground" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1.5">
                  <p className="text-xs font-bold">{active.client_name}</p>
                  <span className="text-[10px] text-muted-foreground">{fmtDate(active.created_at)}</span>
                </div>
                <div className="bg-muted rounded-2xl rounded-tl-none px-4 py-3 inline-block max-w-[85%]">
                  <p className="text-sm leading-relaxed">{active.message}</p>
                </div>
              </div>
            </div>

            {/* Replies */}
            {active.replies.map((r) => {
              const isOutgoing = r.from !== 'client'
              return (
                <div key={`${r.from}-${r.at}`} className={`flex items-start gap-2.5 ${isOutgoing ? 'flex-row-reverse' : ''}`}>
                  {isOutgoing ? (
                    repAvatar
                      ? <Image src={repAvatar} alt="" width={32} height={32} className="w-8 h-8 rounded-full object-cover shrink-0 mt-0.5" />
                      : <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5"><User size={14} className="text-primary" /></div>
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5"><User size={14} className="text-muted-foreground" /></div>
                  )}
                  <div className={`flex-1 flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}>
                    <div className={`flex items-center gap-2 mb-1.5 ${isOutgoing ? 'flex-row-reverse' : ''}`}>
                      <p className="text-xs font-bold">{r.name}</p>
                      <span className="text-[10px] text-muted-foreground">{fmtDate(r.at)}</span>
                    </div>
                    <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed max-w-[85%] ${isOutgoing ? 'bg-primary text-primary-foreground rounded-br-none' : 'bg-muted text-foreground rounded-bl-none'}`}>
                      {r.text}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Reply input */}
          {active.status !== 'closed' && (
            <div className="border-t border-border px-3 py-3 flex items-center gap-2 shrink-0">
              <input
                value={text}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply() } }}
                placeholder={`Répondre à ${active.client_name}…`}
                className="flex-1 h-10 px-3 border border-border rounded-xl bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button
                type="button"
                onClick={sendReply}
                disabled={!text.trim() || sending}
                aria-label="Envoyer"
                className="w-10 h-10 bg-primary rounded-xl flex items-center justify-center disabled:opacity-40 hover:bg-primary/90 transition-colors shrink-0"
              >
                {sending
                  ? <Loader2 size={14} className="animate-spin text-primary-foreground" />
                  : <Send size={14} className="text-primary-foreground" />}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="hidden md:flex flex-1 items-center justify-center text-center p-8">
          <div>
            <MessageCircle size={40} className="mx-auto text-muted-foreground/20 mb-3" />
            <p className="text-sm font-bold text-muted-foreground">Sélectionnez un message</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Cliquez pour lire et répondre</p>
          </div>
        </div>
      )}
    </div>
  )
}

"use client"

import { useState } from 'react'
import useSWR from 'swr'
import { Send, Mail, Users, User, Eye, EyeOff, Loader2, CheckCircle2, AlertCircle, ChevronDown, LayoutGrid, List } from 'lucide-react'

type Audience = 'single' | 'subscribers' | 'customers' | 'all'

interface Stats {
  subscribers_active: number
  customers: number
  all_unique: number
}

interface SendResult {
  ok: boolean
  sent?: number
  failed?: number
  total?: number
  to?: string
}

const TEMPLATES = [
  {
    label: 'Offre promotionnelle',
    subject: '🔥 Offre exclusive MIAD Market — Jusqu\'à -50% !',
    body: '<h2>Offre exclusive pour vous !</h2>\n<p>Bonjour {customer_name},</p>\n<p>Nous avons sélectionné pour vous des produits africains d\'exception à des prix exceptionnels.</p>\n<p>Profitez de <strong>-50% sur une sélection de produits</strong> valable jusqu\'à ce week-end.</p>',
  },
  {
    label: 'Nouveaux produits',
    subject: '🌍 Nouvelles arrivées sur MIAD Market !',
    body: '<h2>De nouveaux produits africains vous attendent !</h2>\n<p>Bonjour {customer_name},</p>\n<p>Nos vendeurs vérifiés viennent d\'ajouter de magnifiques créations artisanales africaines.</p>\n<p>Découvrez nos dernières arrivées et faites-vous plaisir.</p>',
  },
  {
    label: 'Message personnalisé',
    subject: '',
    body: '',
  },
]

const statsFetcher = (url: string) => {
  const token = localStorage.getItem('miad_token')
  if (!token) return Promise.resolve(null)
  return fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
}

export function EmailBlast() {
  const [mode, setMode]         = useState<Audience>('subscribers')
  const [to, setTo]             = useState('')
  const [subject, setSubject]   = useState('')
  const [body, setBody]         = useState('')
  const [preview, setPreview]   = useState(false)
  const [sending, setSending]   = useState(false)
  const [result, setResult]     = useState<SendResult | null>(null)
  const [template, setTemplate] = useState(0)
  const [includeRecommendations, setIncludeRecommendations] = useState(false)
  const [productLayout, setProductLayout] = useState<'grid' | 'list'>('grid')

  const { data: stats } = useSWR<Stats>('/api/admin/email', statsFetcher)

  const applyTemplate = (idx: number) => {
    setTemplate(idx)
    setSubject(TEMPLATES[idx].subject)
    setBody(TEMPLATES[idx].body)
  }

  const audienceLabel: Record<Audience, string> = {
    single:      'Un email précis',
    subscribers: `Abonnés newsletter (${stats?.subscribers_active ?? '…'})`,
    customers:   `Clients WooCommerce (${stats?.customers ?? '…'})`,
    all:         `Tous (${stats?.all_unique ?? '…'} uniques)`,
  }

  const handleSend = async () => {
    if (!subject.trim() || !body.trim()) return
    if (mode === 'single' && !to.trim()) return
    setSending(true)
    setResult(null)
    try {
      const token = localStorage.getItem('miad_token')
      const res = await fetch('/api/admin/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          mode: mode === 'single' ? 'single' : 'broadcast',
          to,
          subject,
          content: body,
          audience: mode === 'single' ? undefined : mode,
          includeRecommendations,
          template: productLayout,
        }),
      })
      const data = await res.json()
      setResult(data)
    } catch {
      setResult({ ok: false })
    }
    setSending(false)
  }

  const recipientCount =
    mode === 'single'      ? 1
    : mode === 'subscribers' ? (stats?.subscribers_active ?? 0)
    : mode === 'customers'   ? (stats?.customers ?? 0)
    : (stats?.all_unique ?? 0)

  return (
    <div className="space-y-5">

      {/* Result banner */}
      {result && (
        <div className={`flex items-start gap-3 p-4 rounded-xl border ${result.ok ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          {result.ok
            ? <CheckCircle2 size={18} className="text-green-600 shrink-0 mt-0.5" />
            : <AlertCircle  size={18} className="text-red-600 shrink-0 mt-0.5" />
          }
          <div className="text-sm">
            {result.ok ? (
              result.to
                ? <p className="font-bold text-green-800">Email envoyé à <strong>{result.to}</strong></p>
                : <p className="font-bold text-green-800">
                    Envoyé à <strong>{result.sent}</strong> destinataire{(result.sent ?? 0) > 1 ? 's' : ''}
                    {(result.failed ?? 0) > 0 && <span className="text-orange-600"> · {result.failed} échec(s)</span>}
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

          {/* Template picker */}
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

          {/* Audience */}
          <div>
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-2">Destinataires</p>
            <div className="grid grid-cols-2 gap-2">
              {(['single', 'subscribers', 'customers', 'all'] as Audience[]).map(a => (
                <button
                  type="button"
                  key={a}
                  onClick={() => { setMode(a); setResult(null) }}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-xs font-bold text-left transition-all ${mode === a ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-background hover:bg-muted'}`}
                >
                  {a === 'single' ? <User size={13} /> : <Users size={13} />}
                  <span className="truncate">{audienceLabel[a]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Recommandations personnalisées */}
          <label className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-border bg-background cursor-pointer text-xs">
            <input
              type="checkbox"
              checked={includeRecommendations}
              onChange={e => setIncludeRecommendations(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <span>
              <span className="font-bold">Inclure des recommandations personnalisées</span>
              <span className="block text-[10px] text-muted-foreground mt-0.5">Ajoute, pour chaque destinataire, des produits basés sur ses vraies commandes (ou les meilleures ventes s'il n'a pas d'historique).</span>
            </span>
          </label>

          {includeRecommendations && (
            <div className="flex items-center gap-2 pl-1">
              <button
                type="button"
                onClick={() => setProductLayout('grid')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold transition-colors ${productLayout === 'grid' ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-background hover:bg-muted'}`}
              >
                <LayoutGrid size={13} /> Grille catalogue
              </button>
              <button
                type="button"
                onClick={() => setProductLayout('list')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold transition-colors ${productLayout === 'list' ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-background hover:bg-muted'}`}
              >
                <List size={13} /> Liste classique
              </button>
            </div>
          )}

          {/* Single email target */}
          {mode === 'single' && (
            <div>
              <label htmlFor="email-blast-to" className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-1.5">Email du destinataire</label>
              <input
                id="email-blast-to"
                type="email"
                value={to}
                onChange={e => setTo(e.target.value)}
                placeholder="client@exemple.com"
                className="w-full h-10 px-3 border border-border rounded-xl bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          )}

          {/* Subject */}
          <div>
            <label htmlFor="email-blast-subject" className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-1.5">Sujet</label>
            <input
              id="email-blast-subject"
              type="text"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Sujet de votre email…"
              className="w-full h-10 px-3 border border-border rounded-xl bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          {/* Body */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="email-blast-body" className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Corps (HTML ou texte)</label>
              <span className="text-[10px] text-muted-foreground">Variable : <code className="bg-muted px-1 rounded">{'{customer_name}'}</code></span>
            </div>
            <textarea
              id="email-blast-body"
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={10}
              placeholder="<h2>Titre</h2>&#10;<p>Votre message ici…</p>"
              className="w-full px-3 py-2.5 border border-border rounded-xl bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            />
          </div>

          {/* Send button */}
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || !subject.trim() || !body.trim() || (mode === 'single' && !to.trim())}
            className="w-full h-12 bg-primary text-primary-foreground rounded-xl font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-40 hover:bg-primary/90 transition-colors"
          >
            {sending
              ? <><Loader2 size={16} className="animate-spin" />Envoi en cours…</>
              : <><Send size={15} />Envoyer{mode !== 'single' && recipientCount > 0 ? ` (${recipientCount.toLocaleString()})` : ''}</>
            }
          </button>
        </div>

        {/* Right: Preview */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Aperçu</p>
            <button
              type="button"
              onClick={() => setPreview(p => !p)}
              className="flex items-center gap-1.5 text-xs text-primary font-medium hover:underline"
            >
              {preview ? <EyeOff size={12} /> : <Eye size={12} />}
              {preview ? 'HTML brut' : 'Rendu visuel'}
            </button>
          </div>

          <div className="border border-border rounded-xl overflow-hidden" style={{ minHeight: 400 }}>
            {/* Simulated email client bar */}
            <div className="bg-muted/50 px-4 py-2.5 border-b border-border flex items-center gap-2">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-red-400" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-400" />
              </div>
              <div className="flex-1 bg-background rounded px-3 py-1 text-[11px] text-muted-foreground border border-border truncate">
                {subject || '(sujet vide)'} — MIAD Market &lt;noreply@miadmarket.com&gt;
              </div>
            </div>

            {preview ? (
              <iframe
                srcDoc={`
<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f0f0f0;margin:0;padding:16px}
.wrap{max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.12)}
.hdr{background:#005826;padding:20px 28px;text-align:center}
.hdr img{max-height:40px}
.bd{padding:28px;font-size:14px;line-height:1.65;color:#333}
.bd h1,.bd h2{color:#005826;font-size:1.15rem;font-weight:800;margin-bottom:10px}
.bd p{margin-bottom:12px}
.btn{display:inline-block;background:#F5A623;color:#111!important;font-weight:800;padding:12px 24px;border-radius:40px;font-size:.82rem;text-transform:uppercase;margin-top:6px}
.ft{background:#005826;color:rgba(255,255,255,.75);padding:20px 28px;text-align:center;font-size:.7rem;border-top:3px solid #F5A623}
</style></head>
<body><div class="wrap">
<div class="hdr"><img src="https://www.miadmarket.com/logo/logo.png" alt="MIAD Market"></div>
<div class="bd">${body || '<p style="color:#9ca3af;font-style:italic">Composez votre message à gauche…</p>'}</div>
<div style="text-align:center;padding:0 28px 24px"><a href="https://www.miadmarket.com" class="btn">Continuer mes achats</a></div>
<div class="ft"><p><strong>MIAD Market</strong> — L'excellence africaine partagée avec le monde.</p></div>
</div></body></html>`}
                style={{ width: '100%', height: 480, border: 'none', background: '#f0f0f0' }}
                title="Aperçu email"
                sandbox="allow-same-origin"
              />
            ) : (
              <div className="p-4 font-mono text-xs text-muted-foreground overflow-auto" style={{ height: 480, background: '#0f172a', color: '#94a3b8' }}>
                <pre className="whitespace-pre-wrap break-all">{body || '// Corps vide'}</pre>
              </div>
            )}
          </div>

          {/* Stats summary */}
          {stats && (
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Abonnés actifs', value: stats.subscribers_active ?? 0 },
                { label: 'Clients WC', value: stats.customers ?? 0 },
                { label: 'Total unique', value: stats.all_unique ?? 0 },
              ].map(s => (
                <div key={s.label} className="bg-muted/30 rounded-xl p-3 text-center border border-border">
                  <p className="text-lg font-black">{s.value.toLocaleString()}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

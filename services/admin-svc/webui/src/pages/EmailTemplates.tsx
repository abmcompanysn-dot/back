import { useEffect, useState } from 'react'
import { ApiError, api } from '../lib/api'
import { EmptyState } from '../components/EmptyState'
import { IconMail } from '../components/Icons'

interface EmailTemplate {
  name: string
  label: string
  subject: string
  body_html: string
  updated_at?: string
}

export function EmailTemplates() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<EmailTemplate | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [showPreview, setShowPreview] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const body = await api.get<{ templates: EmailTemplate[] }>('/admin/api/email-templates')
      setTemplates(body.templates)
      if (body.templates.length > 0 && !selected) {
        select(body.templates[0].name, body.templates)
      }
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : 'échec du chargement', ok: false })
    } finally {
      setLoading(false)
    }
  }

  function select(name: string, list = templates) {
    const t = list.find((x) => x.name === name)
    if (!t) return
    setSelected(name)
    setDraft({ ...t })
    setMessage(null)
    setShowPreview(false)
  }

  async function save() {
    if (!draft) return
    setSaving(true)
    setMessage(null)
    try {
      await api.put(`/admin/api/email-templates/${draft.name}`, {
        label: draft.label,
        subject: draft.subject,
        body_html: draft.body_html,
      })
      setMessage({ text: 'Modèle enregistré — effectif immédiatement, sans redéploiement.', ok: true })
      await load()
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : 'échec de l\'enregistrement', ok: false })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p>Chargement des modèles…</p>

  if (templates.length === 0) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h2>Modèles de messages</h2>
            <p className="subtitle">Emails transactionnels envoyés automatiquement</p>
          </div>
        </div>
        <EmptyState
          icon={<IconMail width={40} height={40} strokeWidth={1.4} />}
          title="Aucun modèle disponible"
          description="Les modèles par défaut n'ont pas encore été initialisés côté serveur."
        />
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Modèles de messages</h2>
          <p className="subtitle">Emails transactionnels envoyés automatiquement (commande, paiement, bienvenue…)</p>
        </div>
      </div>

    <div style={{ display: 'flex', gap: 20 }}>
      <div style={{ width: 220, flexShrink: 0 }}>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {templates.map((t) => (
            <li key={t.name}>
              <button
                onClick={() => select(t.name)}
                className={selected === t.name ? 'btn-primary' : 'btn-ghost'}
                style={{ width: '100%', textAlign: 'left', marginBottom: 6, padding: '8px 10px' }}
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {draft && (
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>{draft.label}</h3>
          <p style={{ fontSize: 12, color: '#666' }}>
            Nom technique : <code>{draft.name}</code>
            {draft.updated_at && ` — modifié le ${new Date(draft.updated_at).toLocaleString('fr-FR')}`}
          </p>

          <label style={{ display: 'block', marginTop: 12, fontSize: 13, fontWeight: 600 }}>
            Sujet
          </label>
          <input
            value={draft.subject}
            onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            style={{ width: '100%', padding: 8, marginTop: 4 }}
          />
          <p style={{ fontSize: 11, color: '#888' }}>
            Variables disponibles : {'{{.order_id}}'}, {'{{.total_usd}}'}, {'{{.frontend_url}}'}
          </p>

          <label style={{ display: 'block', marginTop: 12, fontSize: 13, fontWeight: 600 }}>
            Corps HTML
          </label>
          <textarea
            value={draft.body_html}
            onChange={(e) => setDraft({ ...draft, body_html: e.target.value })}
            rows={18}
            style={{ width: '100%', padding: 8, marginTop: 4, fontFamily: 'monospace', fontSize: 12 }}
          />

          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
            <button className="btn-ghost" onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? 'Masquer l\'aperçu' : 'Aperçu'}
            </button>
            <button className="btn-ghost" onClick={() => select(draft.name)}>
              Annuler les changements
            </button>
          </div>

          {message && (
            <p style={{ fontSize: 13, color: message.ok ? '#0a7a2f' : '#c02020', marginTop: 8 }}>
              {message.text}
            </p>
          )}

          {showPreview && (
            <iframe
              title="aperçu"
              srcDoc={draft.body_html}
              style={{ width: '100%', height: 500, marginTop: 12, border: '1px solid #ddd' }}
            />
          )}
        </div>
      )}
    </div>
    </div>
  )
}

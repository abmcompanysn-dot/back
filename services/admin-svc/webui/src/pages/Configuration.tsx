import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api } from '../lib/api'

// Configuration Système — regroupe toutes les variables auparavant en dur
// dans les fichiers .env du VPS (secrets tiers, seuils métier, URLs) en
// une seule vue éditable sans redéploiement. Chaque onglet correspond à un
// service backend qui expose GET/PUT /settings (relayé ici via
// /admin/api/settings/{service}) — voir kit.SettingsStore. La config DHL
// (fulfillment-svc) a sa propre page dédiée, pas dupliquée ici.

interface FieldMeta {
  key: string
  label: string
  secret?: boolean
  hint?: string
}

interface ServiceTab {
  key: string
  label: string
  fields: FieldMeta[]
}

// Les libellés/hints sont maintenus ici côté UI plutôt que renvoyés par
// le backend (qui n'expose que key/valeur/secret) — le backend reste la
// source de vérité sur QUELS champs existent (settingsFields() Go), cette
// liste doit juste rester synchronisée si un champ y est ajouté/retiré.
const TABS: ServiceTab[] = [
  {
    key: 'payment',
    label: 'Paiements',
    fields: [
      { key: 'platform_commission_rate', label: 'Taux de commission plateforme', hint: 'Fraction décimale, ex: 0.10 = 10% — dupliqué dans l’onglet Commandes, garder synchronisés' },
      { key: 'stripe_secret_key', label: 'Clé secrète Stripe', secret: true, hint: 'sk_test_... = mode TEST, sk_live_... = mode LIVE (argent réel) — vérifiez le préfixe avant de tester' },
      { key: 'stripe_webhook_secret', label: 'Secret webhook Stripe', secret: true },
      { key: 'stripe_enabled', label: 'Stripe activé', hint: '"false" pour désactiver Stripe côté site sans effacer la clé — toute autre valeur (ou vide) = activé' },
      { key: 'paydunya_api_key_private', label: 'Clé privée PayDunya', secret: true },
      { key: 'paydunya_api_key_public', label: 'Clé publique PayDunya', secret: true },
      { key: 'paydunya_master_key', label: 'Clé maître PayDunya', secret: true },
      { key: 'paydunya_token', label: 'Token PayDunya', secret: true, hint: 'Dashboard PayDunya → Intégrez notre API → Token (obligatoire, distinct des 3 clés ci-dessus)' },
      { key: 'paydunya_api_base', label: 'URL de base API PayDunya' },
      { key: 'paydunya_enabled', label: 'PayDunya activé', hint: '"false" pour désactiver PayDunya côté site sans effacer la clé — toute autre valeur (ou vide) = activé' },
      { key: 'storefront_url', label: 'URL du site public', hint: 'Utilisée pour les liens de retour après paiement' },
    ],
  },
  {
    key: 'order',
    label: 'Commandes',
    fields: [
      { key: 'platform_commission_rate', label: 'Taux de commission plateforme', hint: 'Fraction décimale, ex: 0.10 = 10% — dupliqué dans l’onglet Paiements, garder synchronisés' },
    ],
  },
  {
    key: 'auth',
    label: 'Authentification',
    fields: [
      { key: 'otp_ttl_minutes', label: 'Durée de validité OTP (minutes)' },
      { key: 'jwt_ttl_hours', label: 'Durée de validité JWT (heures)' },
      { key: 'jwt_secret', label: 'Clé de signature JWT', secret: true, hint: 'ATTENTION : partagée avec admin-svc (onglet Système ci-dessous), les deux doivent rester identiques' },
      { key: 'redis_password', label: 'Mot de passe Redis', secret: true, hint: 'Nécessite un redémarrage du service pour être pris en compte' },
      { key: 'admin_email', label: 'Email admin bootstrap', hint: 'Informatif seul — n’a d’effet qu’au tout premier démarrage' },
      { key: 'firebase_web_client_id', label: 'Firebase Web Client ID' },
      { key: 'sms_provider_url', label: 'URL fournisseur SMS', hint: 'Vide = mode dev, OTP jamais envoyé réellement' },
      { key: 'internal_api_secret', label: 'Secret interne (frontend)', secret: true, hint: 'ATTENTION : doit rester identique côté Cloudflare Pages' },
    ],
  },
  {
    key: 'notification',
    label: 'Notifications',
    fields: [
      { key: 'firebase_service_account_json', label: 'Compte de service Firebase (JSON)', secret: true, hint: 'Nécessite un redémarrage du service pour être pris en compte' },
    ],
  },
  {
    key: 'email',
    label: 'Emails',
    fields: [
      { key: 'resend_api_key', label: 'Clé API Resend', secret: true, hint: 'Vide = mode simulation, email jamais envoyé' },
      { key: 'from_email', label: 'Adresse expéditeur' },
      { key: 'storefront_url', label: 'URL du site public', hint: 'Utilisée dans le contenu des emails' },
    ],
  },
  {
    key: 'loyalty',
    label: 'WhatsApp',
    fields: [
      { key: 'twilio_account_sid', label: 'Account SID Twilio', secret: true },
      { key: 'twilio_auth_token', label: 'Auth Token Twilio', secret: true },
      { key: 'twilio_whatsapp_from', label: 'Numéro WhatsApp Business', hint: 'Format whatsapp:+14155238886' },
      { key: 'twilio_admin_numbers', label: 'Numéros admin à notifier', hint: 'Séparés par une virgule, ex: +221771234567,+33612345678' },
      { key: 'twilio_enable_rep', label: 'Notifier les représentants', hint: 'yes ou no' },
      { key: 'twilio_enable_admin', label: 'Notifier l’admin', hint: 'yes ou no' },
      { key: 'twilio_enable_client', label: 'Notifier les clients', hint: 'yes ou no' },
      { key: 'twilio_template_rep_new_order', label: 'Template — représentant, nouvelle commande', hint: 'Content SID Twilio (HXxxxx…), vide = message texte simple' },
      { key: 'twilio_template_client_confirm', label: 'Template — client, confirmation paiement' },
      { key: 'twilio_template_client_shipped', label: 'Template — client, expédition/international' },
      { key: 'twilio_template_admin_new_order', label: 'Template — admin, nouvelle commande' },
    ],
  },
  {
    key: 'system',
    label: 'Système',
    fields: [
      { key: 'jwt_secret', label: 'Clé de signature JWT', secret: true, hint: 'ATTENTION : partagée avec auth-svc, les deux doivent rester identiques' },
      { key: 'minio_endpoint', label: 'Endpoint MinIO', hint: 'Nécessite un redémarrage du service' },
      { key: 'minio_root_user', label: 'Utilisateur root MinIO', secret: true, hint: 'Nécessite un redémarrage du service' },
      { key: 'minio_root_password', label: 'Mot de passe root MinIO', secret: true, hint: 'Nécessite un redémarrage du service' },
      { key: 'minio_bucket', label: 'Bucket MinIO', hint: 'Nécessite un redémarrage du service' },
      { key: 'media_base_url', label: 'URL publique des médias (CDN)', hint: 'Nécessite un redémarrage du service' },
    ],
  },
]

function settingsPath(serviceKey: string) {
  // "system" reste géré localement par admin-svc (pas de relais vers un
  // autre service) — voir GET/PUT /admin/api/settings côté Go.
  return serviceKey === 'system' ? '/admin/api/settings' : `/admin/api/settings/${serviceKey}`
}

// Webhooks entrants — URLs FIXES (dérivées du domaine passerelle + de la
// route Caddyfile), pas des valeurs de configuration éditables/persistées.
// Affichées en lecture seule pour que l'admin puisse les copier-coller
// directement dans le dashboard Stripe/PayDunya/Resend (demandé le
// 2026-08-26) sans avoir à les retrouver dans le code. Voir deploy/Caddyfile
// pour le mapping réel path → service (source de vérité si ça change).
const WEBHOOK_BASE = 'https://origin.miadmarket.ca'
const WEBHOOKS_BY_TAB: Record<string, { label: string; url: string; hint?: string }[]> = {
  payment: [
    { label: 'Stripe', url: `${WEBHOOK_BASE}/payments/webhook/stripe`, hint: 'Dashboard Stripe → Developers → Webhooks → Add endpoint' },
    { label: 'PayDunya', url: `${WEBHOOK_BASE}/payments/webhook/paydunya`, hint: 'Dashboard PayDunya → configuration IPN/callback' },
  ],
  email: [
    { label: 'Resend (statuts d’envoi)', url: `${WEBHOOK_BASE}/webhooks/resend`, hint: 'Dashboard Resend → Webhooks' },
    { label: 'Emails entrants (réponses)', url: `${WEBHOOK_BASE}/webhooks/inbound` },
  ],
}

function WebhookUrls({ tab }: { tab: string }) {
  const hooks = WEBHOOKS_BY_TAB[tab]
  const [copied, setCopied] = useState<string | null>(null)
  if (!hooks) return null

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(url)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      // Presse-papiers indisponible (contexte non sécurisé, permission refusée) —
      // l'URL reste sélectionnable/copiable manuellement dans le champ, pas bloquant.
    }
  }

  return (
    <div className="form-card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0, fontSize: 14 }}>URLs de webhook</h3>
      <div className="form-grid">
        {hooks.map((h) => (
          <div className="form-field full" key={h.url}>
            <label>{h.label}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="text" readOnly value={h.url} style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }} />
              <button type="button" className="btn-ghost" onClick={() => copy(h.url)}>
                {copied === h.url ? 'Copié !' : 'Copier'}
              </button>
            </div>
            {h.hint && <span className="hint">{h.hint}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

export function Configuration() {
  const [tab, setTab] = useState(TABS[0].key)
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const currentTab = TABS.find((t) => t.key === tab)!

  useEffect(() => {
    setLoading(true)
    setError(null)
    setNotice(null)
    api
      .get<Record<string, unknown>>(settingsPath(tab))
      .then((body) => {
        setSnapshot(body)
        const initial: Record<string, string> = {}
        for (const f of currentTab.fields) {
          if (!f.secret) initial[f.key] = String(body[f.key] ?? '')
        }
        setDraft(initial)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'échec du chargement'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  function setField(key: string, value: string) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  async function save() {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      // Ne jamais envoyer un champ secret laissé vide — vide signifie
      // "inchangé" côté backend (voir SettingsStore.IsSecret), un champ
      // secret n'apparaît donc dans le payload que si l'admin l'a
      // explicitement retapé.
      const payload: Record<string, string> = { ...draft }
      const res = await api.put<{ ok: boolean; requires_restart?: boolean }>(settingsPath(tab), payload)
      setNotice(
        res.requires_restart
          ? 'Enregistré — un redémarrage du service est nécessaire pour que certains champs prennent effet.'
          : 'Enregistré.'
      )
      // Recharge le snapshot pour refléter les nouveaux "_configured" des secrets.
      const fresh = await api.get<Record<string, unknown>>(settingsPath(tab))
      setSnapshot(fresh)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "échec de l'enregistrement")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Configuration Système</h2>
          <p className="subtitle">
            Variables auparavant en dur dans les fichiers .env du VPS — éditables ici sans redéploiement.
          </p>
        </div>
      </div>

      <div className="form-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)} type="button">
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'loyalty' && (
        <p className="hint" style={{ marginBottom: 12 }}>
          <Link to="/admin/whatsapp-logs">Voir le journal des notifications WhatsApp envoyées →</Link>
        </p>
      )}

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="hint" style={{ color: '#1a7f37', fontWeight: 600 }}>{notice}</p>}

      <WebhookUrls tab={tab} />

      <div className="form-card">
        {loading && <p>Chargement…</p>}
        {!loading && (
          <div className="form-grid">
            {currentTab.fields.map((f) => {
              const configured = f.secret ? Boolean(snapshot?.[`${f.key}_configured`]) : true
              return (
                <div className="form-field full" key={f.key}>
                  <label>
                    {f.label}
                    {f.secret && (
                      <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: configured ? '#1a7f37' : '#b42318' }}>
                        {configured ? '● configuré' : '● non configuré'}
                      </span>
                    )}
                  </label>
                  <input
                    type={f.secret ? 'password' : 'text'}
                    value={draft[f.key] ?? ''}
                    placeholder={f.secret ? 'laisser vide pour ne pas modifier' : ''}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                  {f.hint && <span className="hint">{f.hint}</span>}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="form-actions">
        <button className="btn-primary" disabled={saving || loading} onClick={save}>
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </div>
  )
}

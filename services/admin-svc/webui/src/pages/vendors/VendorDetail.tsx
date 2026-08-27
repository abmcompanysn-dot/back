import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ApiError, api } from '../../lib/api'
import { StatusBadge } from '../../components/StatusBadge'
import { EmptyState } from '../../components/EmptyState'
import { IconCatalog, IconOrders } from '../../components/Icons'
import { ImageUploadField } from '../../components/ImageUploadField'

interface VendorFull {
  id: number
  name: string
  slug: string
  logo_url: string
  banner_url: string
  country: string
  city: string
  address: string
  phone: string
  email: string
  verified: boolean
  rating_avg: number
  product_count: number
  kyc_status: string
  kyc_documents: { type: string; url: string }[]
  kyc_rejection_reason: string
  commission_rate: number | null
  require_moderation: boolean
  badges: string[]
  suspended_until: string | null
  suspension_message: string
  created_at: string
}

interface Product {
  id: number
  name: string
  price_usd: number
  status: string
  image: string
}

interface WalletTx {
  id: number
  type: string
  amount_usd: number
  note: string
  created_at: string
}

const TABS = [
  { key: 'general', label: 'Informations générales' },
  { key: 'kyc', label: 'Modération & Documents' },
  { key: 'products', label: 'Produits' },
  { key: 'orders', label: 'Commandes' },
  { key: 'finance', label: 'Finance & Portefeuille' },
  { key: 'settings', label: 'Paramètres' },
]

const BADGE_OPTIONS = [
  { value: 'verified', label: 'Vérifié' },
  { value: 'top_vendor', label: 'Top vendeur' },
  { value: 'official', label: 'Boutique officielle' },
]

export function VendorDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [tab, setTab] = useState('general')
  const [vendor, setVendor] = useState<VendorFull | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [products, setProducts] = useState<Product[]>([])
  const [wallet, setWallet] = useState<{ balance_usd: number } | null>(null)
  const [walletTx, setWalletTx] = useState<WalletTx[]>([])
  const [rejectReason, setRejectReason] = useState('')

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const v = await api.get<VendorFull>(`/admin/api/vendors/${id}`)
      setVendor(v)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec du chargement')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (tab === 'products' && vendor) {
      api
        .get<{ items: Product[] }>(`/admin/api/products?admin=true&vendor_id=${vendor.id}&page_size=50`)
        .then((b) => setProducts(b.items || []))
        .catch(() => {})
    }
    if (tab === 'finance' && vendor) {
      api.get<{ balance_usd: number }>(`/admin/api/vendors/${vendor.id}/wallet`).then(setWallet).catch(() => {})
      api
        .get<{ items: WalletTx[] }>(`/admin/api/vendors/${vendor.id}/wallet/transactions?page_size=30`)
        .then((b) => setWalletTx(b.items || []))
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, vendor?.id])

  async function patch(payload: Record<string, unknown>) {
    if (!vendor) return
    setSaving(true)
    setError(null)
    try {
      await api.patch(`/admin/api/vendors/${vendor.id}`, payload)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "échec de l'enregistrement")
    } finally {
      setSaving(false)
    }
  }

  async function approveKYC() {
    if (!vendor) return
    setSaving(true)
    try {
      await api.post(`/admin/api/vendors/${vendor.id}/kyc/approve`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "échec de l'approbation")
    } finally {
      setSaving(false)
    }
  }

  async function rejectKYC() {
    if (!vendor) return
    setSaving(true)
    try {
      await api.post(`/admin/api/vendors/${vendor.id}/kyc/reject`, { reason: rejectReason })
      setRejectReason('')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec du rejet')
    } finally {
      setSaving(false)
    }
  }

  function toggleBadge(badge: string) {
    if (!vendor) return
    const has = vendor.badges.includes(badge)
    const next = has ? vendor.badges.filter((b) => b !== badge) : [...vendor.badges, badge]
    patch({ badges: next })
  }

  if (loading) return <p>Chargement…</p>
  if (error && !vendor) return <p className="error-text">{error}</p>
  if (!vendor) return null

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>{vendor.name}</h2>
          <p className="subtitle">
            Boutique #{vendor.id} — <StatusBadge status={vendor.kyc_status} />
          </p>
        </div>
        <div className="page-header-actions">
          <button className="btn-ghost" onClick={() => window.open(`https://miadmarket.ca/?v=vendor&slug=${vendor.slug}`, '_blank')}>
            Voir la vitrine
          </button>
          <button className="btn-ghost" onClick={() => navigate('/admin/vendors')}>
            Retour à la liste
          </button>
        </div>
      </div>

      <div className="form-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)} type="button">
            {t.label}
          </button>
        ))}
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="form-card">
        {tab === 'general' && (
          <div className="form-grid">
            <div className="form-field">
              <label>Nom de la boutique</label>
              <input defaultValue={vendor.name} onBlur={(e) => e.target.value !== vendor.name && patch({ name: e.target.value })} />
            </div>
            <div className="form-field">
              <label>Email</label>
              <input defaultValue={vendor.email} onBlur={(e) => e.target.value !== vendor.email && patch({ email: e.target.value })} />
            </div>
            <div className="form-field">
              <label>Téléphone</label>
              <input defaultValue={vendor.phone} onBlur={(e) => e.target.value !== vendor.phone && patch({ phone: e.target.value })} />
            </div>
            <div className="form-field">
              <label>Pays</label>
              <input defaultValue={vendor.country} onBlur={(e) => e.target.value !== vendor.country && patch({ country: e.target.value })} />
            </div>
            <div className="form-field">
              <label>Ville</label>
              <input defaultValue={vendor.city} onBlur={(e) => e.target.value !== vendor.city && patch({ city: e.target.value })} />
            </div>
            <div className="form-field full">
              <label>Adresse</label>
              <input defaultValue={vendor.address} onBlur={(e) => e.target.value !== vendor.address && patch({ address: e.target.value })} />
            </div>
            <ImageUploadField
              label="Logo"
              value={vendor.logo_url}
              prefix="vendors"
              onChange={(url) => { patch({ logo_url: url }); setVendor({ ...vendor, logo_url: url }) }}
            />
            <ImageUploadField
              label="Bannière"
              value={vendor.banner_url}
              prefix="vendors"
              onChange={(url) => { patch({ banner_url: url }); setVendor({ ...vendor, banner_url: url }) }}
            />
          </div>
        )}

        {tab === 'kyc' && (
          <div>
            <p className="cell-secondary" style={{ marginBottom: 12 }}>
              Statut actuel : <StatusBadge status={vendor.kyc_status} />
              {vendor.kyc_rejection_reason && <span> — motif du rejet : {vendor.kyc_rejection_reason}</span>}
            </p>
            {vendor.kyc_documents.length === 0 ? (
              <EmptyState title="Aucun document téléversé" description="Le vendeur n'a pas encore fourni de pièces justificatives." />
            ) : (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                {vendor.kyc_documents.map((d, i) => (
                  <a key={i} href={d.url} target="_blank" rel="noreferrer" className="badge badge-blue">
                    {d.type}
                  </a>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn-primary" disabled={saving || vendor.kyc_status === 'approved'} onClick={approveKYC}>
                Approuver le compte
              </button>
              <input
                placeholder="Motif du rejet…"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                style={{ padding: '8px 10px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13, flex: 1, minWidth: 180 }}
              />
              <button className="btn-danger" disabled={saving} onClick={rejectKYC}>
                Rejeter avec motif
              </button>
            </div>
          </div>
        )}

        {tab === 'products' && (
          <div>
            <div style={{ marginBottom: 12 }}>
              <button className="btn-primary" onClick={() => navigate(`/admin/catalog/products/new?vendor_id=${vendor.id}`)}>
                + Ajouter un produit pour ce vendeur
              </button>
            </div>
            {products.length === 0 ? (
              <EmptyState icon={<IconCatalog width={40} height={40} strokeWidth={1.4} />} title="Aucun produit" />
            ) : (
              <div className="table-card">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 48 }}></th>
                      <th>Nom</th>
                      <th>Prix</th>
                      <th>Statut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p) => (
                      <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/catalog/products/${p.id}/edit`)}>
                        <td>{p.image && <img className="thumb" src={p.image} alt="" />}</td>
                        <td className="cell-primary">{p.name}</td>
                        <td>${p.price_usd.toFixed(2)}</td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'orders' && (
          <EmptyState
            icon={<IconOrders width={40} height={40} strokeWidth={1.4} />}
            title="Historique des commandes — à venir"
            description="Le module Commandes (prochaine étape) affichera ici les commandes de cette boutique."
          />
        )}

        {tab === 'finance' && (
          <div>
            <div className="cards" style={{ marginBottom: 20 }}>
              <div className="card">
                <div className="num">${wallet ? wallet.balance_usd.toFixed(2) : '—'}</div>
                <div className="label">Solde disponible</div>
              </div>
            </div>
            {walletTx.length === 0 ? (
              <EmptyState title="Aucun mouvement" description="L'historique des ventes et commissions apparaîtra ici." />
            ) : (
              <div className="table-card">
                <table>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Montant</th>
                      <th>Note</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {walletTx.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <StatusBadge status={t.type} />
                        </td>
                        <td style={{ color: t.amount_usd >= 0 ? '#0a7a2f' : '#c02020' }}>
                          {t.amount_usd >= 0 ? '+' : ''}
                          {t.amount_usd.toFixed(2)} $
                        </td>
                        <td className="cell-secondary">{t.note || '—'}</td>
                        <td className="cell-secondary">{new Date(t.created_at).toLocaleDateString('fr-FR')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'settings' && (
          <div className="form-grid">
            <div className="form-field">
              <label>Commission personnalisée (%)</label>
              <input
                type="number"
                defaultValue={vendor.commission_rate ?? ''}
                placeholder="taux global par défaut"
                onBlur={(e) => {
                  if (e.target.value === '') patch({ clear_commission: true })
                  else patch({ commission_rate: Number(e.target.value) })
                }}
              />
            </div>
            <div className="form-field">
              <label>
                <input
                  type="checkbox"
                  checked={vendor.require_moderation}
                  onChange={(e) => patch({ require_moderation: e.target.checked })}
                  style={{ marginRight: 6 }}
                />
                Exiger la modération préalable des produits
              </label>
            </div>
            <div className="form-field full">
              <label>Badges</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {BADGE_OPTIONS.map((b) => (
                  <button
                    key={b.value}
                    className={vendor.badges.includes(b.value) ? 'btn-primary' : 'btn-ghost'}
                    onClick={() => toggleBadge(b.value)}
                    type="button"
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-field full">
              <label>Suspension temporaire</label>
              {vendor.suspended_until && new Date(vendor.suspended_until) > new Date() ? (
                <div>
                  <p className="cell-secondary">
                    Suspendue jusqu'au {new Date(vendor.suspended_until).toLocaleString('fr-FR')} — {vendor.suspension_message}
                  </p>
                  <button className="btn-ghost" onClick={() => patch({ suspended_until: '' })}>
                    Lever la suspension
                  </button>
                </div>
              ) : (
                <SuspendForm onSuspend={(until, msg) => patch({ suspended_until: until, suspension_message: msg })} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function SuspendForm({ onSuspend }: { onSuspend: (until: string, message: string) => void }) {
  const [days, setDays] = useState('7')
  const [message, setMessage] = useState('Boutique temporairement fermée pour révision')
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input type="number" style={{ width: 70 }} value={days} onChange={(e) => setDays(e.target.value)} />
      <span className="cell-secondary">jours</span>
      <input style={{ flex: 1, minWidth: 200 }} value={message} onChange={(e) => setMessage(e.target.value)} />
      <button
        className="btn-danger"
        onClick={() => {
          const until = new Date(Date.now() + Number(days) * 86400000).toISOString()
          onSuspend(until, message)
        }}
      >
        Suspendre
      </button>
    </div>
  )
}

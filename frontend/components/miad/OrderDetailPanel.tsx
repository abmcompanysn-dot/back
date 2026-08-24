"use client"

import { useState } from 'react'
import Image from 'next/image'
import useSWR from 'swr'
import {
  X, Package, MapPin, CreditCard, Truck, Printer,
  CheckCircle2, Loader2, ExternalLink, Phone, Mail, Clock, ShieldCheck,
} from 'lucide-react'

interface LineItem {
  id: number
  name: string
  quantity: number
  price: string
  total: string
  image?: { src: string }
  sku?: string
}

interface Address {
  first_name: string
  last_name: string
  address_1: string
  address_2?: string
  city: string
  state?: string
  postcode?: string
  country: string
  phone?: string
  email?: string
}

interface WCOrder {
  id: number
  number: string
  status: string
  date_created: string
  billing: Address
  shipping: Address
  line_items: LineItem[]
  shipping_lines: { method_title: string; total: string }[]
  payment_method_title: string
  total: string
  subtotal: string
  total_shipping: string
  total_tax: string
  currency_symbol: string
  customer_note?: string
  meta_data?: { key: string; value: string }[]
  transaction_id?: string
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  pending:    { label: 'En attente',    color: 'bg-yellow-100 text-yellow-800' },
  processing: { label: 'En cours',      color: 'bg-blue-100 text-blue-800' },
  on_hold:    { label: 'En pause',      color: 'bg-orange-100 text-orange-800' },
  completed:  { label: 'Complétée',     color: 'bg-green-100 text-green-800' },
  cancelled:  { label: 'Annulée',       color: 'bg-red-100 text-red-800' },
  refunded:   { label: 'Remboursée',    color: 'bg-purple-100 text-purple-800' },
  failed:              { label: 'Échouée',         color: 'bg-gray-100 text-gray-600' },
  'miad-rep-charge':   { label: 'Prise en charge', color: 'bg-orange-100 text-orange-800' },
}

interface Props {
  orderId: number
  onClose: () => void
}

const orderFetcher = async ([url, token]: [string, string]): Promise<WCOrder> => {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const d = await r.json()
  if (!d.order) throw new Error(d.error || 'Erreur')
  return d.order
}

const formatAddr = (a: Address) =>
  [a.first_name + ' ' + a.last_name, a.address_1, a.address_2, a.city, a.country, a.phone].filter(Boolean).join(', ')

export function OrderDetailPanel({ orderId, onClose }: Props) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('miad_token') : null
  const { data: order, isLoading: loading, error: swrError, mutate } = useSWR<WCOrder>(
    token ? [`/api/orders/${orderId}`, token] : null,
    orderFetcher
  )
  const error = swrError ? (swrError.message || 'Erreur réseau') : ''
  const [confirming, setConfirming] = useState(false)
  const [confirmed, setConfirmed]   = useState(false)
  const [acking, setAcking]         = useState(false)
  const [acked, setAcked]           = useState(false)

  const trackingNumber = order?.meta_data?.find(m => m.key === '_miad_tracking_number')?.value
  const carrier        = order?.meta_data?.find(m => m.key === '_miad_carrier')?.value
  const trackingUrl    = order?.meta_data?.find(m => m.key === '_miad_tracking_url')?.value
  const [printingWaybill, setPrintingWaybill] = useState(false)

  const acknowledgeOrder = async () => {
    if (!order) return
    setAcking(true)
    const token   = localStorage.getItem('miad_token')
    const repName = (() => { try { return JSON.parse(localStorage.getItem('miad_user') || '{}').display_name || 'Représentant' } catch { return 'Représentant' } })()
    const res = await fetch(`/api/orders/${order.id}/acknowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ rep_name: repName }),
    })
    if (res.ok) {
      setAcked(true)
      // Mettre à jour le statut affiché localement
      mutate(prev => prev ? { ...prev, status: 'miad-rep-charge' } : prev, { revalidate: false })
    }
    setAcking(false)
  }

  const confirmDelivery = async () => {
    if (!order) return
    setConfirming(true)
    const token = localStorage.getItem('miad_token')
    const res = await fetch(`/api/orders/${order.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: 'completed' }),
    })
    if (res.ok) {
      const d = await res.json()
      if (d.order) mutate(d.order, { revalidate: false })
      setConfirmed(true)
    }
    setConfirming(false)
  }

  const printOrder = () => {
    if (!order) return
    const win = window.open('', '_blank')!
    const addr = formatAddr

    win.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Commande #${order.number}</title>
<style>
  body{font-family:Arial,sans-serif;padding:24px;color:#111;font-size:13px}
  h1{color:#005826;border-bottom:2px solid #005826;padding-bottom:8px}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0}
  .box{background:#f9f9f9;border:1px solid #ddd;border-radius:8px;padding:12px}
  .box h3{margin:0 0 6px;font-size:11px;text-transform:uppercase;color:#666}
  table{width:100%;border-collapse:collapse;margin:16px 0}
  th{background:#005826;color:#fff;padding:8px;text-align:left;font-size:11px}
  td{padding:8px;border-bottom:1px solid #eee}
  .total{text-align:right;font-weight:bold;font-size:15px;margin-top:12px}
  .footer{margin-top:24px;text-align:center;color:#999;font-size:11px}
</style></head><body>
<h1>Commande MIAD #${order.number}</h1>
<div class="meta">
  <div class="box"><h3>Infos commande</h3>
    <p><b>Date:</b> ${new Date(order.date_created).toLocaleDateString('fr-FR')}</p>
    <p><b>Statut:</b> ${STATUS_MAP[order.status]?.label || order.status}</p>
    <p><b>Paiement:</b> ${order.payment_method_title}</p>
    ${trackingNumber ? `<p><b>Tracking:</b> ${carrier || 'DHL'} — ${trackingNumber}</p>` : ''}
  </div>
  <div class="box"><h3>Client</h3>
    <p>${order.billing.first_name} ${order.billing.last_name}</p>
    <p>${order.billing.email || ''}</p>
    <p>${order.billing.phone || ''}</p>
  </div>
  <div class="box"><h3>Adresse de livraison</h3><p>${addr(order.shipping || order.billing)}</p></div>
  <div class="box"><h3>Adresse de facturation</h3><p>${addr(order.billing)}</p></div>
</div>
<table>
  <thead><tr><th>Produit</th><th>Qté</th><th>Prix unitaire</th><th>Total</th></tr></thead>
  <tbody>
    ${order.line_items.map(item => `
    <tr><td>${item.name}${item.sku ? ` <small>(${item.sku})</small>` : ''}</td>
    <td>${item.quantity}</td>
    <td>${order.currency_symbol}${parseFloat(item.price).toFixed(2)}</td>
    <td>${order.currency_symbol}${parseFloat(item.total).toFixed(2)}</td></tr>`).join('')}
  </tbody>
</table>
<div class="total">
  Total : ${order.currency_symbol}${parseFloat(order.total).toFixed(2)}
</div>
${order.customer_note ? `<div class="box" style="margin-top:12px"><h3>Note client</h3><p>${order.customer_note}</p></div>` : ''}
<div class="footer">Document généré par MIAD Market · miadmarket.com</div>
</body></html>`)
    win.document.close()
    win.print()
  }

  // Bordereau de livraison : document séparé de l'export PDF ci-dessus,
  // pensé pour être imprimé et remis avec le colis au représentant/transporteur
  // (pas de prix ni d'infos de paiement — juste ce dont un livreur a besoin :
  // destinataire, adresse, téléphone, et un QR code vers la page de suivi
  // client). Demandé le 2026-07-26.
  const printWaybill = async () => {
    if (!order) return
    // Ouvrir la fenêtre tout de suite, avant tout await — sinon certains
    // navigateurs (Safari/Firefox) bloquent le popup car il n'est plus
    // rattaché de façon synchrone au clic utilisateur.
    const win = window.open('', '_blank')!
    win.document.write('<p style="font-family:Arial,sans-serif;padding:24px;color:#666">Génération du bordereau…</p>')

    setPrintingWaybill(true)
    let qrDataUrl = ''
    if (trackingUrl) {
      try {
        const QRCode = await import('qrcode')
        qrDataUrl = await QRCode.toDataURL(trackingUrl, {
          width: 220,
          margin: 1,
          color: { dark: '#0f172a', light: '#ffffff' },
          errorCorrectionLevel: 'H',
        })
      } catch {
        // pas de QR si la génération échoue — le reste du bordereau reste utile
      }
    }
    setPrintingWaybill(false)

    const dest = order.shipping?.address_1 ? order.shipping : order.billing
    const logoUrl = `${window.location.origin}/logo/logo.png`

    win.document.open()
    win.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Bordereau — Commande #${order.number}</title>
<style>
  @page { margin: 14mm }
  body{font-family:Arial,sans-serif;padding:0;color:#111;font-size:14px}
  .brandbar{background:#005826;color:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;border-radius:12px}
  .brandbar img{height:32px;width:auto;display:block}
  .brandbar .doc{font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;opacity:.9}
  .orderno{font-size:22px;font-weight:900;margin-top:2px}
  .grid{display:grid;grid-template-columns:1fr 220px;gap:20px;margin-top:20px;align-items:start}
  .dest{border:2px solid #005826;border-radius:12px;padding:18px}
  .dest h3{margin:0 0 10px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#005826}
  .dest .name{font-size:19px;font-weight:900;margin:0 0 6px}
  .dest .phone{font-size:17px;font-weight:900;color:#005826;margin:6px 0}
  .dest .addr{font-size:14px;line-height:1.5;color:#222}
  .qrbox{border:1px solid #ddd;border-radius:12px;padding:14px;text-align:center}
  .qrbox img{width:100%;height:auto;max-width:180px}
  .qrbox p{font-size:10px;color:#666;margin:8px 0 0;font-weight:bold}
  .meta{display:flex;gap:24px;margin-top:18px;font-size:12px;color:#333}
  .meta b{color:#111}
  table{width:100%;border-collapse:collapse;margin-top:18px}
  th{background:#f2f2f2;color:#444;padding:7px;text-align:left;font-size:11px;text-transform:uppercase}
  td{padding:7px;border-bottom:1px solid #eee;font-size:13px}
  .signatures{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:36px}
  .sig{border-top:1px solid #999;padding-top:6px;font-size:11px;color:#666}
  .footer{margin-top:24px;text-align:center;color:#999;font-size:10px}
</style></head><body>
<div class="brandbar">
  <img src="${logoUrl}" alt="MIAD Market" />
  <div style="text-align:right">
    <div class="doc">Bordereau de livraison</div>
    <div class="orderno">#${order.number}</div>
  </div>
</div>
<div class="grid">
  <div class="dest">
    <h3>Destinataire</h3>
    <p class="name">${dest.first_name} ${dest.last_name}</p>
    ${dest.phone ? `<p class="phone">☎ ${dest.phone}</p>` : ''}
    <p class="addr">${[dest.address_1, dest.address_2, dest.city, dest.state, dest.country].filter(Boolean).join(', ')}</p>
  </div>
  ${qrDataUrl ? `<div class="qrbox"><img src="${qrDataUrl}" alt="QR code de suivi" /><p>Scanner pour suivre le colis</p></div>` : '<div></div>'}
</div>
<div class="meta">
  <span><b>Date commande :</b> ${new Date(order.date_created).toLocaleDateString('fr-FR')}</span>
  <span><b>Livraison :</b> ${order.shipping_lines?.[0]?.method_title || 'MIAD Standard'}</span>
  ${trackingNumber ? `<span><b>Tracking ${carrier || 'DHL'} :</b> ${trackingNumber}</span>` : ''}
</div>
<table>
  <thead><tr><th>Contenu du colis</th><th>Qté</th></tr></thead>
  <tbody>
    ${order.line_items.map(item => `<tr><td>${item.name}${item.sku ? ` <small>(${item.sku})</small>` : ''}</td><td>${item.quantity}</td></tr>`).join('')}
  </tbody>
</table>
<div class="signatures">
  <div class="sig">Remis par (vendeur) — nom &amp; date</div>
  <div class="sig">Reçu par (représentant/transporteur) — nom &amp; date</div>
</div>
<div class="footer">MIAD Market · miadmarket.com · Document généré le ${new Date().toLocaleDateString('fr-FR')}</div>
</body></html>`)
    win.document.close()
    win.print()
  }

  const st = order ? (STATUS_MAP[order.status] ?? { label: order.status, color: 'bg-gray-100 text-gray-600' }) : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-4 bg-black/50 backdrop-blur-sm"
      role="button"
      tabIndex={0}
      aria-label="Fermer"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onClose() }}
    >
      <div className="bg-background w-full md:max-w-2xl max-h-[92vh] md:max-h-[85vh] rounded-t-3xl md:rounded-3xl flex flex-col overflow-hidden shadow-2xl">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border shrink-0">
          <div className="flex-1 min-w-0">
            {loading ? (
              <div className="h-5 w-32 bg-muted animate-pulse rounded" />
            ) : order ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="font-black text-base">Commande #{order.number}</h2>
                  {st && <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${st.color}`}>{st.label}</span>}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {new Date(order.date_created).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {order && (
              <>
                <button
                  type="button"
                  onClick={printWaybill}
                  disabled={printingWaybill}
                  title="Bordereau à imprimer et remettre avec le colis au transporteur"
                  className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-xl border border-border hover:bg-muted transition-colors disabled:opacity-60"
                >
                  {printingWaybill ? <Loader2 size={13} className="animate-spin" /> : <Truck size={13} />} Bordereau
                </button>
                <button type="button" onClick={printOrder} className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-xl border border-border hover:bg-muted transition-colors">
                  <Printer size={13} /> Exporter PDF
                </button>
              </>
            )}
            <button type="button" onClick={onClose} aria-label="Fermer" className="w-8 h-8 rounded-xl hover:bg-muted flex items-center justify-center transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-20">
              <Loader2 size={28} className="animate-spin text-primary" />
            </div>
          )}
          {error && (
            <div className="text-center py-16 text-muted-foreground">
              <p className="font-bold">{error}</p>
            </div>
          )}

          {order && (
            <div className="p-5 space-y-5">

              {/* Client + Addresses */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                <div className="bg-muted/40 rounded-2xl p-4 space-y-2">
                  <div className="flex items-center gap-2 mb-2">
                    <Mail size={14} className="text-primary" />
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Client</p>
                  </div>
                  <p className="font-bold text-sm">{order.billing.first_name} {order.billing.last_name}</p>
                  {order.billing.email && <p className="text-xs text-muted-foreground">{order.billing.email}</p>}
                  {order.billing.phone && (
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Phone size={11} /> {order.billing.phone}
                    </p>
                  )}
                  {order.customer_note && (
                    <div className="mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded-xl text-xs text-yellow-800">
                      <strong>Note :</strong> {order.customer_note}
                    </div>
                  )}
                </div>

                <div className="bg-muted/40 rounded-2xl p-4 space-y-2">
                  <div className="flex items-center gap-2 mb-2">
                    <MapPin size={14} className="text-primary" />
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Livraison</p>
                  </div>
                  {(() => {
                    const s = order.shipping?.address_1 ? order.shipping : order.billing
                    return (
                      <>
                        <p className="font-bold text-sm">{s.first_name} {s.last_name}</p>
                        <p className="text-xs text-muted-foreground">{s.address_1}{s.address_2 ? `, ${s.address_2}` : ''}</p>
                        <p className="text-xs text-muted-foreground">{[s.city, s.state, s.postcode].filter(Boolean).join(', ')}</p>
                        <p className="text-xs font-semibold">{s.country}</p>
                      </>
                    )
                  })()}
                </div>
              </div>

              {/* Tracking */}
              {trackingNumber && (
                <div className="bg-primary/5 border border-primary/15 rounded-2xl p-4 flex items-center gap-3">
                  <Truck size={18} className="text-primary shrink-0" />
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-primary/70">Numéro de suivi</p>
                    <p className="font-mono font-bold text-sm mt-0.5">{trackingNumber}</p>
                    <p className="text-xs text-muted-foreground">{carrier || 'DHL'}</p>
                  </div>
                </div>
              )}

              {/* Products */}
              <div className="bg-card border border-border rounded-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                  <Package size={14} className="text-primary" />
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    Produits ({order.line_items.length})
                  </p>
                </div>
                <div className="divide-y divide-border">
                  {order.line_items.map(item => (
                    <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                      {item.image?.src ? (
                        <div className="relative w-12 h-12 rounded-xl overflow-hidden shrink-0 border border-border">
                          <Image src={item.image.src} alt={item.name} fill sizes="48px" className="object-cover" />
                        </div>
                      ) : (
                        <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center shrink-0">
                          <Package size={18} className="text-muted-foreground/50" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">{item.name}</p>
                        {item.sku && <p className="text-[10px] text-muted-foreground font-mono">SKU: {item.sku}</p>}
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {order.currency_symbol}{parseFloat(item.price).toFixed(2)} × {item.quantity}
                        </p>
                      </div>
                      <p className="font-black text-sm shrink-0">
                        {order.currency_symbol}{parseFloat(item.total).toFixed(2)}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Financial summary */}
                <div className="border-t border-border bg-muted/20 px-4 py-3 space-y-1.5">
                  {parseFloat(order.total_shipping) > 0 && (
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Livraison</span>
                      <span>{order.currency_symbol}{parseFloat(order.total_shipping).toFixed(2)}</span>
                    </div>
                  )}
                  {parseFloat(order.total_tax) > 0 && (
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Taxes</span>
                      <span>{order.currency_symbol}{parseFloat(order.total_tax).toFixed(2)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-black text-sm pt-1 border-t border-border mt-1">
                    <span>Total</span>
                    <span className="text-primary">{order.currency_symbol}{parseFloat(order.total).toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* Payment */}
              <div className="flex items-center gap-3 px-4 py-3 bg-muted/40 rounded-2xl">
                <CreditCard size={14} className="text-muted-foreground shrink-0" />
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Paiement</p>
                  <p className="text-sm font-semibold mt-0.5">{order.payment_method_title}</p>
                </div>
                <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock size={11} />
                  <span>ID: {order.transaction_id || order.id}</span>
                </div>
              </div>

              {/* Prise en charge par représentant */}
              {(order.status === 'pending' || order.status === 'on-hold' || order.status === 'on_hold') && (
                acked
                  ? (
                    <div className="flex items-center justify-center gap-2 h-11 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-2xl font-bold text-sm">
                      <ShieldCheck size={15} /> Commande prise en charge — client notifié
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={acknowledgeOrder}
                      disabled={acking}
                      className="w-full flex items-center justify-center gap-2 h-11 bg-orange-500 text-white rounded-2xl font-bold text-sm hover:bg-orange-600 disabled:opacity-60 transition-all"
                    >
                      {acking
                        ? <><Loader2 size={15} className="animate-spin" /> Envoi en cours…</>
                        : <><ShieldCheck size={15} /> Prendre en charge — notifier le client</>
                      }
                    </button>
                  )
              )}

              {/* Confirm delivery button */}
              {order.status !== 'completed' && order.status !== 'cancelled' && (
                <button
                  type="button"
                  onClick={confirmDelivery}
                  disabled={confirming || confirmed}
                  className="w-full flex items-center justify-center gap-2 h-11 bg-primary text-primary-foreground rounded-2xl font-bold text-sm hover:bg-primary/90 disabled:opacity-60 transition-all"
                >
                  {confirming
                    ? <><Loader2 size={15} className="animate-spin" /> Confirmation…</>
                    : confirmed
                    ? <><CheckCircle2 size={15} /> Livraison confirmée</>
                    : <><CheckCircle2 size={15} /> Confirmer la livraison</>
                  }
                </button>
              )}
              {order.status === 'completed' && (
                <div className="flex items-center justify-center gap-2 h-11 bg-green-50 border border-green-200 text-green-700 rounded-2xl font-bold text-sm">
                  <CheckCircle2 size={15} /> Commande complétée
                </div>
              )}

            </div>
          )}
        </div>
      </div>
    </div>
  )
}

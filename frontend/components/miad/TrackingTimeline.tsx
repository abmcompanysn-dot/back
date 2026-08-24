"use client"

import { useState } from 'react'
import { MapPin, Clock, CheckCircle2, Package, Truck, AlertCircle, Plane } from 'lucide-react'

export interface TrackingEvent {
  timestamp: string
  location: string
  description: string
  status?: string
}

export interface TrackingData {
  trackingNumber: string
  carrier: string
  status: 'pending' | 'shipped' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception'
  estimatedDelivery?: string
  origin?: string
  destination?: string
  events: TrackingEvent[]
}

const STEPS = ['En préparation', 'Expédié', 'En transit', 'En livraison', 'Livré']
const STEP_STATUSES = ['pending', 'shipped', 'in_transit', 'out_for_delivery', 'delivered']

const STATUS_CONFIG: Record<string, { color: string; bg: string; border: string; label: string; Icon: any }> = {
  delivered:        { color: 'text-green-700',  bg: 'bg-green-50',  border: 'border-green-200',  label: 'Livré',                  Icon: CheckCircle2 },
  out_for_delivery: { color: 'text-orange-700', bg: 'bg-orange-50', border: 'border-orange-200', label: 'En cours de livraison',  Icon: Truck },
  in_transit:       { color: 'text-blue-700',   bg: 'bg-blue-50',   border: 'border-blue-200',   label: 'En transit',             Icon: Plane },
  shipped:          { color: 'text-indigo-700', bg: 'bg-indigo-50', border: 'border-indigo-200', label: 'Expédié',                Icon: Package },
  pending:          { color: 'text-gray-600',   bg: 'bg-gray-50',   border: 'border-gray-200',   label: 'En préparation',         Icon: Package },
  exception:        { color: 'text-red-700',    bg: 'bg-red-50',    border: 'border-red-200',    label: 'Incident de livraison',  Icon: AlertCircle },
}

export function TrackingTimeline({ data, compact = false }: { data: TrackingData; compact?: boolean }) {
  const [copied, setCopied] = useState(false)

  const cfg = STATUS_CONFIG[data.status] ?? STATUS_CONFIG.pending
  const { Icon } = cfg
  const currentStep = STEP_STATUSES.indexOf(data.status)
  const progressPct = currentStep >= 0 ? (currentStep / (STEPS.length - 1)) * 100 : 0

  const copyTracking = async () => {
    await navigator.clipboard.writeText(data.trackingNumber)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-5">
      {/* Status card */}
      <div className={`rounded-2xl p-5 border ${cfg.bg} ${cfg.border} flex items-center gap-4`}>
        <div className="w-14 h-14 rounded-2xl bg-white/80 shadow-sm flex items-center justify-center shrink-0">
          <Icon size={26} className={cfg.color} />
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-[11px] font-bold uppercase tracking-widest ${cfg.color}`}>{data.carrier}</p>
          <p className="text-xl font-black mt-0.5 text-foreground">{cfg.label}</p>
          {data.estimatedDelivery && (
            <p className="text-xs text-muted-foreground mt-1">
              Livraison estimée : <span className="font-bold text-foreground">{data.estimatedDelivery}</span>
            </p>
          )}
          {data.origin && data.destination && (
            <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
              <MapPin size={10} /> {data.origin} → {data.destination}
            </p>
          )}
        </div>
      </div>

      {/* Tracking number */}
      <div className="flex items-center justify-between bg-muted/40 rounded-xl px-4 py-3 border border-border">
        <div>
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">N° de suivi</p>
          <p className="font-mono font-black text-sm mt-0.5 text-foreground tracking-wider">{data.trackingNumber}</p>
        </div>
        <button
          type="button"
          onClick={copyTracking}
          className={`text-xs font-bold transition-colors ${copied ? 'text-green-600' : 'text-primary hover:underline'}`}
        >
          {copied ? '✓ Copié' : 'Copier'}
        </button>
      </div>

      {!compact && (
        <>
          {/* Progress stepper */}
          <div className="relative px-3 pt-2">
            {/* Background track */}
            <div className="absolute top-[22px] left-7 right-7 h-0.5 bg-border z-0" />
            {/* Active track */}
            <div
              className="absolute top-[22px] left-7 h-0.5 bg-primary z-0 transition-all duration-700"
              style={{ width: `calc(${progressPct}% - ${progressPct > 0 ? 14 : 0}px)` }}
            />
            <div className="relative z-10 flex items-start justify-between">
              {STEPS.map((step, i) => {
                const active = i <= currentStep
                const done = i < currentStep
                return (
                  <div key={step} className="flex flex-col items-center gap-1.5" style={{ width: `${100 / STEPS.length}%` }}>
                    <div
                      className={`w-7 h-7 rounded-full flex items-center justify-center border-2 transition-all duration-300 ${
                        active ? 'bg-primary border-primary text-white' : 'bg-background border-border text-muted-foreground'
                      }`}
                    >
                      {done ? <CheckCircle2 size={14} /> : <span className="text-[10px] font-black">{i + 1}</span>}
                    </div>
                    <p className={`text-[9px] font-bold text-center leading-tight ${active ? 'text-primary' : 'text-muted-foreground'}`}>
                      {step}
                    </p>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Events timeline */}
          {data.events.length > 0 ? (
            <div className="pt-2">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-4">
                Historique des événements
              </p>
              <div className="space-y-0">
                {data.events.map((event, idx) => (
                  <div key={`${event.timestamp}-${event.description}`} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div
                        className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ring-2 ${
                          idx === 0 ? 'bg-primary ring-primary/25' : 'bg-muted-foreground/25 ring-transparent'
                        }`}
                      />
                      {idx < data.events.length - 1 && (
                        <div className="w-px flex-1 bg-border mt-1.5 min-h-6" />
                      )}
                    </div>
                    <div className={`pb-5 flex-1 ${idx === data.events.length - 1 ? 'pb-0' : ''}`}>
                      <p className={`text-sm font-semibold leading-snug ${idx === 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                        {event.description}
                      </p>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        {event.location && (
                          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                            <MapPin size={10} /> {event.location}
                          </span>
                        )}
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Clock size={10} />
                          {new Date(event.timestamp).toLocaleString('fr-FR', {
                            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
                          })}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="bg-muted/30 rounded-xl px-4 py-5 text-center border border-border">
              <Truck size={22} className="mx-auto text-muted-foreground/40 mb-2" />
              <p className="text-sm text-muted-foreground">
                Les événements de transit apparaîtront ici une fois le colis pris en charge.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

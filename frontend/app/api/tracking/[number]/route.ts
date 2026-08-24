import { NextResponse } from 'next/server'

export const runtime = 'edge';

const TRACK17_TOKEN = process.env.TRACK17_API_KEY || ''

// Mappe les statuts 17track → statuts internes MIAD
function mapStatus(tag: number): string {
  // 0=No info, 10=In Transit, 20=Expired, 30=Pick Up, 35=Undelivered, 40=Delivered, 50=Exception
  if (tag === 40) return 'delivered'
  if (tag === 30) return 'out_for_delivery'
  if (tag === 10) return 'in_transit'
  if (tag === 35 || tag === 50) return 'exception'
  if (tag === 20) return 'exception'
  return 'pending'
}

function mapCarrier(carrierCode: number | undefined): string {
  const map: Record<number, string> = {
    100195: 'Cainiao',
    100003: 'DHL',
    100002: 'FedEx',
    100001: 'UPS',
    100028: 'China Post',
    100171: 'SpeedX',
    100135: 'EMS',
    100077: 'Chronopost',
    100080: 'Colissimo',
  }
  return carrierCode ? (map[carrierCode] || `Transporteur #${carrierCode}`) : 'MIAD Express'
}

// POST (pas GET) volontairement : cette route déclenche un enregistrement
// payant auprès de l'API 17track à chaque appel — en GET, une requête pouvait
// être déclenchée par un simple prefetch/crawler/<img> cross-site (CSRF),
// gaspillant le quota sur des numéros de suivi arbitraires.
export async function POST(
  request: Request,
  { params }: { params: { number: string } }
) {
  const trackingNumber = decodeURIComponent(params.number)
  const url = new URL(request.url)
  const carrierHint = url.searchParams.get('carrier') || ''

  // ── 17track API ──────────────────────────────────────────────────────────
  if (TRACK17_TOKEN) {
    try {
      // 1. Enregistrer le numéro de suivi
      await fetch('https://api.17track.net/track/v2.2/register', {
        method: 'POST',
        headers: { '17token': TRACK17_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ number: trackingNumber }]),
      }).catch(() => {})

      // 2. Récupérer les informations de tracking
      const res = await fetch('https://api.17track.net/track/v2.2/gettracklist', {
        method: 'POST',
        headers: { '17token': TRACK17_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ number: trackingNumber }]),
      })

      if (res.ok) {
        const json = await res.json()
        const item = json?.data?.accepted?.[0]

        if (item) {
          const track = item.track || {}
          const tag   = track.z0?.z || 0
          const events: any[] = []

          // z1 = dernier événement
          if (track.z1) {
            events.push({
              timestamp:   track.z1.a || new Date().toISOString(),
              location:    track.z1.c || '',
              description: track.z1.z || '',
            })
          }

          // z2 = historique complet (du plus récent au plus ancien)
          if (Array.isArray(track.z2)) {
            for (const ev of track.z2) {
              events.push({
                timestamp:   ev.a || '',
                location:    ev.c || '',
                description: ev.z || '',
              })
            }
          }

          // Dédupliquer
          const seen = new Set<string>()
          const uniqueEvents = events.filter(e => {
            const key = `${e.timestamp}|${e.description}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })

          return NextResponse.json({
            trackingNumber,
            carrier:           mapCarrier(item.w1) || carrierHint || 'MIAD Express',
            status:            mapStatus(tag),
            origin:            track.c || undefined,
            destination:       track.d || undefined,
            estimatedDelivery: track.b ? new Date(track.b).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : undefined,
            events:            uniqueEvents,
          })
        }
      }
    } catch {
      // tombe sur le fallback ci-dessous
    }
  }

  // ── Fallback sans clé API ────────────────────────────────────────────────
  return NextResponse.json({
    trackingNumber,
    carrier: carrierHint || 'MIAD Express',
    status:  'in_transit',
    events:  [],
    _note:   'Ajoutez TRACK17_API_KEY dans .env.local pour activer le suivi en temps réel.',
  })
}

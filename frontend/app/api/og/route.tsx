import satori from 'satori'
import { Resvg } from '@cf-wasm/resvg/edge-light'

export const runtime = 'edge'

// On bypasse next/og : son module charge inconditionnellement une police via fs,
// incompatible avec l'Edge Runtime. satori (SVG) + @cf-wasm/resvg (PNG) n'ont pas ce
// problème — ce package gère lui-même le wasm via import statique compatible Edge.

async function loadGoogleFont(family: string, weight: number, text: string): Promise<ArrayBuffer> {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&text=${encodeURIComponent(text)}`
  const css = await (await fetch(cssUrl)).text()
  const match = css.match(/src: url\(([^)]+)\) format\('(opentype|truetype)'\)/)
  if (!match) throw new Error(`Police introuvable pour ${family}:${weight}`)
  const fontRes = await fetch(match[1])
  if (!fontRes.ok) throw new Error(`Échec du téléchargement de la police ${family}:${weight}`)
  return fontRes.arrayBuffer()
}

const WIDTH = 1200
const HEIGHT = 630

function OgImage() {
  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Background decorative circles */}
      <div style={{
        position: 'absolute', top: -80, right: -80,
        width: 400, height: 400, borderRadius: '50%',
        background: 'rgba(234, 88, 12, 0.15)',
        filter: 'blur(60px)',
        display: 'flex',
      }} />
      <div style={{
        position: 'absolute', bottom: -100, left: -60,
        width: 500, height: 500, borderRadius: '50%',
        background: 'rgba(234, 88, 12, 0.10)',
        filter: 'blur(80px)',
        display: 'flex',
      }} />

      {/* Top accent bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0,
        width: '100%', height: 6,
        background: 'linear-gradient(90deg, #ea580c, #f97316, #ea580c)',
        display: 'flex',
      }} />

      {/* Content */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        padding: '0 80px',
        textAlign: 'center',
      }}>
        {/* Badge */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'rgba(234, 88, 12, 0.15)',
          border: '1px solid rgba(234, 88, 12, 0.4)',
          borderRadius: 100,
          padding: '8px 20px',
        }}>
          <span style={{ color: '#f97316', fontSize: 13, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase' }}>
            🌍 Marketplace Panafricaine
          </span>
        </div>

        {/* Main title */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
        }}>
          <span style={{
            fontSize: 88,
            fontWeight: 900,
            color: '#ffffff',
            letterSpacing: -4,
            lineHeight: 1,
          }}>
            MIAD
          </span>
          <span style={{
            fontSize: 48,
            fontWeight: 900,
            color: '#ea580c',
            letterSpacing: -2,
            lineHeight: 1,
            textTransform: 'uppercase',
          }}>
            Market
          </span>
        </div>

        {/* Tagline */}
        <span style={{
          fontSize: 22,
          color: '#94a3b8',
          fontWeight: 400,
          letterSpacing: 2,
          textTransform: 'uppercase',
        }}>
          Made in Africa, Shared with the World
        </span>

        {/* Feature pills */}
        <div style={{
          display: 'flex',
          gap: 12,
          marginTop: 8,
        }}>
          {['🛒 Artisanat', '👗 Mode', '🌿 Alimentation', '💄 Beauté'].map(label => (
            <div key={label} style={{
              display: 'flex',
              background: 'rgba(255,255,255,0.07)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8,
              padding: '8px 16px',
              color: '#e2e8f0',
              fontSize: 14,
              fontWeight: 600,
            }}>
              {label}
            </div>
          ))}
        </div>
      </div>

      {/* Bottom bar */}
      <div style={{
        position: 'absolute',
        bottom: 28,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        color: '#475569',
        fontSize: 14,
        fontWeight: 600,
        letterSpacing: 1,
      }}>
        <span>miadmarket.com</span>
        <span style={{ color: '#ea580c' }}>•</span>
        <span>Wave · Orange Money · Carte bancaire</span>
      </div>
    </div>
  )
}

export async function GET() {
  const text = 'MIAD Market — Made in Africa, Shared with the World 🌍 Marketplace Panafricaine 🛒 Artisanat 👗 Mode 🌿 Alimentation 💄 Beauté miadmarket.com • Wave · Orange Money · Carte bancaire'

  const [regular, bold, black] = await Promise.all([
    loadGoogleFont('Inter', 400, text),
    loadGoogleFont('Inter', 700, text),
    loadGoogleFont('Inter', 900, text),
  ])

  const svg = await satori(<OgImage />, {
    width: WIDTH,
    height: HEIGHT,
    fonts: [
      { name: 'Inter', data: regular, weight: 400, style: 'normal' },
      { name: 'Inter', data: bold, weight: 700, style: 'normal' },
      { name: 'Inter', data: black, weight: 900, style: 'normal' },
    ],
  })

  const resvg = await Resvg.async(svg, { fitTo: { mode: 'width', value: WIDTH } })
  const png = resvg.render().asPng()
  const pngBuffer = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer

  return new Response(pngBuffer, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, s-maxage=86400',
    },
  })
}

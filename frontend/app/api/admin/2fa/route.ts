import { NextResponse } from 'next/server';
import qrcode from 'qrcode-generator';

export const runtime = 'edge';

const SHARED_SECRET = process.env.ADMIN_2FA_SECRET;
// Jeton distinct, jamais expose au navigateur (pas de prefixe NEXT_PUBLIC_),
// connu uniquement de la personne qui configure le serveur. Necessaire pour
// obtenir le QR code/secret via GET — sans ca, n'importe quel visiteur
// pouvait recuperer le secret TOTP en clair et generer lui-meme des codes
// valides, rendant le "2FA" totalement inoffensif.
const SETUP_TOKEN = process.env.ADMIN_2FA_SETUP_TOKEN;
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1; // marge de 30s avant/après

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Encode des octets ASCII en Base32 (RFC 4648) — requis par le format otpauth://
function base32Encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

async function hmacSha1(keyBytes: Uint8Array, messageBytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, messageBytes);
  return new Uint8Array(signature);
}

// TOTP (RFC 6238) — le secret est utilisé tel quel (encodage ASCII), pas décodé en base32
async function generateTotp(secret: string, counter: number): Promise<string> {
  const keyBytes = new TextEncoder().encode(secret);
  const counterBytes = new Uint8Array(8);
  // counter en big-endian 64 bits (on reste sur les 32 bits bas, largement suffisant)
  new DataView(counterBytes.buffer).setUint32(4, counter, false);

  const hash = await hmacSha1(keyBytes, counterBytes);
  const offset = hash[hash.length - 1] & 0x0f;
  const binCode =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  const otp = binCode % 10 ** TOTP_DIGITS;
  return otp.toString().padStart(TOTP_DIGITS, '0');
}

async function verifyTotp(secret: string, token: string, window: number): Promise<boolean> {
  const counter = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    const candidate = await generateTotp(secret, counter + errorWindow);
    if (candidate === token) return true;
  }
  return false;
}

function buildOtpauthUrl(secret: string): string {
  const label = encodeURIComponent('MIAD Market: Admin');
  const issuer = encodeURIComponent('MIAD');
  const base32Secret = base32Encode(secret);
  return `otpauth://totp/${label}?secret=${base32Secret}&issuer=${issuer}`;
}

function qrCodeDataUrl(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 4 });
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export async function GET(req: Request) {
  if (!SHARED_SECRET || !SETUP_TOKEN) {
    return NextResponse.json({ error: 'Configuration serveur incomplète' }, { status: 500 });
  }
  // Le secret TOTP en clair ne doit jamais etre servi a un visiteur anonyme :
  // n'importe qui pouvait sinon le lire ici et generer lui-meme des codes
  // valides, rendant la verification 2FA totalement inoffensive. Seule une
  // personne connaissant deja le jeton de configuration (defini cote serveur,
  // jamais expose au navigateur) peut recuperer le QR code/secret.
  if (req.headers.get('X-Setup-Token') !== SETUP_TOKEN) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  }

  const otpauthUrl = buildOtpauthUrl(SHARED_SECRET);

  return NextResponse.json({
    qrCode: qrCodeDataUrl(otpauthUrl),
    secret: SHARED_SECRET
  });
}

export async function POST(req: Request) {
  try {
    if (!SHARED_SECRET) {
      return NextResponse.json({ error: 'Configuration serveur incomplète' }, { status: 500 });
    }
    const { code } = await req.json();

    const verified = await verifyTotp(SHARED_SECRET, code, TOTP_WINDOW);

    if (verified) {
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ success: false, error: "Code invalide" }, { status: 401 });
  } catch (error) {
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}

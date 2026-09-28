import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { seal, unseal } from '../secrets.js'

// Authenticator apps (RFC 6238): 6 digits, 30-second steps, HMAC-SHA1, which is what every app
// supports. A code is accepted for the step before and after the current one too, for clocks that
// are a little off, and never for a step at or before the last one used (see totp_secrets.last_step).

export const STEP_SECONDS = 30
export const DIGITS = 6
const WINDOW = 1
const SECRET_BYTES = 20
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const index = BASE32.indexOf(ch)
    if (index < 0) throw new Error('Not base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function newTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES)
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS)
}

// The code for one time step (RFC 4226 with the step as the counter)
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', secret).update(counter).digest()
  const offset = mac[mac.length - 1] & 15
  const binary = mac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0')
}

// The step the code belongs to, or null. Steps at or before `lastStep` don't count, so a code that
// was used (or one older than it) can't be replayed.
export function matchTotp(secret: Buffer, code: string, lastStep: number, now = Date.now()): number | null {
  const given = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(given)) return null
  const step = currentStep(now)
  for (let s = step - WINDOW; s <= step + WINDOW; s++) {
    if (s <= lastStep) continue
    if (timingSafeEqual(Buffer.from(totpCode(secret, s)), Buffer.from(given))) return s
  }
  return null
}

// otpauth:// link the QR code carries; apps show the issuer and the account
export function otpauthUrl(secret: Buffer, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const params = new URLSearchParams({ secret: base32Encode(secret), issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) })
  return `otpauth://totp/${label}?${params}`
}

// Secrets are stored encrypted (AES-256-GCM) with a key from server_secrets, so a copy of the
// totp_secrets table alone, or a query log, doesn't give anyone the codes. A full database backup
// holds the key too; see docs/security.md.
export const sealSecret = (secret: Buffer) => seal('two-factor', secret)
export const openSecret = (sealed: string) => unseal('two-factor', sealed)

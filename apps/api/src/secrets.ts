import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, schema } from './db/index.js'
import { env } from './env.js'

// With ENCRYPTION_KEY set, every row of server_secrets holds its key encrypted with a key derived
// from it: "w1.<key id>.<iv>.<body>.<tag>". Without it, a row holds the key itself in base64url,
// which never contains a dot. Encrypting a row doesn't change the key it holds, so what was signed
// or sealed with it stays valid.
const WRAPPED = 'w1'

// A row the keys given can't open, as opposed to a database that can't be reached
export class ServerSecretsError extends Error {}

type Keys = { key: Buffer | null; previousKey: Buffer | null }
type Row = { name: string; value: string }

// The key id says which ENCRYPTION_KEY a row was encrypted with, so a wrong key is told apart from
// a damaged row, and rows still under ENCRYPTION_KEY_PREVIOUS are found. It reveals nothing about the key.
function wrappingKey(key: Buffer) {
  const derive = (info: string, length: number) => Buffer.from(hkdfSync('sha256', key, 'the-artifact', info, length))
  return { id: derive('server-secrets key id', 6).toString('base64url'), key: derive('server-secrets wrapping key', 32) }
}

// The row's name is authenticated with it, so one row's value can't be copied over another's
export function wrapSecret(name: string, secret: Buffer, key: Buffer): string {
  const k = wrappingKey(key)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', k.key, iv).setAAD(Buffer.from(name))
  const body = Buffer.concat([cipher.update(secret), cipher.final()])
  return [WRAPPED, k.id, iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}

// The key a row holds, and whether the row should be written again under ENCRYPTION_KEY (it is in
// the clear, or under ENCRYPTION_KEY_PREVIOUS). Throws for a row the keys given can't open: a new
// key made in its place would lock everyone out of their authenticator app.
export function unwrapSecret(name: string, stored: string, keys: Keys): { secret: Buffer; stale: boolean } {
  if (!stored.includes('.')) return { secret: Buffer.from(stored, 'base64url'), stale: keys.key !== null }
  const [version, id, iv, body, tag, ...rest] = stored.split('.')
  if (version !== WRAPPED || !id || !iv || !body || !tag || rest.length) throw new ServerSecretsError(`The server secret "${name}" is in an unknown format.`)
  if (!keys.key)
    throw new ServerSecretsError(
      `The server secret "${name}" is encrypted, but ENCRYPTION_KEY isn't set. Set ENCRYPTION_KEY to the key this database was encrypted with.`,
    )
  const candidates = [keys.key, keys.previousKey].filter((k) => k !== null).map(wrappingKey)
  const match = candidates.find((k) => k.id === id)
  if (!match)
    throw new ServerSecretsError(
      `The server secret "${name}" was encrypted with another ENCRYPTION_KEY. Set ENCRYPTION_KEY to the key this database was encrypted with; while changing keys, set the old one as ENCRYPTION_KEY_PREVIOUS.`,
    )
  try {
    const decipher = createDecipheriv('aes-256-gcm', match.key, Buffer.from(iv, 'base64url')).setAAD(Buffer.from(name))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    const secret = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()])
    return { secret, stale: match !== candidates[0] }
  } catch {
    throw new ServerSecretsError(`The server secret "${name}" can't be decrypted with ENCRYPTION_KEY: the row is damaged.`)
  }
}

async function open(row: Row): Promise<{ secret: Buffer; rewritten: boolean }> {
  const keys = env.encryption
  const { secret, stale } = unwrapSecret(row.name, row.value, keys)
  if (!stale || !keys.key) return { secret, rewritten: false }
  // Only while the row still holds what was read, so processes doing this at once write it once and
  // never replace a key another one just wrote
  const updated = await db
    .update(schema.serverSecrets)
    .set({ value: wrapSecret(row.name, secret, keys.key) })
    .where(and(eq(schema.serverSecrets.name, row.name), eq(schema.serverSecrets.value, row.value)))
    .returning({ name: schema.serverSecrets.name })
  return { secret, rewritten: updated.length > 0 }
}

// Opens every row and encrypts those that aren't under ENCRYPTION_KEY yet. The long-running server
// runs it before it serves (src/startup.ts), so a missing or wrong key stops it there; every process
// also runs it before it first uses a key (Vercel has no start of its own). Returns how many rows it
// encrypted.
export async function checkServerSecrets(): Promise<number> {
  let rewritten = 0
  for (const row of await db.select().from(schema.serverSecrets)) if ((await open(row)).rewritten) rewritten += 1
  return rewritten
}

let checked: Promise<number> | null = null
const cache = new Map<string, Promise<Buffer>>()

// A random 32-byte key the server makes for itself on first use, e.g. "content-links". Created once
// per database and shared by every server process.
export function serverSecret(name: string): Promise<Buffer> {
  let secret = cache.get(name)
  if (!secret) {
    secret = (async () => {
      checked ??= checkServerSecrets().catch((err) => {
        checked = null
        throw err
      })
      await checked
      const fresh = randomBytes(32)
      const { key } = env.encryption
      await db
        .insert(schema.serverSecrets)
        .values({ name, value: key ? wrapSecret(name, fresh, key) : fresh.toString('base64url') })
        .onConflictDoNothing()
      const [row] = await db.select().from(schema.serverSecrets).where(eq(schema.serverSecrets.name, name))
      return (await open(row)).secret
    })().catch((err) => {
      cache.delete(name)
      throw err
    })
    cache.set(name, secret)
  }
  return secret
}

// For tests, which truncate the table and change the keys behind the app's back
export function forgetServerSecrets() {
  cache.clear()
  checked = null
}

// Encrypts a value (AES-256-GCM) with the server secret `name`, so a copy of the table that holds it,
// or a query log, doesn't give it away. Without ENCRYPTION_KEY, a full database backup holds the key
// too; see docs/security.md.
export async function seal(name: string, value: Buffer): Promise<string> {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', await serverSecret(name), iv)
  const body = Buffer.concat([cipher.update(value), cipher.final()])
  return ['v1', iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}

export async function unseal(name: string, sealed: string): Promise<Buffer> {
  const [version, iv, body, tag] = sealed.split('.')
  if (version !== 'v1' || !iv || !body || !tag) throw new Error('Unknown sealed value format')
  const decipher = createDecipheriv('aes-256-gcm', await serverSecret(name), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()])
}

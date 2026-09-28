import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, schema } from './db/index.js'

const cache = new Map<string, Promise<Buffer>>()

// A random 32-byte key the server makes for itself on first use, e.g. "content-links". Created once
// per database and shared by every server process.
export function serverSecret(name: string): Promise<Buffer> {
  let secret = cache.get(name)
  if (!secret) {
    secret = (async () => {
      await db
        .insert(schema.serverSecrets)
        .values({ name, value: randomBytes(32).toString('base64url') })
        .onConflictDoNothing()
      const [row] = await db.select().from(schema.serverSecrets).where(eq(schema.serverSecrets.name, name))
      return Buffer.from(row.value, 'base64url')
    })().catch((err) => {
      cache.delete(name)
      throw err
    })
    cache.set(name, secret)
  }
  return secret
}

// Encrypts a value (AES-256-GCM) with the server secret `name`, so a copy of the table that holds it,
// or a query log, doesn't give it away. A full database backup holds the key too; see docs/security.md.
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

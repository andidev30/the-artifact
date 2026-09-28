import { randomBytes } from 'node:crypto'
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

import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, schema } from './db/index.js'
import { env, normalizeSetupCode } from './env.js'
import { unwrapSecret, wrapSecret } from './secrets.js'

// The first account on a self-hosted install becomes its admin, so it takes a one-time code only the
// operator can read: the server prints a new one to its log each time it starts without accounts, or
// uses SETUP_CODE. Only its hash is kept, in server_secrets, so every worker checks the same code and a
// copy of the database doesn't give it away. It is forgotten once the first account exists.

const ROW = 'setup-code'
// No 0/O or 1/I, so a code read off a terminal is typed right the first time
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const GROUPS = 3
const GROUP_LENGTH = 4

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// Thrown by newAccountFields when the first account is being created without the right code
export class SetupCodeError extends Error {
  constructor() {
    super('The setup code is missing or wrong.')
  }
}

// 60 random bits, as XXXX-XXXX-XXXX
export function newSetupCode(): string {
  const groups = Array.from({ length: GROUPS }, () => Array.from({ length: GROUP_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''))
  return groups.join('-')
}

const digest = (code: string) => createHash('sha256').update(code).digest()

export async function storeSetupCode(code: string) {
  // Stored like every other row of server_secrets, encrypted under ENCRYPTION_KEY when it is set,
  // since checkServerSecrets encrypts any row it finds in the clear
  const hash = digest(normalizeSetupCode(code))
  const { key } = env.encryption
  const value = key ? wrapSecret(ROW, hash, key) : hash.toString('base64url')
  await db
    .insert(schema.serverSecrets)
    .values({ name: ROW, value })
    .onConflictDoUpdate({ target: schema.serverSecrets.name, set: { value, createdAt: new Date() } })
}

export async function forgetSetupCode(tx: Tx | typeof db = db) {
  await tx.delete(schema.serverSecrets).where(eq(schema.serverSecrets.name, ROW))
}

export async function setupCodeMatches(given: unknown, tx: Tx | typeof db = db): Promise<boolean> {
  const code = normalizeSetupCode(given)
  if (!code) return false
  let expected: Buffer
  if (env.setupCode) {
    expected = digest(env.setupCode)
  } else {
    const [row] = await tx.select({ value: schema.serverSecrets.value }).from(schema.serverSecrets).where(eq(schema.serverSecrets.name, ROW))
    if (!row) return false
    expected = unwrapSecret(ROW, row.value, env.encryption).secret
  }
  const actual = digest(code)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

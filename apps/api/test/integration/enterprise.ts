import { generateKeyPairSync } from 'node:crypto'
import { db, schema } from '../../src/db/index.js'
import { readSigningKey, signLicense } from '../../src/ee/licenses.js'
import { LICENSE_PUBLIC_KEYS } from '../../src/license.js'

// Turns Enterprise on for a self-hosted install, the way an admin pasting a key would: a key signed by
// a signing key the test adds to LICENSE_PUBLIC_KEYS. Call removeTestSigningKeys() in afterEach.

const added: string[] = []

export async function enableEnterprise(opts: { expiresAt?: Date } = {}) {
  const { privateKey } = generateKeyPairSync('ed25519')
  const key = readSigningKey(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))
  if (!key) throw new Error('no signing key')
  LICENSE_PUBLIC_KEYS[key.keyId] = key.publicKey
  added.push(key.keyId)
  const licenseKey = signLicense(
    {
      id: '6f1c0b8e-4a8f-4f8e-9d7a-2b1f1c0e5a11',
      customer: 'Acme Inc',
      email: 'it@acme.example',
      seats: 50,
      issuedAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      expiresAt: (opts.expiresAt ?? new Date(Date.now() + 365 * 86_400_000)).toISOString(),
    },
    key,
  )
  await db
    .insert(schema.instanceSettings)
    .values({ id: 1, signupPolicy: 'open', licenseKey })
    .onConflictDoUpdate({ target: schema.instanceSettings.id, set: { licenseKey } })
}

export async function disableEnterprise() {
  await db.update(schema.instanceSettings).set({ licenseKey: null })
}

export function removeTestSigningKeys() {
  for (const id of added.splice(0)) delete LICENSE_PUBLIC_KEYS[id]
}

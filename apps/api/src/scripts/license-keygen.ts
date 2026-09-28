// Makes an Ed25519 key pair for signing license keys, for the operator of the hosted service. It
// only prints: the private key goes into LICENSE_SIGNING_KEY on the hosted service and nowhere else,
// and the public key goes into LICENSE_PUBLIC_KEYS in src/license.ts, so every install released
// after that can check the keys it signs. See docs/licenses.md.
//   pnpm --filter @the-artifact/api license:keygen
// Imports nothing from the app, so it runs without a database or any other setting.
import { createHash, generateKeyPairSync } from 'node:crypto'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64')
// Same as licenseKeyId in src/license.ts; a mismatch shows in Server admin, which names the id it expects
const keyId = createHash('sha256').update(Buffer.from(raw, 'base64')).digest('base64url').slice(0, 12)
const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')

console.log(`Private key. Keep it secret and set it on the hosted service only:

LICENSE_SIGNING_KEY=${der}

Public key. Add this line to LICENSE_PUBLIC_KEYS in apps/api/src/license.ts and release it:

  '${keyId}': '${raw}',
`)

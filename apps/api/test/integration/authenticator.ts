import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { isoCBOR } from '@simplewebauthn/server/helpers'

// A software passkey for tests: an ES256 key pair that answers navigator.credentials.create() and
// .get() the way a browser and an authenticator would, with "none" attestation. The server checks
// its responses with the same code as a real one's.

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()

const UP = 0x01
const UV = 0x04
const AT = 0x40

export class Authenticator {
  readonly credentialId = randomBytes(16)
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  private counter = 0
  userHandle: string | null = null

  constructor(
    readonly origin = 'http://localhost:5177',
    readonly rpId = 'localhost',
  ) {}

  get id() {
    return b64(this.credentialId)
  }

  private coseKey() {
    const jwk = this.keys.publicKey.export({ format: 'jwk' })
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    )
  }

  private authData(flags: number, rpId: string, attested?: Buffer) {
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), counter, ...(attested ? [attested] : [])])
  }

  private clientData(type: string, challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  }

  register(options: PublicKeyCredentialCreationOptionsJSON, opts: { origin?: string } = {}): RegistrationResponseJSON {
    this.userHandle = options.user.id
    const idLength = Buffer.alloc(2)
    idLength.writeUInt16BE(this.credentialId.length)
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, this.coseKey()])
    const authData = this.authData(UP | UV | AT, options.rp.id ?? this.rpId, attested)
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, string>>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, string>()],
        ['authData', authData],
      ]),
    )
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64(this.clientData('webauthn.create', options.challenge, opts.origin ?? this.origin)),
        attestationObject: b64(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    }
  }

  authenticate(options: PublicKeyCredentialRequestOptionsJSON, opts: { userVerified?: boolean; origin?: string } = {}): AuthenticationResponseJSON {
    this.counter += 1
    const authData = this.authData(UP | (opts.userVerified === false ? 0 : UV), options.rpId ?? this.rpId)
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, opts.origin ?? this.origin)
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.keys.privateKey)
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64(clientDataJSON),
        authenticatorData: b64(authData),
        signature: b64(signature),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
      clientExtensionResults: {},
    }
  }
}

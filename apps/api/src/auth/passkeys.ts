import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { and, eq, lt } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { Passkey, User } from '../db/schema.js'
import { env } from '../env.js'
import { instanceSettings } from '../instance.js'
import { log } from '../log.js'
import { hashToken } from './session.js'

// Passkeys (WebAuthn) through @simplewebauthn/server. The relying party is the app's own address:
// the RP ID is APP_URL's host name and responses must come from APP_URL's origin, so passkeys made on
// one install never work on another, and changing APP_URL's host makes existing passkeys unusable.

export const MAX_PASSKEYS = 20
const CHALLENGE_TTL = 5 * 60 * 1000

export type Purpose = 'register' | 'sign-in' | 'second-factor'

const appUrl = () => new URL(env.appUrl)
export const rpId = () => appUrl().hostname
const origin = () => appUrl().origin

// The WebAuthn user handle: the account id's 16 bytes, which says nothing about the person
const userHandle = (userId: string) => Buffer.from(userId.replaceAll('-', ''), 'hex')

async function remember(challenge: string, purpose: Purpose, userId: string | null) {
  await db.delete(schema.webauthnChallenges).where(lt(schema.webauthnChallenges.expiresAt, new Date()))
  await db.insert(schema.webauthnChallenges).values({ id: hashToken(challenge), purpose, userId, expiresAt: new Date(Date.now() + CHALLENGE_TTL) })
}

// Uses the challenge up whether or not the rest of the response checks out, so each one is tried once
function challengeFor(purpose: Purpose, userId: string | null) {
  return async (challenge: string) => {
    const [row] = await db
      .delete(schema.webauthnChallenges)
      .where(and(eq(schema.webauthnChallenges.id, hashToken(challenge)), eq(schema.webauthnChallenges.purpose, purpose)))
      .returning()
    return Boolean(row && row.expiresAt.getTime() > Date.now() && row.userId === userId)
  }
}

export async function passkeysOf(userId: string) {
  return db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, userId)).orderBy(schema.passkeys.createdAt)
}

export async function registrationOptions(user: Pick<User, 'id' | 'email' | 'name'>) {
  const existing = await passkeysOf(user.id)
  const options = await generateRegistrationOptions({
    rpName: (await instanceSettings()).instanceName || 'The Artifact',
    rpID: rpId(),
    userName: user.email,
    userDisplayName: user.name ?? user.email,
    userID: userHandle(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
    // Discoverable when the authenticator can, so the passkey also signs in without an email address
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  })
  await remember(options.challenge, 'register', user.id)
  return options
}

export class PasskeyError extends Error {}

export async function verifyRegistration(userId: string, response: RegistrationResponseJSON) {
  let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challengeFor('register', userId),
      expectedOrigin: origin(),
      expectedRPID: rpId(),
      requireUserVerification: false,
    })
  } catch (err) {
    log.warn('Passkey registration failed', { err })
    throw new PasskeyError('The passkey could not be added. Try again.')
  }
  if (!result.verified) throw new PasskeyError('The passkey could not be added. Try again.')
  const { credential, credentialBackedUp } = result.registrationInfo
  return {
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports ?? [],
    backedUp: credentialBackedUp,
  }
}

// Options for the browser. For a second factor, allowCredentials lists the person's own passkeys;
// signing in with a passkey alone lists none, so the browser offers any passkey for this site.
export async function authenticationOptions(purpose: 'sign-in' | 'second-factor', userId: string | null) {
  const allow = userId ? await passkeysOf(userId) : []
  const options = await generateAuthenticationOptions({
    rpID: rpId(),
    allowCredentials: allow.map((p) => ({ id: p.credentialId, transports: p.transports })),
    // Signing in with only a passkey counts as both factors, so the authenticator must check it's the person (PIN, fingerprint, face)
    userVerification: purpose === 'sign-in' ? 'required' : 'preferred',
  })
  await remember(options.challenge, purpose, userId)
  return options
}

// The passkey that signed the response, once its signature, challenge, origin and counter check out.
// userId is the account a second factor must belong to; null for signing in with a passkey alone.
export async function verifyAuthentication(
  purpose: 'sign-in' | 'second-factor',
  userId: string | null,
  response: AuthenticationResponseJSON,
): Promise<Passkey> {
  const id = typeof response?.id === 'string' ? response.id : ''
  const [passkey] = id ? await db.select().from(schema.passkeys).where(eq(schema.passkeys.credentialId, id)) : []
  if (!passkey || (userId && passkey.userId !== userId)) {
    throw new PasskeyError(
      purpose === 'sign-in' ? 'This passkey isn’t set up for an account here. Sign in another way.' : 'Use a passkey you added to this account.',
    )
  }
  let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeFor(purpose, userId),
      expectedOrigin: origin(),
      expectedRPID: rpId(),
      credential: {
        id: passkey.credentialId,
        publicKey: Buffer.from(passkey.publicKey, 'base64url'),
        counter: passkey.counter,
        transports: passkey.transports,
      },
      requireUserVerification: purpose === 'sign-in',
    })
  } catch (err) {
    log.warn('Passkey check failed', { err })
    throw new PasskeyError(
      purpose === 'sign-in'
        ? 'The passkey could not be checked. Try again, and unlock it with your PIN, fingerprint or face when asked.'
        : 'The passkey could not be checked. Try again.',
    )
  }
  if (!result.verified) throw new PasskeyError('The passkey could not be checked. Try again.')
  const [updated] = await db
    .update(schema.passkeys)
    .set({ counter: result.authenticationInfo.newCounter, backedUp: result.authenticationInfo.credentialBackedUp, lastUsedAt: new Date() })
    .where(eq(schema.passkeys.id, passkey.id))
    .returning()
  return updated
}

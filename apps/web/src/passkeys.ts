import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser'
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { ApiError } from './api'

export const passkeysSupported = () => browserSupportsWebAuthn()

export const askForPasskey = (optionsJSON: PublicKeyCredentialRequestOptionsJSON) => startAuthentication({ optionsJSON })

export const createPasskey = (optionsJSON: PublicKeyCredentialCreationOptionsJSON) => startRegistration({ optionsJSON })

// What to tell someone when the browser or the server turned a passkey down
export function passkeyErrorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof WebAuthnError && err.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'This passkey is already added to your account.'
  if (
    err instanceof Error &&
    (err.name === 'NotAllowedError' || err.name === 'AbortError' || (err instanceof WebAuthnError && err.code === 'ERROR_CEREMONY_ABORTED'))
  ) {
    return 'The passkey request was cancelled or timed out. Try again.'
  }
  return fallback
}

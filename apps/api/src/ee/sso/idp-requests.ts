import type { CustomFetch } from 'openid-client'
import { env, isProduction } from '../../env.js'
import { fetchOutbound, isLoopbackAddress, isPrivateNetworkAddress, isPublicAddress, type OutboundRequest } from '../../network.js'

// Requests to identity providers, at addresses an admin typed in: the SAML metadata URL, the OIDC
// issuer and the endpoints its discovery document names. Company IdPs often run on the company's
// own network, so a self-hosted install may reach private addresses; loopback only while APP_URL is
// http (trying SSO locally); link-local addresses (cloud metadata services) and other reserved
// ranges never.
export function idpAddress(ip: string): boolean {
  return isPublicAddress(ip) || (env.selfHosted && isPrivateNetworkAddress(ip)) || (!isProduction && isLoopbackAddress(ip))
}

// Discovery documents, JWKS and token answers are a few KB
const MAX_ANSWER_BYTES = 1024 * 1024

export function idpRequest(url: URL, req: Omit<OutboundRequest, 'allow'>): Promise<Response> {
  return fetchOutbound(url, { ...req, allow: idpAddress })
}

// For openid-client, which makes every request to the provider through it
export function oidcFetch(timeoutMs: number): CustomFetch {
  return async (url, options) => {
    const body = options.body
    return idpRequest(new URL(url), {
      method: options.method,
      headers: options.headers,
      body:
        body === undefined || body === null
          ? undefined
          : typeof body === 'string'
            ? body
            : body instanceof URLSearchParams
              ? body.toString()
              : body instanceof Uint8Array
                ? body
                : new Uint8Array(await new Response(body).arrayBuffer()),
      signal: options.signal,
      timeoutMs,
      maxBytes: MAX_ANSWER_BYTES,
    })
  }
}

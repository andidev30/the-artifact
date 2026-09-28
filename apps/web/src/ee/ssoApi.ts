import { ApiError } from '../api'

// Single sign-on connections under /api/admin/sso (Enterprise, self-hosted only)

export type SsoConnection = {
  id: string
  protocol: 'oidc' | 'saml'
  name: string
  enabled: boolean
  issuer: string
  clientId: string
  hasClientSecret: boolean
  trustEmail: boolean
  // SAML connections only
  saml: SamlSettings | null
  allowedDomains: string[]
  required: boolean
  organizationId: string | null
  createdAt: string
  updatedAt: string
}

export type SamlSettings = {
  metadataUrl: string | null
  idpEntityId: string
  ssoUrl: string
  certificates: number
  emailAttribute: string | null
  nameAttribute: string | null
  allowIdpInitiated: boolean
}

export type SsoListing = {
  redirectUri: string
  // What a SAML IdP needs from this server
  saml: { entityId: string; acsUrl: string }
  connections: SsoConnection[]
  organizations: { id: string; name: string }[]
}

export type SsoInput = {
  protocol: 'oidc' | 'saml'
  name: string
  issuer: string
  clientId: string
  // Empty keeps the stored secret when editing
  clientSecret: string
  trustEmail: boolean
  allowedDomains: string[]
  required: boolean
  enabled: boolean
  organizationId: string | null
  // SAML: the IdP's metadata by URL or pasted (both empty keeps it when editing), and attribute names
  metadataUrl?: string
  metadataXml?: string
  emailAttribute?: string
  nameAttribute?: string
  allowIdpInitiated?: boolean
}

export type SsoTestResult = {
  connectionId: string
  ok: boolean
  error?: string
  subject?: string
  email?: string | null
  emailVerified?: boolean
  name?: string | null
  accepted?: boolean
}

async function ssoRequest<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  const res = await fetch(`/api/admin/sso${path}`, {
    method: init?.method,
    credentials: 'same-origin',
    headers: init?.json === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init?.json === undefined ? undefined : JSON.stringify(init.json),
  })
  const data = res.status === 204 ? null : await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data?.error ?? 'Something went wrong. Try again.', res.status, data?.code, data?.field)
  return data as T
}

export const listSso = () => ssoRequest<SsoListing>('')
export const createSso = (input: SsoInput) => ssoRequest<SsoConnection>('', { method: 'POST', json: input })
export const updateSso = (id: string, input: SsoInput) => ssoRequest<SsoConnection>(`/${encodeURIComponent(id)}`, { method: 'PUT', json: input })
export const deleteSso = (id: string) => ssoRequest<null>(`/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const ssoTestResult = () => ssoRequest<SsoTestResult>('/test-result')
// A browser navigation: the provider's sign-in page, then back to /admin#sso
export const ssoTestUrl = (id: string) => `/api/admin/sso/${encodeURIComponent(id)}/test`

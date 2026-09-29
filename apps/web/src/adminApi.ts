import { ApiError, type Role } from './api'

// The instance admin area (/api/admin)

export type SignupPolicy = 'open' | 'domains' | 'invite-only'

export type AdminOverview = {
  users: number
  admins: number
  suspended: number
  newThisWeek: number
  activeThisWeek: number
  organizations: number
  pages: number
  peopleWithAgents: number
  signupPolicy: SignupPolicy
  allowedDomains: string[]
}

export type AdminUser = {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  createdAt: string
  lastSeenAt: string | null
  isAdmin: boolean
  suspended: boolean
  suspendedAt: string | null
  organizations: { id: string; name: string; role: Role }[]
  pageCount: number
  // Has a passkey or an authenticator app
  twoFactor?: boolean
  isYou: boolean
}

export type AdminOrganization = {
  id: string
  name: string
  slug: string
  createdAt: string
  memberCount: number
  pageCount: number
  owners: { id: string; email: string; name: string | null }[]
}

export type Paged<K extends string, T> = { [key in K]: T[] } & { total: number; offset: number; pageSize: number }

export type UserFilter = 'all' | 'admins' | 'suspended'

export type InstanceSettings = {
  signupPolicy: SignupPolicy
  allowedDomains: string[]
  instanceName: string | null
  updatedAt: string | null
}

// A link an admin passes on by hand on a server without email
export type SignUpLink = { email: string; link: string; newAccount: boolean; expiresAt: string }

export type UserDeletionPreview = {
  blockedBy: { id: string; name: string }[]
  deletesOrganizations: string[]
  pageCount: number
}

export async function adminRequest<T>(path: string, init?: { method?: string; json?: unknown; signal?: AbortSignal }): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method: init?.method,
    credentials: 'same-origin',
    signal: init?.signal,
    headers: init?.json === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init?.json === undefined ? undefined : JSON.stringify(init.json),
  })
  const data = res.status === 204 ? null : await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data?.error ?? 'Something went wrong. Try again.', res.status, data?.code, data?.field)
  return data as T
}

export const getOverview = () => adminRequest<AdminOverview>('/overview')

export function listUsers(q: string, filter: UserFilter, offset = 0, signal?: AbortSignal) {
  const params = new URLSearchParams({ offset: String(offset) })
  if (q.trim()) params.set('q', q.trim())
  if (filter !== 'all') params.set('filter', filter)
  return adminRequest<Paged<'users', AdminUser>>(`/users?${params}`, { signal })
}

export const updateUser = (id: string, change: { admin?: boolean; suspended?: boolean }) =>
  adminRequest<AdminUser>(`/users/${encodeURIComponent(id)}`, { method: 'PATCH', json: change })

export const getUserDeletion = (id: string) => adminRequest<UserDeletionPreview>(`/users/${encodeURIComponent(id)}/deletion`)

export const deleteUser = (id: string, confirmEmail: string) =>
  adminRequest<null>(`/users/${encodeURIComponent(id)}`, { method: 'DELETE', json: { confirmEmail } })

export function listOrganizations(q: string, offset = 0, signal?: AbortSignal) {
  const params = new URLSearchParams({ offset: String(offset) })
  if (q.trim()) params.set('q', q.trim())
  return adminRequest<Paged<'organizations', AdminOrganization>>(`/organizations?${params}`, { signal })
}

export const deleteOrganization = (id: string, confirmSlug: string) =>
  adminRequest<null>(`/organizations/${encodeURIComponent(id)}`, { method: 'DELETE', json: { confirmSlug } })

export const getSettings = () => adminRequest<InstanceSettings>('/settings')

// The release this server runs, and a newer one when GitHub lists it (self-hosted only)
export type ReleaseStatus = { current: string; newer: { version: string; url: string } | null }

export const getReleaseStatus = () => adminRequest<ReleaseStatus>('/release')

export const saveSettings = (value: { signupPolicy: SignupPolicy; allowedDomains: string[]; instanceName: string }) =>
  adminRequest<InstanceSettings>('/settings', { method: 'PUT', json: value })

// Joining an organization by email domain; no organization means it is off
export type AutoJoinSettings = {
  organization: { id: string; name: string; slug: string } | null
  domains: string[]
  updatedAt: string | null
  organizations: { id: string; name: string; slug: string }[]
}

export const getAutoJoin = () => adminRequest<AutoJoinSettings>('/auto-join')

export const saveAutoJoin = (value: { organizationId: string | null; domains: string[] }) =>
  adminRequest<AutoJoinSettings>('/auto-join', { method: 'PUT', json: value })

export const createSignUpLink = (email: string) => adminRequest<SignUpLink>('/sign-up-links', { method: 'POST', json: { email } })

// Removes every passkey, authenticator app and recovery code of someone else, and signs them out
export const resetTwoFactor = (id: string) => adminRequest<AdminUser>(`/users/${encodeURIComponent(id)}/reset-two-factor`, { method: 'POST' })

// A self-hosted install's license key (/api/admin/license)
export type LicenseStatus = 'none' | 'active' | 'grace' | 'expired'

export type LicenseState = {
  status: LicenseStatus
  // Why a saved key doesn't count, e.g. it was signed by a key this version doesn't know
  invalid: string | null
  license: { id: string; customer: string; email: string; seats: number; issuedAt: string; expiresAt: string; graceEndsAt: string } | null
  // Accounts that aren't suspended
  seatsInUse: number
}

export const getLicense = () => adminRequest<LicenseState>('/license')

export const saveLicense = (key: string) => adminRequest<LicenseState>('/license', { method: 'PUT', json: { key } })

export const removeLicense = () => adminRequest<LicenseState>('/license', { method: 'DELETE' })

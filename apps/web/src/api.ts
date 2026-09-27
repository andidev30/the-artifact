export type Role = 'owner' | 'admin' | 'member'

export type Organization = {
  id: string
  name: string
  slug: string
  role: Role
}

export type Me = {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  // Whether they can log in with a password (servers without email)
  hasPassword: boolean
  onboarded: boolean
  organizations: Organization[]
  agentConnected: boolean
  hasPublished: boolean
  // Instance admin: can open /admin
  isAdmin: boolean
}

// Resolves to the signed-in user, or null when nobody is signed in
export async function fetchMe(): Promise<Me | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin' })
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`GET /api/me failed with ${res.status}`)
  return res.json()
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
}

export async function finishPersonalOnboarding(): Promise<void> {
  const res = await fetch('/api/onboarding/personal', { method: 'POST', credentials: 'same-origin' })
  if (!res.ok) throw new Error(`Onboarding failed with ${res.status}`)
}

export type SlugCheck = { available: true } | { available: false; reason: string }

export async function checkSlug(slug: string, signal?: AbortSignal): Promise<SlugCheck> {
  const res = await fetch(`/api/organizations/slug-available?slug=${encodeURIComponent(slug)}`, { signal })
  if (!res.ok) throw new Error(`Slug check failed with ${res.status}`)
  return res.json()
}

export class FieldError extends Error {
  field: string | undefined
  constructor(message: string, field?: string) {
    super(message)
    this.field = field
  }
}

export async function createOrganization(name: string, slug: string): Promise<Organization> {
  const res = await fetch('/api/organizations', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, slug }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new FieldError(data.error ?? 'The organization could not be created. Try again.', data.field)
  return data
}

export type Visibility = 'private' | 'organization' | 'link'

export type ThumbnailState = 'ready' | 'pending' | 'none'

export type ArtifactSummary = {
  slug: string
  title: string
  visibility: Visibility
  version: number
  publishedWith: string | null
  updatedAt: string
  owner: string
  mine: boolean
  canEdit: boolean
  // Whether a screenshot of the current version exists yet
  thumbnail: boolean
  // Whether one is still being rendered ('pending'), so the gallery should ask again.
  // Missing from servers older than this field; treat that like 'none'.
  thumbnailState?: ThumbnailState
  // Set on pages shared with you
  role?: 'viewer' | 'editor'
}

export type ArtifactPage = {
  slug: string
  title: string
  visibility: Visibility
  version: number
  updatedAt: string
  owner: string | null
  inOrganization: boolean
  canEdit: boolean
  isOwner: boolean
}

export async function listArtifacts(workspace: string, query = '', signal?: AbortSignal): Promise<ArtifactSummary[]> {
  const params = new URLSearchParams({ workspace })
  if (query.trim()) params.set('q', query.trim())
  const res = await fetch(`/api/artifacts?${params}`, { credentials: 'same-origin', signal })
  if (!res.ok) throw new Error(`Listing pages failed with ${res.status}`)
  return res.json()
}

// null when the page doesn't exist or this person can't open it
export async function getArtifact(slug: string): Promise<ArtifactPage | null> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(slug)}`, { credentials: 'same-origin' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Loading the page failed with ${res.status}`)
  return res.json()
}

export async function setVisibility(slug: string, visibility: Visibility): Promise<void> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibility }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Visibility could not be changed.')
}

export type ConsentRequest = {
  clientName: string
  redirectHost: string
  workspaces: { id: string | null; name: string }[]
}

export class RequestExpired extends Error {}

// null when nobody is signed in
export async function getConsentRequest(id: string): Promise<ConsentRequest | null> {
  const res = await fetch(`/api/oauth/requests/${encodeURIComponent(id)}`, { credentials: 'same-origin' })
  if (res.status === 401) return null
  const data = await res.json().catch(() => ({}))
  if (res.status === 404) throw new RequestExpired(data.error)
  if (!res.ok) throw new Error(data.error ?? 'The request could not be loaded.')
  return data
}

export async function answerConsent(id: string, approve: boolean, organizationId: string | null): Promise<string> {
  const res = await fetch(`/api/oauth/requests/${encodeURIComponent(id)}/${approve ? 'approve' : 'deny'}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ organizationId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'The request could not be answered.')
  return data.redirect
}

export type ShareRole = 'viewer' | 'editor'

export type Sharing = {
  owner: { name: string | null; email: string; avatarUrl: string | null }
  people: { email: string; role: ShareRole; name: string | null; avatarUrl: string | null; pending: boolean }[]
  visibility: Visibility
  organizationName: string | null
}

async function sharingRequest<T>(slug: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(slug)}${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'Sharing could not be updated. Try again.')
  return data
}

export function getSharing(slug: string) {
  return sharingRequest<Sharing>(slug, '/sharing')
}

export function sharePeople(slug: string, emails: string, role: ShareRole, notify: boolean, message: string) {
  return sharingRequest<{ shared: string[]; notifyFailed: string[]; sharing: Sharing }>(slug, '/sharing/people', {
    method: 'POST',
    body: JSON.stringify({ emails, role, notify, message: message || undefined }),
  })
}

export function setPersonRole(slug: string, email: string, role: ShareRole) {
  return sharingRequest<Sharing>(slug, '/sharing/people', { method: 'PATCH', body: JSON.stringify({ email, role }) })
}

export function removePerson(slug: string, email: string) {
  return sharingRequest<Sharing>(slug, `/sharing/people?email=${encodeURIComponent(email)}`, { method: 'DELETE' })
}

// Members, invitations and account settings

export type InviteRole = 'admin' | 'member'

export type OrganizationMember = {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  role: Role
  joinedAt: string
}

export type PendingInvitation = {
  id: string
  email: string
  role: InviteRole
  expiresAt: string
  createdAt: string
  invitedBy: string | null
  expired: boolean
}

export type OrganizationDetails = Organization & {
  members: OrganizationMember[]
  invitations: PendingInvitation[]
}

export class ApiError extends Error {
  status: number
  code: string | undefined
  field: string | undefined
  constructor(message: string, status: number, code?: string, field?: string) {
    super(message)
    this.status = status
    this.code = code
    this.field = field
  }
}

async function request<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method,
    credentials: 'same-origin',
    headers: init?.json === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init?.json === undefined ? undefined : JSON.stringify(init.json),
  })
  const data = res.status === 204 ? null : await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data?.error ?? 'Something went wrong. Try again.', res.status, data?.code, data?.field)
  return data as T
}

const orgPath = (id: string) => `/organizations/${encodeURIComponent(id)}`

export function getOrganization(id: string) {
  return request<OrganizationDetails>(orgPath(id))
}

export function renameOrganization(id: string, name: string) {
  return request<OrganizationDetails>(orgPath(id), { method: 'PATCH', json: { name } })
}

export function inviteMember(id: string, email: string, role: InviteRole) {
  return request<{ emailed: boolean; link?: string; organization: OrganizationDetails }>(`${orgPath(id)}/invitations`, {
    method: 'POST',
    json: { email, role },
  })
}

export function revokeInvitation(id: string, invitationId: string) {
  return request<OrganizationDetails>(`${orgPath(id)}/invitations/${encodeURIComponent(invitationId)}`, { method: 'DELETE' })
}

export function setMemberRole(id: string, userId: string, role: Role) {
  return request<OrganizationDetails>(`${orgPath(id)}/members/${encodeURIComponent(userId)}`, { method: 'PATCH', json: { role } })
}

// Resolves to null when you removed yourself (left)
export function removeMember(id: string, userId: string) {
  return request<OrganizationDetails | null>(`${orgPath(id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })
}

export type Invitation = {
  organization: { id: string; name: string; slug: string; memberCount: number }
  email: string
  role: InviteRole
  invitedBy: string | null
  expiresAt: string
  expired: boolean
  signedInAs: string | null
  alreadyMember: boolean
  // Server without email and no account for this address yet: sign up on the invitation page
  canSignUpHere?: boolean
}

export function getInvitation(token: string) {
  return request<Invitation>(`/invitations/${encodeURIComponent(token)}`)
}

// Servers without email: creates the invited person's account and joins the organization
export function signUpFromInvitation(token: string, password: string, name: string) {
  return request<Organization>(`/invitations/${encodeURIComponent(token)}/sign-up`, { method: 'POST', json: { password, name } })
}

export function acceptInvitation(token: string) {
  return request<Organization>(`/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST' })
}

export function declineInvitation(token: string) {
  return request<null>(`/invitations/${encodeURIComponent(token)}/decline`, { method: 'POST' })
}

// Invitations to the signed-in person's email, answered inside the app without the email link
export type MyInvitation = {
  id: string
  organization: { id: string; name: string; slug: string }
  role: InviteRole
  invitedBy: string | null
  expiresAt: string
}

export function listMyInvitations() {
  return request<MyInvitation[]>('/me/invitations')
}

export function acceptMyInvitation(id: string) {
  return request<Organization>(`/me/invitations/${encodeURIComponent(id)}/accept`, { method: 'POST' })
}

export function declineMyInvitation(id: string) {
  return request<null>(`/me/invitations/${encodeURIComponent(id)}/decline`, { method: 'POST' })
}

export function updateProfile(name: string) {
  return request<{ name: string }>('/me', { method: 'PATCH', json: { name } })
}

export type ConnectedAgent = {
  clientId: string
  name: string
  workspaces: string[]
  lastUsedAt: string | null
  connectedAt: string
}

export function listAgents() {
  return request<ConnectedAgent[]>('/me/agents')
}

export function disconnectAgent(clientId: string) {
  return request<null>(`/me/agents/${encodeURIComponent(clientId)}`, { method: 'DELETE' })
}

export type DeletionPreview = {
  blockedBy: { id: string; name: string }[]
  deletesOrganizations: string[]
  // Pages in organizations with other people move to one of its owners; the rest are deleted
  pages: { deleted: number; transferred: number }
  transfers: { organization: string; to: string; pages: number }[]
}

export function getDeletionPreview() {
  return request<DeletionPreview>('/me/deletion')
}

export function deleteAccount(confirmEmail: string) {
  return request<null>('/me', { method: 'DELETE', json: { confirmEmail } })
}

// Page history, renaming, deleting and thumbnails

export type ArtifactVersion = {
  version: number
  createdAt: string
  publishedWith: string | null
  publishedBy: string | null
  restoredFrom: number | null
  current: boolean
}

async function pageRequest<T>(slug: string, path: string, fallback: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(slug)}${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? fallback)
  return data
}

export function listVersions(slug: string) {
  return pageRequest<ArtifactVersion[]>(slug, '/versions', 'The history could not be loaded.')
}

export function restoreVersion(slug: string, version: number) {
  return pageRequest<{ version: number; updatedAt: string }>(slug, `/versions/${version}/restore`, 'The version could not be restored. Try again.', {
    method: 'POST',
  })
}

export function renameArtifact(slug: string, title: string) {
  return pageRequest<{ title: string; updatedAt: string }>(slug, '', 'The page could not be renamed. Try again.', {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

export function deleteArtifact(slug: string) {
  return pageRequest<void>(slug, '', 'The page could not be deleted. Try again.', { method: 'DELETE' })
}

// A version as its own sandboxed document; its CSS, JS and images load by relative paths from here
export function versionUrl(slug: string, version: number) {
  return `/api/artifacts/${encodeURIComponent(slug)}/v/${version}/`
}

// The screenshot shown on gallery cards; versions never change, so the URL caches well
export function thumbnailUrl(slug: string, version: number) {
  return `/api/artifacts/${encodeURIComponent(slug)}/thumbnails/${version}`
}

// Magic link confirmation: opening the emailed link only looks it up; continuing uses it

export type SignInLink = {
  email: string
  expired: boolean
  newAccount: boolean
  // Using the link sets a password: it came from an admin, or the server can't send email
  setPassword: boolean
  emailEnabled: boolean
}

export function getSignInLink(token: string) {
  return request<SignInLink>(`/auth/email/confirm?token=${encodeURIComponent(token)}`)
}

export function confirmSignInLink(token: string, plan: string | null, next: string | null, password?: string) {
  return request<{ redirect: string }>('/auth/email/confirm', { method: 'POST', json: { token, plan, next, password } })
}

export function logInWithPassword(email: string, password: string, plan: string | null, next: string | null) {
  return request<{ redirect: string }>('/auth/password/login', { method: 'POST', json: { email, password, plan, next } })
}

// Servers without email whose sign-up policy lets people in
export function signUpWithPassword(email: string, password: string, name: string, plan: string | null, next: string | null) {
  return request<{ redirect: string }>('/auth/password/sign-up', { method: 'POST', json: { email, password, name, plan, next } })
}

// The first account on a server without email
export function setUpServer(email: string, password: string, name: string) {
  return request<{ redirect: string }>('/auth/password/setup', { method: 'POST', json: { email, password, name } })
}

export function changePassword(currentPassword: string, password: string) {
  return request<null>('/me/password', { method: 'PUT', json: { currentPassword, password } })
}

export function requestSignInLink(email: string, intent: 'login' | 'signup', plan: string | null, next: string | null) {
  return request<null>('/auth/email', { method: 'POST', json: { email, intent, plan, next } })
}

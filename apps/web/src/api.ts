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
  onboarded: boolean
  organizations: Organization[]
  agentConnected: boolean
  hasPublished: boolean
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
  html: string
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

export function getVersionHtml(slug: string, version: number) {
  return pageRequest<{ version: number; createdAt: string; html: string }>(slug, `/versions/${version}`, 'This version could not be loaded.')
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

// The page's current HTML as its own sandboxed document; the version busts the browser cache
export function contentUrl(slug: string, version: number) {
  return `/api/artifacts/${encodeURIComponent(slug)}/content?v=${version}`
}

import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'

export type Role = 'owner' | 'admin' | 'member'

export type Organization = {
  id: string
  name: string
  slug: string
  role: Role
  // Members need a passkey or an authenticator app to use it
  requireTwoFactor?: boolean
  // It requires one and you have none yet, so it stays closed to you in the app. Only in /api/me.
  blocked?: boolean
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
  // A passkey or an authenticator app, asked for after the password, email link or Google
  twoFactor: boolean
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
  // Can be moved to another workspace; missing from older servers
  canMove?: boolean
  // Whether a screenshot of the current version exists yet
  thumbnail: boolean
  // Whether one is still being rendered ('pending'), so the gallery should ask again.
  // Missing from servers older than this field; treat that like 'none'.
  thumbnailState?: ThumbnailState
  // Set on pages shared with you
  role?: 'viewer' | 'editor'
  // Set in a workspace's own list (not on pages shared with you): the folder it is filed in
  folder?: { id: string; name: string } | null
  // Missing from servers older than comments
  comments?: number
  // Written by others since you last opened the page's comments
  unreadComments?: number
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
  // Can be moved to another workspace; missing from older servers
  canMove?: boolean
  // 'personal' or the organization's id, sent only with canMove
  workspace?: string
  // null when signed out: only signed-in people see comments
  comments?: { total: number; unread: number } | null
  // How often it was opened; null for people who can't edit it, missing from older servers
  views?: number | null
}

export type ArtifactList = {
  items: ArtifactSummary[]
  // Pass back as cursor for the next pages; null on the last
  next: string | null
  // How many match in all; only sent with the first pages
  total: number | null
}

// folder: 'none' for pages in no folder, or a folder id; left out for every page
export type ListQuery = { query?: string; folder?: string; cursor?: string | null; limit?: number }

export async function listArtifacts(workspace: string, q: ListQuery = {}, signal?: AbortSignal): Promise<ArtifactList> {
  const params = new URLSearchParams({ workspace })
  if (q.query?.trim()) params.set('q', q.query.trim())
  if (q.folder) params.set('folder', q.folder)
  if (q.cursor) params.set('cursor', q.cursor)
  if (q.limit) params.set('limit', String(q.limit))
  const res = await fetch(`/api/artifacts?${params}`, { credentials: 'same-origin', signal })
  if (!res.ok) throw new Error(`Listing pages failed with ${res.status}`)
  const total = res.headers.get('X-Total-Count')
  return { items: await res.json(), next: res.headers.get('X-Next-Cursor'), total: total === null ? null : Number(total) }
}

export type FolderSummary = {
  id: string
  name: string
  // Pages in it that this person sees in the gallery
  pages: number
}

export function listFolders(workspace: string) {
  return request<FolderSummary[]>(`/folders?workspace=${encodeURIComponent(workspace)}`)
}

export async function createFolder(workspace: string, name: string): Promise<FolderSummary> {
  try {
    return await request<FolderSummary>('/folders', { method: 'POST', json: { workspace, name } })
  } catch (err) {
    throw err instanceof ApiError ? new FieldError(err.message, err.field) : err
  }
}

export async function renameFolder(id: string, name: string): Promise<{ id: string; name: string }> {
  try {
    return await request<{ id: string; name: string }>(`/folders/${encodeURIComponent(id)}`, { method: 'PATCH', json: { name } })
  } catch (err) {
    throw err instanceof ApiError ? new FieldError(err.message, err.field) : err
  }
}

export function deleteFolder(id: string) {
  return request<null>(`/folders/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// null takes the page out of its folder
export function moveToFolder(slug: string, folder: string | null) {
  return request<{ folder: { id: string; name: string } | null }>(`/artifacts/${encodeURIComponent(slug)}`, { method: 'PATCH', json: { folder } })
}

// Thrown by getArtifact for a page shared by a link with a password nobody has entered here yet
export class PasswordNeeded extends Error {}

// null when the page doesn't exist or this person can't open it. key: the ?k= of a public link; the
// server remembers it for the page's other requests.
export async function getArtifact(slug: string, key?: string | null): Promise<ArtifactPage | null> {
  const query = key ? `?k=${encodeURIComponent(key)}` : ''
  const res = await fetch(`/api/artifacts/${encodeURIComponent(slug)}${query}`, { credentials: 'same-origin' })
  if (res.status === 404) return null
  if (res.status === 401) throw new PasswordNeeded('Enter the password to open this page.')
  if (!res.ok) throw new Error(`Loading the page failed with ${res.status}`)
  return res.json()
}

// The page's current version number, or null when it is gone or closed to this person. Sends the
// version shown as an ETag, so an unchanged page costs a 304 with no body.
export async function currentVersion(slug: string, key: string | null, shown: number): Promise<number | null> {
  const query = key ? `?k=${encodeURIComponent(key)}` : ''
  const res = await fetch(`/api/artifacts/${encodeURIComponent(slug)}/current${query}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'If-None-Match': `"v${shown}"` },
  })
  if (res.status === 304) return shown
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Checking for a new version failed with ${res.status}`)
  const body = (await res.json()) as { version?: unknown }
  if (typeof body.version !== 'number') throw new Error('Checking for a new version gave no version')
  return body.version
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

// Remembered by this browser for a while, for this page only
export async function unlockPage(slug: string, password: string, key: string | null): Promise<void> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(slug)}/unlock`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, k: key ?? undefined }),
  })
  if (res.ok) return
  const data = await res.json().catch(() => ({}))
  if (res.status === 404) throw new FieldError('This page no longer asks for a password. Reload to open it.')
  throw new FieldError(data.error ?? 'The password could not be checked. Try again.', data.field)
}

// url and embedUrl are the public link and embed address, with the link's key once it was reset
export type LinkSettings = { expiresAt: string | null; password: boolean; expired: boolean; url: string; embedUrl: string }

// linkExpiresAt: an ISO date and time, or null for none. linkPassword: null removes it.
// rotateLink resets the public link.
export async function updateLink(
  slug: string,
  change: { linkExpiresAt?: string | null; linkPassword?: string | null; rotateLink?: boolean },
): Promise<{ link: LinkSettings }> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(change),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new FieldError(data.error ?? 'The link could not be changed. Try again.', data.field)
  return data
}

export const MAX_COMMENT_LENGTH = 5000

// Picked in the page's frame and checked by the server; the selector and snippet are shown as text
export type CommentAnchor = {
  version: number
  selector: string
  snippet: string
  path: string
  rect?: { x: number; y: number; w: number; h: number }
}

export type PageComment = {
  id: string
  // Plain text: always rendered as text, never as HTML
  body: string
  // The page's version when it was written
  version: number
  // null once the author's account is deleted
  author: string | null
  mine: boolean
  // The agent that posted it for its person; null when written in the app
  postedWith: string | null
  // The element of the page a thread is about; null for the whole page and for replies
  anchor: CommentAnchor | null
  createdAt: string
  editedAt: string | null
  canEdit: boolean
  canDelete: boolean
}

export type CommentThread = PageComment & {
  resolved: { at: string; by: string | null } | null
  canResolve: boolean
  replies: PageComment[]
}

export type CommentList = {
  threads: CommentThread[]
  next: string | null
  // When you last opened the comments, to mark newer ones
  seenAt: string | null
  currentVersion: number
}

const commentsPath = (slug: string) => `/artifacts/${encodeURIComponent(slug)}/comments`

export function listComments(slug: string, cursor?: string | null) {
  return request<CommentList>(`${commentsPath(slug)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
}

export async function addComment(slug: string, body: string, opts: { replyTo?: string; anchor?: CommentAnchor } = {}): Promise<PageComment> {
  try {
    return await request<PageComment>(commentsPath(slug), { method: 'POST', json: { body, replyTo: opts.replyTo, anchor: opts.anchor } })
  } catch (err) {
    throw err instanceof ApiError ? new FieldError(err.message, err.field) : err
  }
}

export async function editComment(slug: string, id: string, body: string): Promise<PageComment> {
  try {
    return await request<PageComment>(`${commentsPath(slug)}/${encodeURIComponent(id)}`, { method: 'PATCH', json: { body } })
  } catch (err) {
    throw err instanceof ApiError ? new FieldError(err.message, err.field) : err
  }
}

export function deleteComment(slug: string, id: string) {
  return request<null>(`${commentsPath(slug)}/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function resolveComment(slug: string, id: string, resolved: boolean) {
  return request<{ id: string; resolved: { at: string; by: string | null } | null }>(`${commentsPath(slug)}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: { resolved },
  })
}

export function markCommentsSeen(slug: string) {
  return request<null>(`${commentsPath(slug)}/seen`, { method: 'POST' })
}

export type ConsentRequest = {
  clientName: string
  redirectHost: string
  // blocked: requires two-factor sign-in you haven't set up
  workspaces: { id: string | null; name: string; blocked?: boolean }[]
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
  link: LinkSettings
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
  twoFactor?: boolean
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

export function setRequireTwoFactor(id: string, requireTwoFactor: boolean) {
  return request<OrganizationDetails>(orgPath(id), { method: 'PATCH', json: { requireTwoFactor } })
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

export type AccessToken = {
  id: string
  name: string
  // id null is the personal workspace
  workspace: { id: string | null; name: string }
  createdAt: string
  lastUsedAt: string | null
  // null for no expiry
  expiresAt: string | null
  expired: boolean
}

export type OrganizationAccessToken = AccessToken & { owner: { id: string; name: string | null; email: string } }

export const TOKEN_EXPIRY_DAYS = [7, 30, 90, 365] as const

export function listAccessTokens() {
  return request<AccessToken[]>('/me/access-tokens')
}

// The token itself is in this response only
export async function createAccessToken(input: { name: string; organizationId: string | null; expiresInDays: number | null }) {
  try {
    return await request<{ token: string; accessToken: AccessToken }>('/me/access-tokens', { method: 'POST', json: input })
  } catch (err) {
    throw err instanceof ApiError ? new FieldError(err.message, err.field) : err
  }
}

export function revokeAccessToken(id: string) {
  return request<null>(`/me/access-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function listOrganizationTokens(organizationId: string) {
  return request<OrganizationAccessToken[]>(`${orgPath(organizationId)}/access-tokens`)
}

export function revokeOrganizationToken(organizationId: string, id: string) {
  return request<null>(`${orgPath(organizationId)}/access-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
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

// A zip of an account's data, or of an organization's for its owners, built in the background
export type DataExport = {
  id: string
  status: 'building' | 'ready' | 'failed'
  allVersions: boolean
  createdAt: string
  finishedAt: string | null
  // The download link stops working then
  expiresAt: string | null
  size: number | null
  pagesDone: number
  pagesTotal: number
  error: string | null
  downloadUrl: string | null
}

// organizationId null for your own account
export async function getDataExport(organizationId: string | null) {
  const query = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : ''
  return (await request<{ export: DataExport | null }>(`/exports${query}`)).export
}

export async function startDataExport(organizationId: string | null, versions: 'all' | 'current') {
  return (await request<{ export: DataExport }>('/exports', { method: 'POST', json: { organizationId, versions } })).export
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

// What changed between two versions; see apps/api/src/compare.ts
export type ComparedFile = {
  path: string
  status: 'added' | 'removed' | 'changed'
  from: { size: number; contentType: string } | null
  to: { size: number; contentType: string } | null
  // A unified diff, as `diff -u` writes it; null when there is none
  diff: string | null
  additions: number | null
  deletions: number | null
  // Why there is no diff: not text, too big, too many changed lines, or the comparison is already as big as it may be
  omitted: 'binary' | 'large' | 'complex' | 'budget' | null
}

export type Comparison = { from: number; to: number; files: ComparedFile[]; unchanged: number }

export function compareVersions(slug: string, from: number, to: number) {
  return pageRequest<Comparison>(slug, `/compare?from=${from}&to=${to}`, 'The versions could not be compared.')
}

export type PageViews = {
  total: number
  versions: { version: number; views: number }[]
  // People who opened it as themselves in the last keptDays days, most recent first
  people: { name: string | null; email: string; visits: number; lastViewedAt: string; lastVersion: number }[]
  morePeople: boolean
  keptDays: number
}

export function getViews(slug: string) {
  return pageRequest<PageViews>(slug, '/views', 'The views could not be loaded.')
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

// workspace: 'personal' or an organization id. The copy starts Restricted.
export async function duplicateArtifact(slug: string, workspace: string, title?: string) {
  try {
    return await request<{ slug: string; title: string; workspace: string }>(`/artifacts/${encodeURIComponent(slug)}/duplicate`, {
      method: 'POST',
      json: { workspace, title },
    })
  } catch (err) {
    throw err instanceof ApiError ? new FieldError(err.message, err.field) : err
  }
}

export async function moveArtifact(slug: string, workspace: string) {
  try {
    return await request<{ slug: string; visibility: Visibility; workspace: string }>(`/artifacts/${encodeURIComponent(slug)}/move`, {
      method: 'POST',
      json: { workspace },
    })
  } catch (err) {
    throw err instanceof ApiError ? new FieldError(err.message, err.field) : err
  }
}

export function deleteArtifact(slug: string) {
  return pageRequest<void>(slug, '', 'The page could not be deleted. Try again.', { method: 'DELETE' })
}

// A version and its files as one zip; the current version when none is given
export function downloadUrl(slug: string, version?: number) {
  return `/api/artifacts/${encodeURIComponent(slug)}/download${version ? `?version=${version}` : ''}`
}

// Opaque origin: the page's scripts run, but can't read cookies or reach this app. The frame loads the
// version from its own URL (versionUrl), so a page's files resolve by relative paths.
export const FRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'

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

// Two-factor sign-in, passkeys and sessions

export type Passkey = { id: string; name: string; backedUp: boolean; createdAt: string; lastUsedAt: string | null }

export type SignInSecurity = {
  passkeys: Passkey[]
  totp: boolean
  // How many unused recovery codes are left
  recoveryCodes: number
  requiredBy: { id: string; name: string }[]
  // false: changes need signing in again first
  recentSignIn: boolean
}

export function getSignInSecurity() {
  return request<SignInSecurity>('/me/security')
}

// The options go to @simplewebauthn/browser as they are
export function passkeyRegistrationOptions() {
  return request<PublicKeyCredentialCreationOptionsJSON>('/me/security/passkeys/options', { method: 'POST' })
}

export function addPasskey(name: string, response: unknown) {
  return request<{ passkey: Passkey; recoveryCodes?: string[] }>('/me/security/passkeys', { method: 'POST', json: { name, response } })
}

export function renamePasskey(id: string, name: string) {
  return request<Passkey>(`/me/security/passkeys/${encodeURIComponent(id)}`, { method: 'PATCH', json: { name } })
}

export function removePasskey(id: string) {
  return request<null>(`/me/security/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export type TotpSetup = { secret: string; uri: string; qr: string }

export function startTotpSetup() {
  return request<TotpSetup>('/me/security/totp', { method: 'POST' })
}

export function confirmTotp(code: string) {
  return request<{ recoveryCodes?: string[] }>('/me/security/totp/confirm', { method: 'POST', json: { code } })
}

export function removeTotp() {
  return request<null>('/me/security/totp', { method: 'DELETE' })
}

export function newRecoveryCodes() {
  return request<{ recoveryCodes: string[] }>('/me/security/recovery-codes', { method: 'POST' })
}

export type SignedInSession = {
  id: string
  browser: string | null
  os: string | null
  createdAt: string
  lastActiveAt: string
  current: boolean
}

export function listSessions() {
  return request<SignedInSession[]>('/me/sessions')
}

export function endSession(id: string) {
  return request<null>(`/me/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function signOutOtherSessions() {
  return request<null>('/me/sessions', { method: 'DELETE' })
}

// The second step of signing in, while a pending sign-in cookie is set
export type SecondFactorMethods = { email: string; passkey: boolean; totp: boolean; recoveryCodes: boolean }

export function getSecondFactorMethods() {
  return request<SecondFactorMethods>('/auth/two-factor')
}

export function sendSecondFactorCode(code: string) {
  return request<{ redirect: string }>('/auth/two-factor/code', { method: 'POST', json: { code } })
}

export function secondFactorPasskeyOptions() {
  return request<PublicKeyCredentialRequestOptionsJSON>('/auth/two-factor/passkey/options', {
    method: 'POST',
  })
}

export function sendSecondFactorPasskey(response: unknown) {
  return request<{ redirect: string }>('/auth/two-factor/passkey', { method: 'POST', json: { response } })
}

export function passkeySignInOptions() {
  return request<PublicKeyCredentialRequestOptionsJSON>('/auth/passkey/options', { method: 'POST' })
}

export function signInWithPasskey(response: unknown, plan: string | null, next: string | null) {
  return request<{ redirect: string }>('/auth/passkey', { method: 'POST', json: { response, plan, next } })
}

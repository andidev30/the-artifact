import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  googleSub: text('google_sub').unique(),
  // scrypt hash (see src/auth/password.ts); only set on installs without email, or once someone chooses one
  passwordHash: text('password_hash'),
  // Signed up on their own with a password on a server without email, so nobody checked the address.
  // Cleared by a sign-in that proves it (email link, Google, single sign-on).
  emailUnverified: boolean('email_unverified').notNull().default(false),
  // Set once the person finishes choosing a personal or organization workspace
  onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
  // Instance administrator (see src/instance.ts)
  isAdmin: boolean('is_admin').notNull().default(false),
  // Suspended people can't sign in or use their agents; their pages stay
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  // Updated at most every few minutes while they use the web app
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// The session cookie holds a random token; only its SHA-256 hash is stored
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // The browser's User-Agent at sign-in, for the list of sessions in settings
    userAgent: text('user_agent'),
    // Updated at most every few minutes while the session is used
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
)

// Someone who passed the first factor (password, email link or Google) of an account with a second
// factor. The cookie holds a random token; only its hash is stored. The session starts once the
// second factor is checked.
export const pendingSignIns = pgTable(
  'pending_sign_ins',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Where to go once signed in
    redirect: text('redirect').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pending_sign_ins_user_idx').on(t.userId), index('pending_sign_ins_expires_at_idx').on(t.expiresAt)],
)

// Passkeys (WebAuthn credentials). They sign in on their own, or serve as the second factor.
export const passkeys = pgTable(
  'passkeys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // base64url, as the browser reports it
    credentialId: text('credential_id').notNull().unique(),
    // COSE public key, base64url
    publicKey: text('public_key').notNull(),
    // The authenticator's signature counter; many passkeys always report 0
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: jsonb('transports').$type<string[]>().notNull().default([]),
    name: text('name').notNull(),
    // Synced to a cloud account (iCloud Keychain, Google Password Manager...) rather than one device
    backedUp: boolean('backed_up').notNull().default(false),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('passkeys_user_idx').on(t.userId)],
)

// A WebAuthn challenge the server handed out, keyed by its SHA-256 and deleted as it is used, so
// every one works once. user_id is null for signing in with a passkey before anyone is known.
export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    id: text('id').primaryKey(),
    // "register", "sign-in" or "second-factor"
    purpose: text('purpose').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webauthn_challenges_expires_at_idx').on(t.expiresAt)],
)

// An authenticator app (TOTP, RFC 6238). The secret is encrypted with a server key (src/auth/totp.ts).
// It counts as a second factor once confirmed with a first code.
export const totpSecrets = pgTable('totp_secrets', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  // The last 30-second step a code was accepted for; codes from it or earlier don't work again
  lastStep: bigint('last_step', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Single-use codes for when the second factor is lost. Stored as SHA-256; deleted as they are used.
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('recovery_codes_user_code_unique').on(t.userId, t.codeHash)],
)

// One-time sign-in links sent by email, or made by an instance admin to pass on when the server
// can't send email; stored hashed like sessions
export const emailTokens = pgTable('email_tokens', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  // The admin who made the link; such links create an account whatever the sign-up policy says
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  // Members need a passkey or an authenticator app to use the organization (see src/auth/twofactor.ts)
  requireTwoFactor: boolean('require_two_factor').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const roleEnum = pgEnum('role', ['owner', 'admin', 'member'])

export const memberships = pgTable(
  'memberships',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.organizationId] }), index('memberships_org_idx').on(t.organizationId)],
)

export const inviteRoleEnum = pgEnum('invite_role', ['admin', 'member'])

// Invitations to join an organization by email. The link carries a random token; only its hash is stored.
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: inviteRoleEnum('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('invitations_org_email_unique').on(t.organizationId, t.email), index('invitations_email_idx').on(t.email)],
)

// OAuth for MCP clients (Claude Code, Cursor, Codex...). Clients register themselves.
export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// An authorization in progress: created at /oauth/authorize, approved on the consent page,
// then exchanged once for tokens. `code` is the hash of the authorization code once approved.
export const oauthGrants = pgTable('oauth_grants', {
  id: text('id').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  state: text('state'),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
  code: text('code').unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const tokenKindEnum = pgEnum('token_kind', ['access', 'refresh'])

// Tokens are stored hashed. organization_id null means the personal workspace.
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: text('id').primaryKey(),
    kind: tokenKindEnum('kind').notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    // Set when a refresh token is exchanged. The row is kept until it expires, so presenting it
    // again is recognized as reuse and ends the whole connection.
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('oauth_tokens_user_idx').on(t.userId)],
)

// Long-lived tokens people create in settings to publish from CI and scripts, for one workspace
// (organization_id null means the personal workspace). Only the SHA-256 of the token is stored.
export const accessTokens = pgTable(
  'access_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    // Null for a token that never expires
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // Updated at most once a minute while the token is used
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('access_tokens_user_idx').on(t.userId), index('access_tokens_org_idx').on(t.organizationId)],
)

export const visibilityEnum = pgEnum('visibility', ['private', 'organization', 'link'])

// Folders group pages inside one workspace: an organization's (organization_id set) or a person's
// personal workspace (owner_id set). They never change who can open a page. One level, no nesting.
export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('folders_one_workspace', sql`(${t.organizationId} is null) <> (${t.ownerId} is null)`),
    uniqueIndex('folders_org_name_unique').on(t.organizationId, sql`lower(${t.name})`).where(sql`${t.organizationId} is not null`),
    uniqueIndex('folders_owner_name_unique').on(t.ownerId, sql`lower(${t.name})`).where(sql`${t.organizationId} is null`),
  ],
)

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Short public id used in /a/<slug>
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    visibility: visibilityEnum('visibility').notNull().default('private'),
    currentVersion: integer('current_version').notNull().default(1),
    // Name of the MCP client that published it, e.g. "claude-code"
    publishedWith: text('published_with'),
    // Always a folder of the page's own workspace; null for no folder
    folderId: uuid('folder_id').references((): AnyPgColumn => folders.id, { onDelete: 'set null' }),
    // Link sharing only: after this, the link opens nothing for people without other access
    linkExpiresAt: timestamp('link_expires_at', { withTimezone: true }),
    // Link sharing only: scrypt hash (see src/auth/password.ts) of the password visitors enter
    linkPasswordHash: text('link_password_hash'),
    // Link sharing only: the key a public link carries (/a/<slug>?k=<key>), set when the link is first
    // reset. Until then the plain page address is the public link, as it was for links shared before keys.
    linkToken: text('link_token'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // The gallery pages through a workspace newest first by (updated_at, id); these keep that an index scan
  (t) => [
    index('artifacts_owner_idx').on(t.ownerId, t.updatedAt, t.id),
    index('artifacts_org_idx').on(t.organizationId, t.updatedAt, t.id),
    index('artifacts_folder_idx').on(t.folderId, t.updatedAt, t.id),
    // Title search with ILIKE; needs pg_trgm, see drizzle/0012_gallery_folders.sql
    index('artifacts_title_trgm_idx').using('gin', t.title.op('gin_trgm_ops')),
  ],
)

export const artifactVersions = pgTable(
  'artifact_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    // The entry HTML lives in object storage under its hash (see src/storage.ts)
    htmlSha256: text('html_sha256').notNull(),
    htmlSize: integer('html_size').notNull(),
    // MCP client that published this version; null for versions made in the web app
    publishedWith: text('published_with'),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
    // The older version this one copies, when someone restored it
    restoredFrom: integer('restored_from'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('artifact_versions_unique').on(t.artifactId, t.version)],
)

// The other files of a multi-file version (CSS, JS, images, fonts...), served next to the entry
// HTML. Their content is in object storage under its hash; versions never change, so neither do their files.
export const artifactFiles = pgTable(
  'artifact_files',
  {
    versionId: uuid('version_id')
      .notNull()
      .references(() => artifactVersions.id, { onDelete: 'cascade' }),
    // Relative to the entry, e.g. "css/site.css"
    path: text('path').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    // Hex SHA-256 of the content: its key in object storage, and the ETag
    sha256: text('sha256').notNull(),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.path] })],
)

// Labels on a page, lowercase, up to 10 per page (src/tags.ts). They belong to the page's workspace
// and are seen by everyone who can open the page.
export const artifactTags = pgTable(
  'artifact_tags',
  {
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.tag] }), index('artifact_tags_tag_idx').on(t.tag, t.artifactId)],
)

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

// The words of a page's current version, for search (src/search.ts). One row per page, replaced when
// another version becomes current; version_id says which one it was built from, so pages whose row is
// missing or older can be found and indexed again. Only the words are kept, not the text.
export const artifactSearch = pgTable(
  'artifact_search',
  {
    artifactId: uuid('artifact_id')
      .primaryKey()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => artifactVersions.id, { onDelete: 'cascade' }),
    words: tsvector('words').notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('artifact_search_words_idx').using('gin', t.words)],
)

// A screenshot of a version for gallery cards, rendered in a headless browser after publishing.
// A row without an image records a render that failed, so it isn't retried on every gallery load.
export const artifactThumbnails = pgTable('artifact_thumbnails', {
  versionId: uuid('version_id')
    .primaryKey()
    .references(() => artifactVersions.id, { onDelete: 'cascade' }),
  // The image's key in object storage; null when the render failed
  sha256: text('sha256'),
  contentType: text('content_type'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Random keys the server creates for itself on first use, e.g. to sign page content links
export const serverSecrets = pgTable('server_secrets', {
  name: text('name').primaryKey(),
  value: text('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const shareRoleEnum = pgEnum('share_role', ['viewer', 'editor'])

// People a page is shared with, by email, so it works before they have an account
export const artifactShares = pgTable(
  'artifact_shares',
  {
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: shareRoleEnum('role').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    // The share's own link (src/sharing.ts), for the sharer to pass on when nobody was emailed. Replaced on
    // every share with the address, cleared once used.
    tokenHash: text('token_hash').unique(),
    // The account that opened that link while signed in with the address. A share counts for an account
    // whose address was checked, or for this one: an unverified account may have typed someone else's address.
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.email] }), index('artifact_shares_email_idx').on(t.email)],
)

// Where on a page a comment points: a CSS selector and the element's text when it was picked, in
// one HTML file of one version. rect is its box as fractions of the page's width and height.
export type CommentAnchor = {
  version: number
  selector: string
  snippet: string
  path: string
  rect?: { x: number; y: number; w: number; h: number }
}

// Comments on a page, from anyone signed in who can open it. One level of threads: a comment with no
// parent starts a thread and replies point at it, never at another reply. Deleting a thread's first
// comment deletes its replies.
export const artifactComments = pgTable(
  'artifact_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => artifactComments.id, { onDelete: 'cascade' }),
    // Null once the author's account is deleted; the comment stays for the others in the thread
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    // Plain text, never rendered as HTML
    body: text('body').notNull(),
    // The page's current version when it was written
    version: integer('version').notNull(),
    // MCP client that posted it for its person; null for comments written in the web app
    postedWith: text('posted_with'),
    // The element of the page a thread's first comment is about; null for comments on the whole page.
    // Picked inside the page's sandboxed frame, so every field was checked as untrusted (checkAnchor).
    anchor: jsonb('anchor').$type<CommentAnchor>(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    // Only set on the first comment of a thread
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('artifact_comments_artifact_idx').on(t.artifactId, t.createdAt, t.id), index('artifact_comments_parent_idx').on(t.parentId)],
)

// When someone last opened a page's comments, for the count of new ones on cards and in the viewer
export const commentReads = pgTable(
  'comment_reads',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.artifactId] })],
)

// How often each version was opened, anonymous visits included (see src/views.ts). Kept as long as the version.
export const artifactViewCounts = pgTable('artifact_view_counts', {
  versionId: uuid('version_id')
    .primaryKey()
    .references(() => artifactVersions.id, { onDelete: 'cascade' }),
  views: integer('views').notNull().default(0),
})

// Who opened a page and when, for pages opened with an identity (not through a shared link).
// Deleted after VIEWER_RETENTION_DAYS by the daily jobs; the counts above stay.
export const artifactViews = pgTable(
  'artifact_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    viewedAt: timestamp('viewed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('artifact_views_artifact_user_idx').on(t.artifactId, t.userId, t.viewedAt), index('artifact_views_viewed_at_idx').on(t.viewedAt)],
)

export const signupPolicyEnum = pgEnum('signup_policy', ['open', 'domains', 'invite-only'])

// Settings the instance admin edits in the web app. At most one row (id 1); without it anyone
// can sign up.
export const instanceSettings = pgTable('instance_settings', {
  id: integer('id').primaryKey().default(1),
  signupPolicy: signupPolicyEnum('signup_policy').notNull(),
  allowedDomains: jsonb('allowed_domains').$type<string[]>().notNull().default([]),
  instanceName: text('instance_name'),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // The license key an admin pasted on a self-hosted install (see src/license.ts). It is checked
  // against the public keys in the code every time it is read, so editing it here unlocks nothing.
  licenseKey: text('license_key'),
  licenseUpdatedBy: uuid('license_updated_by').references(() => users.id, { onDelete: 'set null' }),
  licenseUpdatedAt: timestamp('license_updated_at', { withTimezone: true }),
  // Accounts with a checked address at one of these domains join this organization as members, once
  // each (src/auto-join.ts). Only instance admins set it, because nothing proves who owns a domain.
  autoJoinOrganizationId: uuid('auto_join_organization_id').references(() => organizations.id, { onDelete: 'set null' }),
  autoJoinDomains: jsonb('auto_join_domains').$type<string[]>().notNull().default([]),
  autoJoinUpdatedAt: timestamp('auto_join_updated_at', { withTimezone: true }),
})

// Every organization an account joined by its email domain, or was already in when its domain matched.
// Kept after they leave or are removed, so the next sign-in doesn't add them back.
export const autoJoins = pgTable(
  'auto_joins',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    // When they dismissed the notice that they joined; set at once when they were a member already
    noticeSeenAt: timestamp('notice_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.organizationId] }), index('auto_joins_org_idx').on(t.organizationId)],
)

// License keys an instance admin of the hosted service issued (src/ee/licenses.ts), so they can see
// what went to whom. The key itself isn't kept: it is shown once, and the signing key lives only in
// LICENSE_SIGNING_KEY.
export const issuedLicenses = pgTable(
  'issued_licenses',
  {
    // The id inside the key
    id: uuid('id').primaryKey().defaultRandom(),
    // Which signing key signed it, as in LICENSE_PUBLIC_KEYS
    signingKeyId: text('signing_key_id').notNull(),
    customerName: text('customer_name').notNull(),
    customerEmail: text('customer_email').notNull(),
    seats: integer('seats').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuedBy: uuid('issued_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('issued_licenses_issued_at_idx').on(t.issuedAt)],
)

// How long an organization keeps older versions of its pages, an enterprise feature (src/ee/retention.ts).
// Null means no limit of that kind; the row is kept when the license lapses, but it is only applied
// while the install has an Enterprise license.
export const retentionPolicies = pgTable(
  'retention_policies',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    keepDays: integer('keep_days'),
    // Versions per page, the current one included
    keepVersions: integer('keep_versions'),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('retention_policies_keep_days', sql`${t.keepDays} is null or ${t.keepDays} > 0`),
    check('retention_policies_keep_versions', sql`${t.keepVersions} is null or ${t.keepVersions} > 0`),
  ],
)

// What happened in an organization, for its audit log (src/audit.ts, src/ee/audit.ts). Recorded only
// while the install has an Enterprise license; kept for AUDIT_LOG_RETENTION_DAYS. Emails and labels
// are copied in, so an event still says who and what after the account or page is gone.
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // e.g. "sign_in.succeeded", "page.visibility_changed" (AUDIT_ACTIONS in src/audit.ts)
    action: text('action').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorEmail: text('actor_email'),
    // "page", "member", "invitation", "access_token" or "organization"
    targetType: text('target_type'),
    targetId: text('target_id'),
    targetLabel: text('target_label'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // The log pages through one organization newest first by (created_at, id); retention deletes by created_at
  (t) => [index('audit_events_org_idx').on(t.organizationId, t.createdAt, t.id), index('audit_events_created_at_idx').on(t.createdAt)],
)

export const ssoProtocolEnum = pgEnum('sso_protocol', ['oidc', 'saml'])

// Single sign-on through an identity provider the instance admin sets up (src/ee/sso/), an
// Enterprise feature. Each row is one sign-in button; the protocol decides the shape of `config`
// (SsoConfig in src/ee/sso/connections.ts). Secrets such as an OIDC client secret go in `secret`,
// sealed with a server secret, never in `config`.
export const ssoConnections = pgTable('sso_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  protocol: ssoProtocolEnum('protocol').notNull(),
  // Shown on the button: "Continue with <name>"
  name: text('name').notNull(),
  // Off until the admin turns it on, so it can be tested first
  enabled: boolean('enabled').notNull().default(false),
  // Protocol-specific settings that aren't secret, e.g. the OIDC issuer and client id
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  secret: text('secret'),
  // Email domains the provider may sign people in for; empty accepts any
  allowedDomains: jsonb('allowed_domains').$type<string[]>().notNull().default([]),
  // People at those domains (everyone, when there are none) must sign in through this connection;
  // instance admins never are, so they can't be locked out
  required: boolean('required').notNull().default(false),
  // The organization people join as members the first time they sign in through the connection
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Which account a person at an identity provider signs in to: the provider's stable id for them
// (the OIDC `sub`, a SAML NameID), so a later change of address at the provider keeps the account
export const ssoIdentities = pgTable(
  'sso_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => ssoConnections.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    // The address the provider gave at the last sign-in
    email: text('email').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sso_identities_subject_unique').on(t.connectionId, t.subject), index('sso_identities_user_idx').on(t.userId)],
)

// IDs of SAML AuthnRequests this server sent (src/ee/sso/saml.ts), so a response must answer one of
// them (InResponseTo) and is checked against the connection that sent it
export const samlRequests = pgTable(
  'saml_requests',
  {
    id: text('id').primaryKey(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => ssoConnections.id, { onDelete: 'cascade' }),
    // The request's IssueInstant, which node-saml compares against
    issuedAt: text('issued_at').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('saml_requests_expires_at_idx').on(t.expiresAt)],
)

// SAML assertions already used to sign in, kept until they would be too old to accept anyway, so
// none signs anyone in twice. id is the SHA-256 of the connection and the assertion's ID.
export const samlAssertions = pgTable(
  'saml_assertions',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('saml_assertions_expires_at_idx').on(t.expiresAt)],
)

// Bearer tokens an IdP provisions accounts with over SCIM (src/ee/scim.ts); only the SHA-256 is
// stored. New accounts join organization_id, when set.
export const scimTokens = pgTable('scim_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  // Updated at most once a minute while the token is used
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// What an IdP calls an account it provisioned over SCIM: its userName and name parts as sent, and its
// own id for the person, so they read back the way the IdP wrote them
export const scimUsers = pgTable(
  'scim_users',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    userName: text('user_name').notNull(),
    externalId: text('external_id'),
    givenName: text('given_name'),
    familyName: text('family_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('scim_users_user_name_unique').on(sql`lower(${t.userName})`)],
)

// The hosted service's sign-up funnel (src/ee/analytics.ts): when each account first reached a step,
// once per account and step. Only the account, the step, a small enum and the time: never page
// content, titles, email addresses or IP addresses. Rows go with the account and after 13 months.
export const productEvents = pgTable(
  'product_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // PRODUCT_EVENTS in src/analytics.ts, e.g. "signed_up"
    event: text('event').notNull(),
    // How, from a fixed list per event (a sign-up method, a kind of share), or null
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('product_events_user_event_unique').on(t.userId, t.event), index('product_events_event_created_at_idx').on(t.event, t.createdAt)],
)

// How often something happened each day on the hosted service (publishes), counted without saying who
export const productDailyCounts = pgTable(
  'product_daily_counts',
  {
    day: date('day', { mode: 'string' }).notNull(),
    event: text('event').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.event] })],
)

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

export const exportStatusEnum = pgEnum('export_status', ['building', 'ready', 'failed'])

// A zip of someone's data, built in steps (src/exports.ts) and kept in storage under exports/<id>/
// until expires_at. organization_id null is an export of the account itself; otherwise an owner's
// export of that organization.
export const dataExports = pgTable(
  'data_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    // Every version of every page, or only the current one
    allVersions: boolean('all_versions').notNull(),
    status: exportStatusEnum('status').notNull().default('building'),
    // Where the build is: the page it is on, the multipart upload and the parts written so far
    progress: jsonb('progress').$type<Record<string, unknown>>().notNull(),
    // The zip's central directory so far, written after the last file
    directory: bytea('directory').notNull().default(sql`''::bytea`),
    // A process builds it until then, so two never write the same export at once
    leaseId: text('lease_id'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    size: bigint('size', { mode: 'number' }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    // Set once it is ready; the file is deleted after this
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    index('data_exports_user_idx').on(t.userId, t.createdAt),
    index('data_exports_org_idx').on(t.organizationId),
    index('data_exports_status_idx').on(t.status),
  ],
)

// Counters for rate limits (see src/limits.ts): how often something happened for one key in the
// current window, which starts at the first hit and ends at resets_at. Kept in Postgres so every
// server process, or serverless instance, counts the same thing.
export const rateLimits = pgTable(
  'rate_limits',
  {
    // Which limit, e.g. "sign-in-link"
    bucket: text('bucket').notNull(),
    // SHA-256 of what is counted (an email address, an account id or an IP address), so no addresses are stored
    key: text('key').notNull(),
    hits: integer('hits').notNull(),
    resetsAt: timestamp('resets_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.key] }), index('rate_limits_resets_at_idx').on(t.resetsAt)],
)

// The newest release on GitHub, for the notice in the admin area of a self-hosted install (see
// src/releases.ts). At most one row (id 1), shared by every server process so that between them
// they ask GitHub at most once a day.
export const releaseCheck = pgTable('release_check', {
  id: integer('id').primaryKey().default(1),
  // When a process last claimed the check, whether or not GitHub answered
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
  // Null until GitHub answers with a release
  latestVersion: text('latest_version'),
  releaseUrl: text('release_url'),
})

// Where a workspace sends events (src/webhooks.ts): an organization's (organization_id set, managed
// by its owners and admins) or a person's personal workspace (user_id set). The signing secret is
// sealed with a server secret, like an SSO client secret, and shown only when it is created.
export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    // "json", "slack" or "discord": the shape of the body
    format: text('format').notNull(),
    // WEBHOOK_EVENTS in src/webhooks.ts
    events: jsonb('events').$type<string[]>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    secret: text('secret').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('webhooks_one_workspace', sql`(${t.organizationId} is null) <> (${t.userId} is null)`),
    index('webhooks_org_idx').on(t.organizationId),
    index('webhooks_user_idx').on(t.userId),
  ],
)

// One event for one webhook: queued here so any process can add it and one sends it, and retries
// survive a restart. Also the delivery log people see; rows are deleted after 14 days.
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    // The JSON payload; Slack and Discord bodies are made from it when sending
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    // "pending", "delivered" or "failed" (no attempts left)
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    // When a pending delivery is next due; while an attempt is running, when it may be taken over
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    // The HTTP status of the last answer, and why the last attempt failed
    responseStatus: integer('response_status'),
    lastError: text('last_error'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('webhook_deliveries_due_idx').on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    index('webhook_deliveries_webhook_idx').on(t.webhookId, t.createdAt),
    index('webhook_deliveries_created_at_idx').on(t.createdAt),
  ],
)

export type User = typeof users.$inferSelect
export type Passkey = typeof passkeys.$inferSelect
export type SignupPolicy = (typeof signupPolicyEnum.enumValues)[number]
export type ShareRole = (typeof shareRoleEnum.enumValues)[number]
export type Artifact = typeof artifacts.$inferSelect
export type Folder = typeof folders.$inferSelect
export type Comment = typeof artifactComments.$inferSelect
export type Visibility = (typeof visibilityEnum.enumValues)[number]
export type Role = (typeof roleEnum.enumValues)[number]
export type InviteRole = (typeof inviteRoleEnum.enumValues)[number]
export type SsoConnection = typeof ssoConnections.$inferSelect
export type DataExport = typeof dataExports.$inferSelect
export type Webhook = typeof webhooks.$inferSelect
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect

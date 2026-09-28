import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  googleSub: text('google_sub').unique(),
  // scrypt hash (see src/auth/password.ts); only set on installs without email, or once someone chooses one
  passwordHash: text('password_hash'),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('oauth_tokens_user_idx').on(t.userId)],
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.email] }), index('artifact_shares_email_idx').on(t.email)],
)

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
})

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

export type User = typeof users.$inferSelect
export type SignupPolicy = (typeof signupPolicyEnum.enumValues)[number]
export type ShareRole = (typeof shareRoleEnum.enumValues)[number]
export type Artifact = typeof artifacts.$inferSelect
export type Folder = typeof folders.$inferSelect
export type Comment = typeof artifactComments.$inferSelect
export type Visibility = (typeof visibilityEnum.enumValues)[number]
export type Role = (typeof roleEnum.enumValues)[number]
export type InviteRole = (typeof inviteRoleEnum.enumValues)[number]

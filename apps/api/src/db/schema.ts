import { index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  googleSub: text('google_sub').unique(),
  // Set once the person finishes choosing a personal or organization workspace
  onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
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

// One-time sign-in links sent by email; stored hashed like sessions
export const emailTokens = pgTable('email_tokens', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('artifacts_owner_idx').on(t.ownerId), index('artifacts_org_idx').on(t.organizationId)],
)

export const artifactVersions = pgTable(
  'artifact_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    html: text('html').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('artifact_versions_unique').on(t.artifactId, t.version)],
)

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

export type User = typeof users.$inferSelect
export type ShareRole = (typeof shareRoleEnum.enumValues)[number]
export type Artifact = typeof artifacts.$inferSelect
export type Visibility = (typeof visibilityEnum.enumValues)[number]
export type Role = (typeof roleEnum.enumValues)[number]

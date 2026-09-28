import cluster from 'node:cluster'
import { databasePoolMax } from './workers.js'

try {
  process.loadEnvFile()
} catch {
  // No .env file; rely on the real environment (e.g. Cloud Run)
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable ${name}. See apps/api/.env.example.`)
  return value
}

// A whole number of at least 1, or null when unset
function count(name: string): number | null {
  const value = process.env[name]?.trim()
  if (!value) return null
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a whole number of at least 1, e.g. ${name}=500.`)
  return n
}

// Thumbnails rendered at once: 2 unless set, from 1 to 8. Each is a page in one shared Chromium, so
// more costs memory and CPU the requests could use; see docs/configuration.md
export function thumbnailConcurrency(raw: string | undefined): number {
  const value = raw?.trim()
  if (!value) return 2
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1 || n > 8) throw new Error('THUMBNAIL_CONCURRENCY must be a whole number from 1 to 8, e.g. THUMBNAIL_CONCURRENCY=2.')
  return n
}

const SIZE_UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }

// Bytes from a size like 500MB, 10GB or 1TB (powers of 1024), or null when unset
export function parseSize(value: string | undefined, name: string): number | null {
  const s = value?.trim()
  if (!s) return null
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i.exec(s)
  const bytes = m ? Math.floor(Number(m[1]) * SIZE_UNITS[(m[2] ?? 'B').toUpperCase()]) : 0
  if (bytes < 1) throw new Error(`${name} must be a size like 500MB, 10GB or 1TB.`)
  return bytes
}

// How many proxies in front of the app append the client's address to X-Forwarded-For. 0 trusts no
// header, since anyone can send one, and uses the address of the connection. Vercel sets the header
// itself (it replaces what the client sent), so there it is trusted.
function trustProxy(): number {
  const value = process.env.TRUST_PROXY?.trim().toLowerCase()
  if (!value) return process.env.VERCEL ? 1 : 0
  if (value === 'true') return 1
  if (value === 'false') return 0
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('TRUST_PROXY must be true, false or the number of proxies in front of the app, e.g. TRUST_PROXY=1.')
  return n
}

// Who may frame embeds (/e/<slug>) and page content, as a CSP frame-ancestors source list, or null
// for anyone (unset or "*", the default). "none" is this app only; otherwise origins such as
// "https://www.notion.so https://*.atlassian.net". Checked strictly, since it goes into a header.
export function embedFrameAncestors(value: string | undefined): string | null {
  const v = value?.trim()
  if (!v || v === '*') return null
  if (v.toLowerCase() === 'none') return "'self'"
  const origins = v.split(/[\s,]+/).filter(Boolean)
  const bad = origins.find((o) => !/^https?:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i.test(o))
  if (bad) throw new Error(`EMBED_FRAME_ANCESTORS must be *, none, or origins like https://www.notion.so separated by spaces or commas; got "${bad}".`)
  return ["'self'", ...origins].join(' ')
}

// The origin that serves page files and nothing else, or null to serve them from APP_URL (src/content.ts).
// It has to be another host: cookies ignore the port, so another port of the app's host would get its cookies.
export function contentOrigin(value: string | undefined, appUrl: string): string | null {
  const v = value?.trim().replace(/\/$/, '')
  if (!v) return null
  let url: URL | null = null
  try {
    url = new URL(v)
  } catch {}
  // Checked strictly, since it goes into CSP headers
  const origin = url?.origin ?? ''
  if (!url || !/^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/.test(origin) || url.pathname !== '/' || url.username || url.password || /[?#]/.test(v))
    throw new Error(`CONTENT_ORIGIN must be an origin like https://content.example.com, with no path; got "${v}".`)
  if (url.hostname === new URL(appUrl).hostname) throw new Error('CONTENT_ORIGIN must be on another host than APP_URL, e.g. https://content.example.com.')
  return url.origin
}

// A key that encrypts the rows of server_secrets (src/secrets.ts): 32 random bytes in base64, as
// openssl rand -base64 32 prints them, or in hex. Null when unset.
export function encryptionKey(value: string | undefined, name: string): Buffer | null {
  const v = value?.trim()
  if (!v) return null
  // Checked by shape first: Buffer.from skips characters it doesn't know, so a typo would pass as another key
  const key = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : /^[A-Za-z0-9+/_-]{43}=?$/.test(v) ? Buffer.from(v, 'base64') : null
  if (key?.length !== 32) throw new Error(`${name} must be 32 random bytes in base64 or hex, e.g. the output of openssl rand -base64 32.`)
  return key
}

export function encryptionKeys(current: string | undefined, previous: string | undefined) {
  const key = encryptionKey(current, 'ENCRYPTION_KEY')
  const previousKey = encryptionKey(previous, 'ENCRYPTION_KEY_PREVIOUS')
  if (previousKey && !key) throw new Error('ENCRYPTION_KEY_PREVIOUS is only for changing keys: set the new key as ENCRYPTION_KEY too.')
  return { key, previousKey }
}

// A setup code as it is compared: case, spaces and dashes don't matter, so XXXX-XXXX-XXXX can be typed any way
export function normalizeSetupCode(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : ''
}

// SETUP_CODE: the code the first account on a self-hosted install is created with, instead of one the
// server makes and prints as it starts (src/setup-code.ts). For installs set up by a script.
export function setupCodeSetting(value: string | undefined): string | null {
  if (!value?.trim()) return null
  const code = normalizeSetupCode(value)
  if (code.length < 12) throw new Error('SETUP_CODE must have at least 12 letters or digits, e.g. SETUP_CODE=$(openssl rand -hex 12).')
  return code
}

const appUrl = required('APP_URL').replace(/\/$/, '')

export const env = {
  port: Number(process.env.PORT ?? 3000),
  appUrl,
  contentOrigin: contentOrigin(process.env.CONTENT_ORIGIN, appUrl),
  databaseUrl: required('DATABASE_URL'),
  // Transaction-mode poolers (PgBouncer, Supabase on port 6543) hand each query to any server
  // connection, so prepared statements made on one aren't there on the next
  databasePrepare: process.env.DATABASE_PREPARE !== 'false',
  // Connections each process may open. A cluster's primary gives its workers WEB_CONCURRENCY (src/primary.ts).
  databasePoolMax: databasePoolMax(process.env.DATABASE_POOL_MAX, cluster.isWorker ? Number(process.env.WEB_CONCURRENCY) : 1),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  },
  // Optional: without SMTP_HOST nothing is emailed. People sign in with a password (or Google)
  // and admins pass sign-up and invitation links on themselves.
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM || 'The Artifact <no-reply@localhost>',
  },
  // Self-hosted installs skip the marketing pages and go straight to the app, and their first
  // account becomes the instance admin. On unless SELF_HOSTED=false, which the hosted service sets.
  selfHosted: process.env.SELF_HOSTED !== 'false',
  setupCode: setupCodeSetting(process.env.SETUP_CODE),
  // Built web app to serve from this process (the Docker image sets it); empty in development
  webDir: process.env.WEB_DIR ?? '',
  // Ask GitHub once a day for the newest release, to tell self-hosted admins about it (src/releases.ts).
  // RELEASE_CHECK=false makes no request at all, for air-gapped installs.
  releaseCheck: process.env.RELEASE_CHECK !== 'false',
  migrateOnStart: process.env.MIGRATE_ON_START === 'true',
  // Bearer token for GET /api/cron/*, for hosts that run scheduled jobs from outside (Vercel Cron)
  cronSecret: process.env.CRON_SECRET ?? '',
  trustProxy: trustProxy(),
  embedFrameAncestors: embedFrameAncestors(process.env.EMBED_FRAME_ANCESTORS),
  // "off", or changes to the built-in rate limits such as "sign-in-link=20/1h,mcp=off"; read by src/limits.ts
  rateLimits: process.env.RATE_LIMITS ?? '',
  // What one workspace (a personal workspace or an organization) may hold; no limit when unset
  workspaceQuota: {
    pages: count('WORKSPACE_MAX_PAGES'),
    versions: count('WORKSPACE_MAX_VERSIONS'),
    bytes: parseSize(process.env.WORKSPACE_MAX_STORAGE, 'WORKSPACE_MAX_STORAGE'),
  },
  // Hosted service only: the Ed25519 private key that signs license keys for self-hosted installs
  // (src/ee/licenses.ts). Without it, Server admin can't issue keys. Self-hosted installs never need it.
  licenseSigningKey: process.env.LICENSE_SIGNING_KEY ?? '',
  // Days organizations' audit log events are kept (an Enterprise feature); the daily sweep deletes older ones
  auditLogRetentionDays: count('AUDIT_LOG_RETENTION_DAYS') ?? 365,
  // Encrypts the keys the server keeps in its database, so a copy of the database alone doesn't open
  // what they protect. previousKey is set only while changing to a new key; see docs/configuration.md
  encryption: encryptionKeys(process.env.ENCRYPTION_KEY, process.env.ENCRYPTION_KEY_PREVIOUS),
  // Bearer token Prometheus scrapes GET /metrics with; without it, /metrics doesn't exist
  metricsToken: process.env.METRICS_TOKEN ?? '',
  // Object storage (S3 API: MinIO, AWS S3, Cloudflare R2...) for page content and thumbnails.
  // Without keys, the AWS SDK's usual credential chain applies (e.g. an IAM role).
  storage: {
    endpoint: process.env.S3_ENDPOINT ?? '',
    region: process.env.S3_REGION || 'us-east-1',
    bucket: required('S3_BUCKET'),
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    // Where agents can reach the bucket themselves, for uploads that skip the API. Empty keeps
    // publishing inline only, e.g. with Docker Compose, where MinIO is on an internal network.
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? '',
  },
  // Gallery thumbnails: a Chrome or Chromium binary (empty skips them), the CDN hosts pages may
  // load from while rendering (unset uses a built-in list) and how many render at once
  thumbnails: {
    chromePath: process.env.CHROME_PATH ?? '',
    cdnHosts: process.env.THUMBNAIL_CDN_HOSTS,
    concurrency: thumbnailConcurrency(process.env.THUMBNAIL_CONCURRENCY),
  },
}

// Read on every call, so tests can switch email off by changing env
export const mailEnabled = () => Boolean(env.smtp.host)

export const isProduction = env.appUrl.startsWith('https://')

// A server run from a checkout (`pnpm dev`, the tests), never a deployment. Not tied to APP_URL: plenty
// of real installs serve plain http. The Docker image sets NODE_ENV=production, and anything that
// starts dist/ without NODE_ENV counts as a deployment too.
export const isDevServer = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'

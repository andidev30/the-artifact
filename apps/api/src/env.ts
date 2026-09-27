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

export const env = {
  port: Number(process.env.PORT ?? 3000),
  appUrl: required('APP_URL').replace(/\/$/, ''),
  databaseUrl: required('DATABASE_URL'),
  // Transaction-mode poolers (PgBouncer, Supabase on port 6543) hand each query to any server
  // connection, so prepared statements made on one aren't there on the next
  databasePrepare: process.env.DATABASE_PREPARE !== 'false',
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
  // Built web app to serve from this process (the Docker image sets it); empty in development
  webDir: process.env.WEB_DIR ?? '',
  migrateOnStart: process.env.MIGRATE_ON_START === 'true',
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
  // Gallery thumbnails: a Chrome or Chromium binary (empty skips them) and the CDN hosts pages may
  // load from while rendering (unset uses a built-in list)
  thumbnails: {
    chromePath: process.env.CHROME_PATH ?? '',
    cdnHosts: process.env.THUMBNAIL_CDN_HOSTS,
  },
}

// Read on every call, so tests can switch email off by changing env
export const mailEnabled = () => Boolean(env.smtp.host)

export const isProduction = env.appUrl.startsWith('https://')

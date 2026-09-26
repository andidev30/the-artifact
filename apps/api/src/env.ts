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
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  },
  smtp: {
    host: required('SMTP_HOST'),
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: required('SMTP_FROM'),
  },
  // Self-hosted installs skip the marketing pages and go straight to the app, and their first
  // account becomes the instance admin
  selfHosted: process.env.SELF_HOSTED === 'true',
  // Built web app to serve from this process (the Docker image sets it); empty in development
  webDir: process.env.WEB_DIR ?? '',
  migrateOnStart: process.env.MIGRATE_ON_START === 'true',
  // Only these email domains may create accounts (comma separated); empty means anyone
  allowedEmailDomains: (process.env.ALLOWED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean),
  // These addresses are always instance admins (comma separated), e.g. to recover an install
  adminEmails: (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  // Object storage (S3 API: MinIO, AWS S3, Cloudflare R2...) for page content and thumbnails.
  // Without keys, the AWS SDK's usual credential chain applies (e.g. an IAM role).
  storage: {
    endpoint: process.env.S3_ENDPOINT ?? '',
    region: process.env.S3_REGION || 'us-east-1',
    bucket: required('S3_BUCKET'),
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
  },
  // Gallery thumbnails: a Chrome or Chromium binary (empty skips them) and the CDN hosts pages may
  // load from while rendering (unset uses a built-in list)
  thumbnails: {
    chromePath: process.env.CHROME_PATH ?? '',
    cdnHosts: process.env.THUMBNAIL_CDN_HOSTS,
  },
}

export const isProduction = env.appUrl.startsWith('https://')

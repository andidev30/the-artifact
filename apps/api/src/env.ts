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
  // Self-hosted installs skip the marketing pages and go straight to the app
  selfHosted: process.env.SELF_HOSTED === 'true',
  // Built web app to serve from this process (the Docker image sets it); empty in development
  webDir: process.env.WEB_DIR ?? '',
  migrateOnStart: process.env.MIGRATE_ON_START === 'true',
  // Only these email domains may create accounts (comma separated); empty means anyone
  allowedEmailDomains: (process.env.ALLOWED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean),
  // The first account created on the instance becomes its admin. On by default when self-hosted.
  firstUserAdmin: process.env.FIRST_USER_ADMIN ? process.env.FIRST_USER_ADMIN === 'true' : process.env.SELF_HOSTED === 'true',
  // These addresses are always instance admins (comma separated), e.g. to recover an install
  adminEmails: (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
}

export const isProduction = env.appUrl.startsWith('https://')

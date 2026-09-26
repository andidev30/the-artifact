import { defineConfig } from 'vitest/config'

// Tests never rely on apps/api/.env: these are set before src/env.ts loads,
// and process.loadEnvFile() does not override variables that are already set.
const env = {
  APP_URL: 'http://localhost:5177',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://artifact:artifact@localhost:5432/artifact_test',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_FROM: 'The Artifact <test@example.com>',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  // Tests that need these change the env object instead
  SELF_HOSTED: 'false',
  ALLOWED_EMAIL_DOMAINS: '',
  ADMIN_EMAILS: '',
  FIRST_USER_ADMIN: '',
}

export default defineConfig({
  test: {
    env,
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          setupFiles: ['test/integration/setup.ts'],
          // One shared database, truncated before every test
          fileParallelism: false,
        },
      },
    ],
  },
})

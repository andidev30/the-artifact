import { defineConfig, devices } from '@playwright/test'

// Dedicated ports and database so e2e runs don't touch a dev setup on 3000/5173
const API_PORT = 3004
const WEB_PORT = 5177
const WEB_URL = `http://localhost:${WEB_PORT}`

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    // Uses the installed Google Chrome; set PW_CHROMIUM=1 after `npx playwright install chromium` to use Chromium instead
    { name: 'chrome', use: { ...devices['Desktop Chrome'], ...(process.env.PW_CHROMIUM ? {} : { channel: 'chrome' }) } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @the-artifact/api exec tsx src/index.ts',
      url: `http://localhost:${API_PORT}/`,
      reuseExistingServer: false,
      stdout: 'pipe',
      env: {
        PORT: String(API_PORT),
        APP_URL: WEB_URL,
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://artifact:artifact@localhost:5432/artifact_test',
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        SMTP_SECURE: 'false',
        SMTP_USER: '',
        SMTP_PASS: '',
        SMTP_FROM: 'The Artifact <e2e@example.com>',
        // Pin settings a developer's apps/api/.env might set, so they can't change e2e behaviour
        SELF_HOSTED: 'false',
        FIRST_USER_ADMIN: 'false',
        ADMIN_EMAILS: '',
        ALLOWED_EMAIL_DOMAINS: '',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        // The MinIO from docker-compose, in the bucket the API tests use
        S3_ENDPOINT: 'http://localhost:9000',
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'artifact-test',
        S3_ACCESS_KEY_ID: 'artifact',
        S3_SECRET_ACCESS_KEY: 'artifact-secret',
        S3_FORCE_PATH_STYLE: 'true',
        S3_CREATE_BUCKET: 'true',
      },
    },
    {
      command: `pnpm --filter @the-artifact/web exec vite --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      reuseExistingServer: false,
      env: { API_URL: `http://localhost:${API_PORT}`, VITE_APP_URL: '' },
    },
  ],
})

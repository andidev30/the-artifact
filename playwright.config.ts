import { defineConfig, devices } from '@playwright/test'
import { HOSTED_DATABASE_URL, SELF_HOSTED_DATABASE_URL, SELF_HOSTED_SETUP_CODE } from './apps/api/test/e2e-db.ts'

// Dedicated ports and databases so e2e runs don't touch a dev setup on 3000/5173.
// One server pair runs as the hosted service, the other as a self-hosted install.
const HOSTED = { api: 3004, web: 5177 }
const SELF_HOSTED = { api: 3005, web: 5178 }
const webUrl = (ports: { web: number }) => `http://localhost:${ports.web}`

const BUCKET = process.env.TEST_S3_BUCKET ?? 'artifact-test'
// Its own bucket too: the storage sweep deletes every blob its database doesn't refer to, and this
// database is emptied on every run
const SELF_HOSTED_BUCKET = process.env.TEST_SELF_HOSTED_S3_BUCKET ?? `${BUCKET}-selfhosted`

// Uses the installed Google Chrome; set PW_CHROMIUM=1 after `npx playwright install chromium` to use Chromium instead
const browser = { ...devices['Desktop Chrome'], ...(process.env.PW_CHROMIUM ? {} : { channel: 'chrome' as const }) }

// The hosted pair serves pages from a content origin of their own, as the hosted service does: the API's
// own address on 127.0.0.1, another site than localhost, so the browser keeps the app's cookies away
// from it. The self-hosted pair serves them from the app, the default.
const contentOrigin = (ports: { api: number }) => `http://127.0.0.1:${ports.api}`

function servers(ports: { api: number; web: number }, selfHosted: boolean, databaseUrl: string, bucket: string) {
  return [
    {
      command: 'pnpm --filter @the-artifact/api exec tsx src/index.ts',
      url: `http://localhost:${ports.api}/`,
      reuseExistingServer: false,
      stdout: 'pipe' as const,
      env: {
        PORT: String(ports.api),
        // One process, as in development; apps/api/test/integration/cluster.test.ts covers workers
        WEB_CONCURRENCY: '1',
        APP_URL: webUrl(ports),
        DATABASE_URL: databaseUrl,
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        SMTP_SECURE: 'false',
        SMTP_USER: '',
        SMTP_PASS: '',
        SMTP_FROM: 'The Artifact <e2e@example.com>',
        // Pin settings a developer's apps/api/.env might set, so they can't change e2e behaviour
        SELF_HOSTED: String(selfHosted),
        SETUP_CODE: selfHosted ? SELF_HOSTED_SETUP_CODE : '',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        SALES_EMAIL: '',
        // No signing key, so Server admin shows why it can't issue license keys (e2e/admin.spec.ts)
        LICENSE_SIGNING_KEY: '',
        // Every spec signs in from localhost, so per-network limits would count them all together.
        // The limits themselves are covered by apps/api/test/integration/limits.test.ts.
        RATE_LIMITS: 'off',
        TRUST_PROXY: '',
        EMBED_FRAME_ANCESTORS: '',
        CONTENT_ORIGIN: selfHosted ? '' : contentOrigin(ports),
        WORKSPACE_MAX_PAGES: '',
        WORKSPACE_MAX_VERSIONS: '',
        WORKSPACE_MAX_STORAGE: '',
        // On, so the admin area shows the release e2e/self-hosted/release-notice.spec.ts records;
        // that record also keeps the server from asking GitHub itself
        RELEASE_CHECK: 'true',
        // The MinIO from docker-compose
        S3_ENDPOINT: 'http://localhost:9000',
        S3_REGION: 'us-east-1',
        S3_BUCKET: bucket,
        S3_ACCESS_KEY_ID: 'artifact',
        S3_SECRET_ACCESS_KEY: 'artifact-secret',
      },
    },
    {
      command: `pnpm --filter @the-artifact/web exec vite --port ${ports.web} --strictPort`,
      url: webUrl(ports),
      reuseExistingServer: false,
      env: { API_URL: `http://localhost:${ports.api}`, VITE_APP_URL: '' },
    },
  ]
}

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chrome', testIgnore: 'self-hosted/**', use: { ...browser, baseURL: webUrl(HOSTED) }, metadata: { contentOrigin: contentOrigin(HOSTED) } },
    // Runs alone before the other self-hosted specs, on the freshly emptied database. A retry would no
    // longer be the first account, so it gets none.
    {
      name: 'self-hosted-first-account',
      testDir: 'e2e/self-hosted',
      testMatch: 'first-account.spec.ts',
      retries: 0,
      use: { ...browser, baseURL: webUrl(SELF_HOSTED) },
    },
    {
      name: 'self-hosted',
      testDir: 'e2e/self-hosted',
      testIgnore: 'first-account.spec.ts',
      dependencies: ['self-hosted-first-account'],
      use: { ...browser, baseURL: webUrl(SELF_HOSTED) },
    },
  ],
  webServer: [...servers(HOSTED, false, HOSTED_DATABASE_URL, BUCKET), ...servers(SELF_HOSTED, true, SELF_HOSTED_DATABASE_URL, SELF_HOSTED_BUCKET)],
})

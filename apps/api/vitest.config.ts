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
  // A bucket of its own on the MinIO from docker-compose, created on first use
  S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: process.env.TEST_S3_BUCKET ?? 'artifact-test',
  S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID ?? 'artifact',
  S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'artifact-secret',
  // Direct uploads are on; test/integration/uploads.test.ts switches them off where it needs to
  S3_PUBLIC_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
  // Thumbnails are off unless a test turns them on (test/integration/thumbnails.test.ts)
  CHROME_PATH: '',
}

export default defineConfig({
  test: {
    env,
    // Every request logs a line (src/log.ts); show them only for the tests that fail
    silent: 'passed-only',
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

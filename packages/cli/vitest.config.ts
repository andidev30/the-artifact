import { defineConfig } from 'vitest/config'

// Unit tests only. Runs against a real server are in apps/api/test/integration/cli.test.ts, where
// they share the test database with the API's other integration tests and run one file at a time.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})

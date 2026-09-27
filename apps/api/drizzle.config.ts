import { defineConfig } from 'drizzle-kit'

try {
  process.loadEnvFile()
} catch {
  // No .env file; rely on the real environment
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
})

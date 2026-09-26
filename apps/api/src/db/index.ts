import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env.js'
import * as schema from './schema.js'

// Notices are informational (e.g. "already exists, skipping" from migrations)
const client = postgres(env.databaseUrl, { onnotice: () => {} })

export const db = drizzle(client, { schema })
export { schema }

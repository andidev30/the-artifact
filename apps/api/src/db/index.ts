import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env.js'
import * as schema from './schema.js'

// Notices are informational (e.g. "already exists, skipping" from migrations)
const client = postgres(env.databaseUrl, { onnotice: () => {}, prepare: env.databasePrepare })

// postgres.js doesn't expose its pool, so the metrics count what holds a connection instead: every
// query outside a transaction while it runs, and every transaction from begin to commit. Drizzle
// sends everything through unsafe() and begin(); queries inside a transaction use its connection.
let active = 0
const done = () => {
  active -= 1
}

const unsafe = client.unsafe
client.unsafe = ((...args: Parameters<typeof unsafe>) => {
  const query = unsafe(...args)
  const then = query.then
  let counted = false
  // A query runs when it is first awaited, not when it is built, so that is when it starts counting
  // biome-ignore lint/suspicious/noThenProperty: wraps the query's own then, which is what await calls
  query.then = function (this: typeof query, ...handlers) {
    if (!counted) {
      counted = true
      active += 1
      then.call(this, done, done)
    }
    return then.apply(this, handlers) as never
  }
  return query
}) as typeof unsafe

const begin = client.begin
client.begin = ((...args: Parameters<typeof begin>) => {
  active += 1
  return begin(...args).finally(done)
}) as typeof begin

// max is the pool size; active above it means queries are waiting for a connection
export const poolStats = () => ({ max: client.options.max, active })

export const db = drizzle(client, { schema })
export { schema }

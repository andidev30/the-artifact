import { AsyncLocalStorage } from 'node:async_hooks'
import { DrizzleQueryError } from 'drizzle-orm'

// One JSON object per line, so log collectors (Loki, CloudWatch, Vercel) can filter by field. Lines
// written while a request is handled carry its id, which is also sent back as X-Request-Id.

type Level = 'info' | 'warn' | 'error'
type Fields = Record<string, unknown>

export const requestContext = new AsyncLocalStorage<{ requestId: string }>()

// A failed query's message (and so its stack) lists the values it was run with: link keys, comment
// text, email addresses. Only the query itself and what Postgres said about it are logged.
function describe(err: unknown): Fields {
  if (err instanceof DrizzleQueryError) {
    const cause = err.cause as (Error & { code?: unknown }) | undefined
    return { error: cause?.message ?? 'Query failed', errorName: err.name, code: cause?.code, query: err.query, stack: cause?.stack }
  }
  if (err instanceof Error) return { error: err.message, errorName: err.name, stack: err.stack }
  return { error: String(err) }
}

function write(level: Level, msg: string, fields: Fields = {}) {
  const requestId = requestContext.getStore()?.requestId
  const { err, ...rest } = fields
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    msg,
    ...(requestId ? { requestId } : {}),
    ...rest,
    ...(err === undefined ? {} : describe(err)),
  })
  if (level === 'info') console.log(line)
  else console.error(line)
}

// Pass a caught error as `err`; its message and stack are logged as fields
export const log = {
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
}

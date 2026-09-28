import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono, type MiddlewareHandler } from 'hono'
import { env } from '../env.js'
import { runPruners, sweepStorage } from '../gc.js'
import { deleteExpiredLimits } from '../limits.js'
import { deleteOldViews } from '../views.js'

// Scheduled jobs for hosts without a long-running process, such as Vercel, where the timers in
// index.ts never run. A scheduler calls these with CRON_SECRET as a bearer token (Vercel Cron
// sends it by itself). Without CRON_SECRET they don't exist.
export const cron = new Hono()

// True when the header is `Bearer <secret>`; an empty secret matches nothing
export function bearerMatches(header: string | undefined, secret: string): boolean {
  if (!secret || !header) return false
  // Compared as hashes, which have the same length, so the time taken says nothing about the secret
  const digest = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`))
}

export const requireCronSecret: MiddlewareHandler = async (c, next) => {
  if (!bearerMatches(c.req.header('authorization'), env.cronSecret)) return c.json({ error: 'Not found' }, 404)
  await next()
}

cron.use(requireCronSecret)

cron.get('/sweep', async (c) => {
  await runPruners()
  return c.json({ ...(await sweepStorage()), rateLimits: await deleteExpiredLimits(), views: await deleteOldViews() })
})

import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono, type MiddlewareHandler } from 'hono'
import { env } from '../env.js'
import { resumeExports, sweepExports } from '../exports.js'
import { runPruners, sweepStorage } from '../gc.js'
import { deleteExpiredLimits } from '../limits.js'
import { sweepPdfs } from '../pdf.js'
import { indexStale } from '../search.js'
import { deleteOldViews } from '../views.js'
import { runWebhookQueue } from '../webhooks.js'

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

// Vercel stops the function at maxDuration (60 s in vercel.json). Each run gets one deadline, well
// before that: every step stops starting new work once it passes and leaves the rest for the next run.
// Work already under way then still has to finish in what is left: a batch of webhooks (up to their
// 5 s timeout), a page being indexed, deleting what the storage sweep found.
const RUN_MS = 40_000
// Data exports get at most this much of it, so a big export doesn't leave nothing for search
const EXPORT_BUDGET_MS = 20_000

let runMs = RUN_MS

// For tests: a shorter run; null goes back to the default
export function configureCron(next: { runMs?: number } | null) {
  runMs = next?.runMs ?? RUN_MS
}

// Quick deletes first, then what people wait for (webhook retries, exports), and the storage sweep,
// which can take longest and can wait a day, last. Pruners still run before it: the rows they delete
// are what frees blobs.
cron.get('/sweep', async (c) => {
  const deadline = Date.now() + runMs
  await runPruners()
  const rateLimits = await deleteExpiredLimits()
  const views = await deleteOldViews()
  const exports = await sweepExports()
  const webhooks = await runWebhookQueue({ deadline })
  const exportSteps = await resumeExports({ budgetMs: Math.min(EXPORT_BUDGET_MS, deadline - Date.now()) })
  const indexed = await indexStale(500, deadline)
  const pdfs = await sweepPdfs(deadline)
  const storage = await sweepStorage({ deadline })
  return c.json({ ...storage, rateLimits, views, exports, exportSteps, webhooks, indexed, pdfs })
})

// Webhook retries that are due (src/webhooks.ts). Without a long-running process, first attempts are
// made as events happen and retries wait for this, so call it every few minutes where the host allows.
cron.get('/webhooks', async (c) => c.json({ webhooks: await runWebhookQueue({ deadline: Date.now() + runMs }) }))

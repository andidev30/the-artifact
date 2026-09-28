import { and, count, desc, eq, isNull } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { audit } from '../audit.js'
import { requireUser, type AuthEnv } from '../auth/session.js'
import { db, schema } from '../db/index.js'
import type { Webhook } from '../db/schema.js'
import { limitRequest } from '../limits.js'
import { UUID_RE } from '../validation.js'
import {
  checkWebhookUrl,
  dropPending,
  MAX_WEBHOOKS,
  newSecret,
  type Payload,
  recentDeliveries,
  sealWebhookSecret,
  sendTestDelivery,
  WEBHOOK_EVENTS,
  WEBHOOK_FORMATS,
  type WebhookEvent,
  type WebhookFormat,
} from '../webhooks.js'

// Webhooks of one workspace (src/webhooks.ts): /api/organizations/:orgId/webhooks for an
// organization's owners and admins, /api/me/webhooks for the person's personal workspace. Everyone
// else, and organizations the person isn't in, get the same 404. The secret is in the response that
// creates the webhook and nowhere else.

type Scope = { organizationId: string; name: string } | { userId: string }

const NOT_FOUND = { error: 'Not found' }
const w = schema.webhooks

const where = (scope: Scope) =>
  'organizationId' in scope ? eq(w.organizationId, scope.organizationId) : and(isNull(w.organizationId), eq(w.userId, scope.userId))

const workspaceOf = (scope: Scope): Payload['workspace'] =>
  'organizationId' in scope ? { type: 'organization', id: scope.organizationId, name: scope.name } : { type: 'personal', name: 'Personal' }

async function describe(hook: Webhook) {
  const [last] = await db
    .select({ status: schema.webhookDeliveries.status, createdAt: schema.webhookDeliveries.createdAt })
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.webhookId, hook.id))
    .orderBy(desc(schema.webhookDeliveries.createdAt))
    .limit(1)
  return {
    id: hook.id,
    url: hook.url,
    format: hook.format,
    events: hook.events,
    enabled: hook.enabled,
    createdAt: hook.createdAt,
    updatedAt: hook.updatedAt,
    lastDelivery: last ?? null,
  }
}

type Parsed = { url?: string; format?: WebhookFormat; events?: WebhookEvent[]; enabled?: boolean }

// Every field is optional here; creating checks that url and events are there
function parse(body: Record<string, unknown> | null): Parsed | { error: string; field: string } {
  const out: Parsed = {}
  if (body?.url !== undefined) {
    const checked = checkWebhookUrl(body.url)
    if ('error' in checked) return { error: checked.error, field: 'url' }
    out.url = checked.url
  }
  if (body?.format !== undefined) {
    if (!WEBHOOK_FORMATS.includes(body.format as WebhookFormat)) return { error: 'Choose JSON, Slack or Discord.', field: 'format' }
    out.format = body.format as WebhookFormat
  }
  if (body?.events !== undefined) {
    const events = Array.isArray(body.events) ? [...new Set(body.events)] : []
    if (!events.length || !events.every((e) => WEBHOOK_EVENTS.includes(e as WebhookEvent)))
      return { error: 'Choose at least one event to send.', field: 'events' }
    out.events = WEBHOOK_EVENTS.filter((e) => events.includes(e))
  }
  if (body?.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { error: 'Turn the webhook on or off.', field: 'enabled' }
    out.enabled = body.enabled
  }
  return out
}

// For the organization's audit log: the destination's host, never its full address (it may hold a token)
const label = (url: string) => new URL(url).host

function auditHook(c: Context<AuthEnv>, scope: Scope, action: 'webhook.created' | 'webhook.changed' | 'webhook.deleted', hook: Webhook, details = {}) {
  if (!('organizationId' in scope)) return
  const user = c.get('user')!
  audit({
    action,
    organizationId: scope.organizationId,
    actor: { id: user.id, email: user.email },
    target: { type: 'webhook', id: hook.id, label: label(hook.url) },
    details,
  })
}

function routes(resolve: (c: Context<AuthEnv>) => Promise<Scope | null>) {
  const r = new Hono<AuthEnv>()
  r.use(requireUser)

  const find = async (scope: Scope, id: string) => {
    if (!UUID_RE.test(id)) return null
    const [row] = await db
      .select()
      .from(w)
      .where(and(eq(w.id, id), where(scope)))
    return row ?? null
  }

  r.get('/', async (c) => {
    const scope = await resolve(c)
    if (!scope) return c.json(NOT_FOUND, 404)
    const rows = await db.select().from(w).where(where(scope)).orderBy(w.createdAt)
    return c.json({ webhooks: await Promise.all(rows.map(describe)), max: MAX_WEBHOOKS })
  })

  // { url, format ("json" if left out), events, enabled (true if left out) }
  r.post('/', async (c) => {
    const scope = await resolve(c)
    if (!scope) return c.json(NOT_FOUND, 404)
    const parsed = parse((await c.req.json().catch(() => null)) as Record<string, unknown> | null)
    if ('error' in parsed) return c.json(parsed, 400)
    if (!parsed.url) return c.json({ error: 'Enter the address to send events to.', field: 'url' }, 400)
    if (!parsed.events) return c.json({ error: 'Choose at least one event to send.', field: 'events' }, 400)
    const [{ n }] = await db.select({ n: count() }).from(w).where(where(scope))
    if (n >= MAX_WEBHOOKS) return c.json({ error: `A workspace can have up to ${MAX_WEBHOOKS} webhooks. Delete one first.` }, 400)
    const user = c.get('user')!
    const busy = await limitRequest(c, 'webhook', user.id, 'You have added or tested a lot of webhooks in a short time.')
    if (busy) return busy
    const secret = newSecret()
    const [hook] = await db
      .insert(w)
      .values({
        ...('organizationId' in scope ? { organizationId: scope.organizationId } : { userId: scope.userId }),
        url: parsed.url,
        format: parsed.format ?? 'json',
        events: parsed.events,
        enabled: parsed.enabled ?? true,
        secret: await sealWebhookSecret(secret),
        createdBy: user.id,
      })
      .returning()
    auditHook(c, scope, 'webhook.created', hook, { events: hook.events, format: hook.format })
    return c.json({ webhook: await describe(hook), secret }, 201)
  })

  r.patch('/:id', async (c) => {
    const scope = await resolve(c)
    if (!scope) return c.json(NOT_FOUND, 404)
    const hook = await find(scope, c.req.param('id'))
    if (!hook) return c.json(NOT_FOUND, 404)
    const parsed = parse((await c.req.json().catch(() => null)) as Record<string, unknown> | null)
    if ('error' in parsed) return c.json(parsed, 400)
    const [updated] = await db
      .update(w)
      .set({ ...parsed, updatedAt: new Date() })
      .where(eq(w.id, hook.id))
      .returning()
    if (hook.enabled && updated.enabled === false) await dropPending(hook.id)
    const changed = Object.fromEntries(
      (['url', 'format', 'events', 'enabled'] as const)
        .filter((k) => JSON.stringify(hook[k]) !== JSON.stringify(updated[k]))
        .map((k) => [k, k === 'url' ? { from: label(hook.url), to: label(updated.url) } : { from: hook[k], to: updated[k] }]),
    )
    if (Object.keys(changed).length) auditHook(c, scope, 'webhook.changed', updated, changed)
    return c.json({ webhook: await describe(updated) })
  })

  r.delete('/:id', async (c) => {
    const scope = await resolve(c)
    if (!scope) return c.json(NOT_FOUND, 404)
    const hook = await find(scope, c.req.param('id'))
    if (!hook) return c.json(NOT_FOUND, 404)
    await db.delete(w).where(eq(w.id, hook.id))
    auditHook(c, scope, 'webhook.deleted', hook)
    return c.body(null, 204)
  })

  // Sends a test message now and answers how it went
  r.post('/:id/test', async (c) => {
    const scope = await resolve(c)
    if (!scope) return c.json(NOT_FOUND, 404)
    const hook = await find(scope, c.req.param('id'))
    if (!hook) return c.json(NOT_FOUND, 404)
    if (!hook.enabled) return c.json({ error: 'Turn the webhook on to send a test.' }, 400)
    const busy = await limitRequest(c, 'webhook', c.get('user')!.id, 'You have added or tested a lot of webhooks in a short time.')
    if (busy) return busy
    const { payload: _, webhookId: __, ...delivery } = await sendTestDelivery(hook, workspaceOf(scope))
    return c.json({ delivery })
  })

  r.get('/:id/deliveries', async (c) => {
    const scope = await resolve(c)
    if (!scope) return c.json(NOT_FOUND, 404)
    const hook = await find(scope, c.req.param('id'))
    if (!hook) return c.json(NOT_FOUND, 404)
    return c.json({ deliveries: await recentDeliveries(hook.id) })
  })

  return r
}

// Mounted at /api/organizations/:orgId/webhooks: owners and admins only
export const organizationWebhooks = routes(async (c) => {
  const orgId = c.req.param('orgId') ?? ''
  const user = c.get('user')!
  if (!UUID_RE.test(orgId) || user.blockedOrgs.includes(orgId)) return null
  const [row] = await db
    .select({ role: schema.memberships.role, name: schema.organizations.name })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.organizationId))
    .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, user.id)))
  return row && row.role !== 'member' ? { organizationId: orgId, name: row.name } : null
})

// Mounted at /api/me/webhooks: the signed-in person's personal workspace
export const personalWebhooks = routes(async (c) => ({ userId: c.get('user')!.id }))

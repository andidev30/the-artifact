// Prepares an instance for the k6 load tests in load/: people with sessions and MCP tokens, an
// organization, pages to open (link-shared and organization-only, each a small multi-file site) and a
// gallery with thousands of pages in folders. It writes rows and blobs with the server's own code,
// using the same DATABASE_URL and S3_* settings as the server under test, and saves what the scripts
// need (cookies, tokens, page ids) to load/seed.json.
//
//   pnpm --filter @the-artifact/api load:seed -- --pages 5000
//
// Sessions and MCP access tokens are inserted directly, as test/integration/helpers.ts does, instead of
// going through the browser sign-in and OAuth consent: that is the one step a load test can't click
// through, and the rows are the ones a real sign-in would leave. Anyone holding seed.json can act as
// these people until the tokens expire, so only seed test and staging instances.
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    users: { type: 'string', default: '20' },
    pages: { type: 'string', default: '5000' },
    folders: { type: 'string', default: '25' },
    'link-pages': { type: 'string', default: '100' },
    'org-pages': { type: 'string', default: '100' },
    'site-kb': { type: 'string', default: '150' },
    'token-hours': { type: 'string', default: '24' },
    'no-thumbnails': { type: 'boolean', default: false },
    out: { type: 'string', default: fileURLToPath(new URL('../../../../load/seed.json', import.meta.url)) },
    'allow-any-database': { type: 'boolean', default: false },
  },
})

function whole(name: keyof typeof args, min = 0): number {
  const n = Number(args[name])
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`--${name} must be a whole number of at least ${min}.`)
  return n
}

const USERS = whole('users', 2)
const PAGES = whole('pages')
const FOLDERS = whole('folders')
const LINK_PAGES = whole('link-pages', 1)
const ORG_PAGES = whole('org-pages', 1)
const SITE_BYTES = whole('site-kb', 1) * 1024
const TOKEN_MS = whole('token-hours', 1) * 3600_000

try {
  process.loadEnvFile()
} catch {
  // No .env file; the environment says where the database is
}

// Checked before any server module loads, since loading them opens the database
const databaseUrl = process.env.DATABASE_URL ?? ''
const databaseName = (() => {
  try {
    return decodeURIComponent(new URL(databaseUrl).pathname.slice(1))
  } catch {
    return ''
  }
})()
if (!/test|staging|stage|load|perf|bench/i.test(databaseName) && !args['allow-any-database']) {
  console.error(
    `Refusing to seed the database "${databaseName || databaseUrl}": its name doesn't say test, staging, load, perf or bench. ` +
      'Seeding adds thousands of pages and people who can sign in with the tokens it saves. ' +
      'Point DATABASE_URL at a test instance, or pass --allow-any-database if this really is one.',
  )
  process.exit(1)
}

// Rendering thumbnails is the server's job; this process only writes rows
process.env.CHROME_PATH = ''

const { publish } = await import('../../src/artifacts.js')
const { hashToken, randomToken } = await import('../../src/auth/session.js')
const { db, schema } = await import('../../src/db/index.js')
const { sha256 } = await import('../../src/files.js')
const { ensureBucket, putBlob } = await import('../../src/storage.js')

const run = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(3).toString('hex')}`
const expiresAt = new Date(Date.now() + TOKEN_MS)
const WORDS = ['quarterly', 'report', 'roadmap', 'launch', 'metrics', 'design', 'review', 'pricing', 'onboarding', 'incident', 'survey', 'dashboard']
const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

const pick = <T>(list: T[], i: number) => list[i % list.length]
const slug = () => Array.from(randomBytes(10), (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join('')

// Filler that differs per page, so pages don't share blobs and the server's blob cache has to work
function filler(seed: string, bytes: number, line: (n: number) => string): string {
  const parts: string[] = []
  let size = 0
  for (let n = 0; size < bytes; n++) {
    const s = line(n).replaceAll('$', seed)
    parts.push(s)
    size += s.length + 1
  }
  return parts.join('\n')
}

// About SITE_BYTES in all: index.html with a stylesheet, a script, a data file and two images
function site(seed: string, title: string) {
  const share = (fraction: number) => Math.max(256, Math.floor(SITE_BYTES * fraction))
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="css/site.css"></head><body>\n` +
    `<h1>${title}</h1><img src="img/hero.png" alt=""><img src="img/chart.png" alt=""><div id="app"></div>\n` +
    filler(seed, share(0.2), (n) => `<p>Paragraph ${n} of $. The quick brown fox jumps over the lazy dog.</p>`) +
    '\n<script src="js/app.js"></script></body></html>'
  const css = filler(seed, share(0.1), (n) => `.c${n}-$ { margin: ${n % 16}px; color: #${(n * 2654435761).toString(16).slice(-6).padStart(6, '0')}; }`)
  const js = filler(seed, share(0.3), (n) => `function f${n}_${seed.replaceAll('-', '_')}(x) { return x * ${n} + ${n % 7} }`)
  const data = JSON.stringify(Array.from({ length: Math.ceil(share(0.1) / 40) }, (_, n) => ({ n, seed, value: (n * 37) % 101 })))
  const image = (fraction: number) => randomBytes(share(fraction)).toString('base64')
  return {
    html,
    files: [
      { path: 'css/site.css', content: css },
      { path: 'js/app.js', content: js },
      { path: 'data/points.json', content: data },
      { path: 'img/hero.png', content: image(0.2), encoding: 'base64' as const },
      { path: 'img/chart.png', content: image(0.1), encoding: 'base64' as const },
    ],
  }
}

async function inBatches<T>(items: T[], size: number, fn: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size))
}

async function concurrently<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i], i)
      }
    }),
  )
  return results
}

await ensureBucket()
console.log(`Seeding run ${run} into ${databaseName}`)

const people = await db
  .insert(schema.users)
  .values(Array.from({ length: USERS }, (_, i) => ({ email: `load-${run}-${i}@example.com`, name: `Load user ${i}`, onboardedAt: new Date() })))
  .returning()

const [org] = await db
  .insert(schema.organizations)
  .values({ name: `Load test ${run}`, slug: `load-${run}` })
  .returning()
await db
  .insert(schema.memberships)
  .values(people.map((u, i) => ({ organizationId: org.id, userId: u.id, role: i === 0 ? ('owner' as const) : ('member' as const) })))

const [client] = await db
  .insert(schema.oauthClients)
  .values({ id: randomToken(), name: 'k6-load-test', redirectUris: ['http://127.0.0.1/callback'] })
  .returning()

const users = []
for (const u of people) {
  const session = randomToken()
  const personal = randomToken()
  const organization = randomToken()
  await db.insert(schema.sessions).values({ id: hashToken(session), userId: u.id, expiresAt })
  await db.insert(schema.oauthTokens).values([
    { id: hashToken(personal), kind: 'access', clientId: client.id, userId: u.id, organizationId: null, expiresAt },
    { id: hashToken(organization), kind: 'access', clientId: client.id, userId: u.id, organizationId: org.id, expiresAt },
  ])
  users.push({ email: u.email, cookie: `session=${session}`, token: personal, orgToken: organization })
}
console.log(`${USERS} people, organization ${org.slug}`)

// Pages to open, published the way an agent's publish is stored
const publishSite = async (kind: 'link' | 'organization', i: number) => {
  const owner = pick(people, i)
  const title = `Open ${kind} ${i}`
  const content = site(`${run}-${kind}-${i}`, title)
  const page = await publish({
    userId: owner.id,
    email: owner.email,
    organizationId: kind === 'organization' ? org.id : null,
    clientName: client.name,
    title,
    visibility: kind,
    ...content,
  })
  return { slug: page.slug, version: page.currentVersion, files: content.files.map((f) => f.path) }
}
const linkPages = await concurrently(Array.from({ length: LINK_PAGES }), 8, (_, i) => publishSite('link', i))
const orgPages = await concurrently(Array.from({ length: ORG_PAGES }), 8, (_, i) => publishSite('organization', i))
console.log(`${LINK_PAGES} link-shared and ${ORG_PAGES} organization pages to open`)

const folders = FOLDERS
  ? await db
      .insert(schema.folders)
      .values(Array.from({ length: FOLDERS }, (_, i) => ({ organizationId: org.id, name: `${pick(WORDS, i)} ${i}`, createdBy: people[0].id })))
      .returning()
  : []

// The gallery's pages share one small HTML blob and one placeholder image: the gallery reads rows,
// never content. Without placeholders, the first gallery loads would queue every page for a render.
const galleryHtml = '<!doctype html><title>Gallery page</title><h1>Gallery page</h1>'
const htmlSha = await putBlob(galleryHtml, sha256(galleryHtml))
// A 1x1 PNG
const thumbnail = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const thumbSha = args['no-thumbnails'] ? null : await putBlob(thumbnail, sha256(thumbnail))

const now = Date.now()
const year = 365 * 86_400_000
await inBatches(
  Array.from({ length: PAGES }, (_, i) => i),
  500,
  async (batch) => {
    const rows = batch.map((i) => {
      const owner = pick(people, i * 7)
      const updatedAt = new Date(now - Math.floor(Math.random() * year))
      return {
        slug: slug(),
        title: `${pick(WORDS, i)} ${pick(WORDS, i * 5 + 3)} ${i}`,
        ownerId: owner.id,
        organizationId: org.id,
        // A fifth are private to their owner, which the gallery has to filter out for everyone else
        visibility: i % 5 === 4 ? ('private' as const) : ('organization' as const),
        publishedWith: client.name,
        folderId: folders.length && i % 10 < 7 ? pick(folders, i).id : null,
        createdAt: updatedAt,
        updatedAt,
      }
    })
    const pages = await db.insert(schema.artifacts).values(rows).returning({ id: schema.artifacts.id, ownerId: schema.artifacts.ownerId })
    const versions = await db
      .insert(schema.artifactVersions)
      .values(
        pages.map((p) => ({
          artifactId: p.id,
          version: 1,
          htmlSha256: htmlSha,
          htmlSize: Buffer.byteLength(galleryHtml),
          publishedWith: client.name,
          publishedBy: p.ownerId,
        })),
      )
      .returning({ id: schema.artifactVersions.id })
    if (thumbSha) await db.insert(schema.artifactThumbnails).values(versions.map((v) => ({ versionId: v.id, sha256: thumbSha, contentType: 'image/png' })))
  },
)
console.log(`${PAGES} gallery pages in ${folders.length} folders`)

const seed = {
  run,
  createdAt: new Date().toISOString(),
  expiresAt: expiresAt.toISOString(),
  organization: { id: org.id, slug: org.slug },
  users,
  pages: { link: linkPages, organization: orgPages },
  gallery: {
    organizationId: org.id,
    pages: PAGES,
    folders: folders.map((f) => ({ id: f.id, name: f.name })),
    searchTerms: WORDS,
  },
}
writeFileSync(args.out, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 })
console.log(`Wrote ${args.out}; the tokens in it work until ${expiresAt.toISOString()}`)
await db.$client.end()

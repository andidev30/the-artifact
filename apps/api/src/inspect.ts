import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { CDPSession } from 'playwright-core'
import { log } from './log.js'
import { BrowserGone, inPage, loadTree, PAGE_ORIGIN, type PageTree, type RequestNotes, renderConcurrency, type View } from './thumbnails.js'

// inspect_artifact: an agent's look at its own page before it shares the link. The page is opened by
// inPage in src/thumbnails.ts, like a thumbnail: same Chromium, same interception, CDN allowlist,
// dead proxy and timeouts, a fresh context and no cookies. What differs is only what is read back:
// console errors, requests for missing files, links to missing files, axe-core's findings and a
// screenshot. axe-core runs in an isolated world (its own JavaScript globals, the page's DOM), so the
// page's scripts can't see or tamper with it, and its source comes from node_modules, never the network.
//
// In a cluster, inspections run in the worker that has Chromium (the background one, src/primary.ts),
// like thumbnails; other workers ask it over IPC and wait for the answer (src/server.ts).

export const WIDTHS = [1280, 390] as const
export type Width = (typeof WIDTHS)[number]

const VIEWS: Record<Width, View & { label: string }> = {
  1280: { width: 1280, height: 800, label: 'desktop' },
  390: { width: 390, height: 844, mobile: true, label: 'phone' },
}

// Screenshots stop here; taller pages are cut off
const MAX_SHOT_HEIGHT = 2000
// A PNG over this is sent as a JPEG instead, so answers stay small enough for agents to take in
const MAX_PNG_BYTES = 1_000_000
const JPEG_QUALITY = 70
const MAX_ITEMS = 20
const MAX_VIOLATIONS = 20
const MAX_TARGETS = 3
const MAX_TEXT = 300
// Inspections waiting for a free slot in the renderer; past it the answer is "busy"
const MAX_WAITING = 20
const MAX_WAIT_MS = 30_000
// How long a worker waits for the renderer to answer: the wait for a slot, then two renders, each
// with one retry after Chromium went away
const ANSWER_MS = 130_000

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
const IMPACT = ['critical', 'serious', 'moderate', 'minor']

export type Shot = { width: number; height: number; pageHeight: number; mimeType: 'image/png' | 'image/jpeg'; data: string }
export type Violation = { rule: string; impact: string; help: string; count: number; targets: string[]; widths: number[] }
export type Inspection = {
  widths: number[]
  shots: Shot[]
  errors: string[]
  missing: string[]
  failed: string[]
  brokenLinks: string[]
  blocked: string[]
  violations: Violation[]
}
export type InspectAnswer = { ok: true; inspection: Inspection } | { ok: false; reason: 'missing' | 'busy' | 'failed'; message: string }

let axeSource: string | null = null
function axe(): string {
  axeSource ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
  return axeSource
}

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
// Addresses on the page's made-up origin read as its file paths
const short = (url: string) => (url.startsWith(`${PAGE_ORIGIN}/`) ? url.slice(PAGE_ORIGIN.length + 1) || 'index.html' : url)

function add(list: string[], item: string) {
  if (!list.includes(item)) list.push(item)
}

type Found = { errors: string[]; missing: string[]; failed: string[]; brokenLinks: string[]; blocked: string[]; violations: Violation[]; shot: Shot }

async function evaluate(cdp: CDPSession, contextId: number, expression: string): Promise<unknown> {
  const r = await cdp.send('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`Inspecting failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}

const RUN_AXE = `axe.run(document, {
  runOnly: { type: 'tag', values: ${JSON.stringify(AXE_TAGS)} },
  resultTypes: ['violations'],
  iframes: false,
  preload: false,
}).then((r) => r.violations.map((v) => ({
  rule: v.id,
  impact: v.impact || 'minor',
  help: v.help,
  count: v.nodes.length,
  targets: v.nodes.slice(0, ${MAX_TARGETS}).map((n) => n.target.map((t) => Array.isArray(t) ? t.join(' >>> ') : String(t)).join(' ')),
})))`

const LINKS = `Array.from(document.querySelectorAll('a[href], area[href]'), (a) => a.href)`
const HEIGHT = 'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)'

async function inspectOnce(tree: PageTree, width: Width): Promise<Found> {
  const view = VIEWS[width]
  const errors: string[] = []
  const notes: RequestNotes = { missing: [], failed: [] }
  const files = new Set(['', 'index.html', ...tree.files.map((f) => f.path)])
  return inPage(
    tree,
    {
      view,
      what: 'Inspecting the page',
      notes,
      watch: (page) => {
        page.on('console', (msg) => {
          // Failed loads are reported from the requests themselves
          if (msg.type() !== 'error' || msg.text().startsWith('Failed to load resource')) return
          const at = msg.location()
          add(errors, clip(`${msg.text()}${at.url ? ` (${short(at.url)}${at.lineNumber ? `:${at.lineNumber + 1}` : ''})` : ''}`))
        })
        page.on('pageerror', (err) => {
          const frame = err.stack?.split('\n').find((line) => line.includes(PAGE_ORIGIN))
          const where = frame?.match(/(https?:\/\/\S+?):(\d+):\d+\)?$/)
          add(errors, clip(`Uncaught ${err.name}: ${err.message}${where ? ` (${short(where[1])}:${where[2]})` : ''}`))
        })
      },
    },
    async ({ page, cdp, blocked }) => {
      const { frameTree } = await cdp.send('Page.getFrameTree')
      const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'artifact-inspect' })
      await evaluate(cdp, executionContextId, axe())
      const found = (await evaluate(cdp, executionContextId, RUN_AXE)) as Omit<Violation, 'widths'>[]
      const links = (await evaluate(cdp, executionContextId, LINKS)) as string[]
      const pageHeight = Math.ceil(Number(await evaluate(cdp, executionContextId, HEIGHT)) || view.height)

      const brokenLinks: string[] = []
      for (const href of links) {
        let url: URL
        try {
          url = new URL(href)
        } catch {
          continue
        }
        if (url.origin !== PAGE_ORIGIN) continue
        let path: string
        try {
          path = decodeURIComponent(url.pathname.slice(1))
        } catch {
          path = url.pathname.slice(1)
        }
        if (!files.has(path)) add(brokenLinks, path)
      }

      // The whole page down to MAX_SHOT_HEIGHT, as a visitor scrolling it would see it
      const height = Math.min(Math.max(pageHeight, view.height), MAX_SHOT_HEIGHT)
      if (height !== view.height) {
        await page.setViewportSize({ width: view.width, height })
        await new Promise((r) => setTimeout(r, 100))
      }
      let shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      let mimeType: Shot['mimeType'] = 'image/png'
      if (Buffer.byteLength(shot.data, 'base64') > MAX_PNG_BYTES) {
        shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: JPEG_QUALITY })
        mimeType = 'image/jpeg'
      }

      return {
        errors,
        missing: [...new Set(notes.missing)],
        failed: notes.failed.map((f) => `${f.url} (${f.status})`),
        brokenLinks,
        blocked: [...new Set(blocked)],
        violations: found.map((v) => ({ ...v, help: clip(v.help), widths: [width] })),
        shot: { width: view.width, height, pageHeight, mimeType, data: shot.data },
      }
    },
  )
}

function merge(results: { width: Width; found: Found }[]): Inspection {
  const out: Inspection = { widths: [], shots: [], errors: [], missing: [], failed: [], brokenLinks: [], blocked: [], violations: [] }
  for (const { width, found } of results) {
    out.widths.push(width)
    out.shots.push(found.shot)
    for (const key of ['errors', 'missing', 'failed', 'brokenLinks', 'blocked'] as const) for (const item of found[key]) add(out[key], item)
    for (const v of found.violations) {
      const same = out.violations.find((o) => o.rule === v.rule)
      if (!same) out.violations.push(v)
      else {
        same.widths.push(width)
        same.count = Math.max(same.count, v.count)
        for (const t of v.targets) if (same.targets.length < MAX_TARGETS && !same.targets.includes(t)) same.targets.push(t)
      }
    }
  }
  out.violations.sort((a, b) => IMPACT.indexOf(a.impact) - IMPACT.indexOf(b.impact))
  return out
}

// A render slot, shared by every inspection in this process; thumbnails have their own
let active = 0
const waiting: (() => void)[] = []

function takeSlot(): Promise<boolean> | boolean {
  if (active < renderConcurrency()) {
    active += 1
    return true
  }
  if (waiting.length >= MAX_WAITING) return false
  return new Promise((resolve) => {
    const take = () => {
      clearTimeout(timer)
      resolve(true)
    }
    // Past this the worker that asked may have given up, so it isn't rendered at all
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(take), 1)
      resolve(false)
    }, MAX_WAIT_MS)
    waiting.push(take)
  })
}

function freeSlot() {
  const next = waiting.shift()
  // The slot passes straight to the next inspection
  if (next) next()
  else active -= 1
}

// Inspects one version here, where Chromium runs. Never throws: the answer says what went wrong.
export async function inspectHere(versionId: string, widths: Width[]): Promise<InspectAnswer> {
  try {
    const tree = await loadTree(versionId)
    if (!tree) return { ok: false, reason: 'missing', message: 'The version is gone.' }
    if (!(await takeSlot())) return { ok: false, reason: 'busy', message: 'The server is busy inspecting other pages. Try again in a minute.' }
    try {
      const results: { width: Width; found: Found }[] = []
      for (const width of widths) {
        // Chromium dying under an inspection isn't the page's doing, so it gets one more try on a fresh one
        const found = await inspectOnce(tree, width).catch((err) => {
          if (err instanceof BrowserGone) return inspectOnce(tree, width)
          throw err
        })
        results.push({ width, found })
      }
      return { ok: true, inspection: merge(results) }
    } finally {
      freeSlot()
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('Inspection failed', { versionId, error: message })
    return { ok: false, reason: 'failed', message: clip(message, 500) }
  }
}

// In a cluster's other workers: where to send inspections, and the ones waiting for an answer
let renderer: ((request: { id: number; versionId: string; widths: Width[] }) => void) | null = null
const answers = new Map<number, (answer: InspectAnswer) => void>()
let nextId = 0

export function inspectElsewhere(send: ((request: { id: number; versionId: string; widths: Width[] }) => void) | null) {
  renderer = send
}

export function inspectionAnswered(id: number, answer: InspectAnswer) {
  answers.get(id)?.(answer)
}

export function inspect(versionId: string, widths: Width[]): Promise<InspectAnswer> {
  const send = renderer
  if (!send) return inspectHere(versionId, widths)
  return new Promise((resolve) => {
    const id = nextId++
    const timer = setTimeout(() => done({ ok: false, reason: 'failed', message: 'The renderer did not answer in time. Try again in a minute.' }), ANSWER_MS)
    function done(answer: InspectAnswer) {
      clearTimeout(timer)
      answers.delete(id)
      resolve(answer)
    }
    answers.set(id, done)
    send({ id, versionId, widths })
  })
}

function section(title: string, items: string[], none: string): string {
  if (items.length === 0) return `${title}: ${none}`
  const shown = items.slice(0, MAX_ITEMS).map((i) => `- ${i}`)
  if (items.length > MAX_ITEMS) shown.push(`- and ${items.length - MAX_ITEMS} more`)
  return `${title} (${items.length}):\n${shown.join('\n')}`
}

// The tool's answer: a text report, then a screenshot per width
export function describeInspection(inspection: Inspection, heading: string) {
  const { shots, violations } = inspection
  const sizes = shots.map((s) => {
    const label = VIEWS[s.width as Width]?.label ?? `${s.width} px`
    return `${label} ${s.width}×${s.height}${s.pageHeight > s.height ? ` (the page is ${s.pageHeight} px tall; cut off at ${s.height})` : ''}`
  })
  const axeLines = violations.slice(0, MAX_VIOLATIONS).map((v) => {
    const at = inspection.widths.length > 1 && v.widths.length < inspection.widths.length ? ` Only at ${v.widths.join(', ')} px wide.` : ''
    const more = v.count > v.targets.length ? ` and ${v.count - v.targets.length} more` : ''
    return `- ${v.rule} (${v.impact}): ${v.help}. ${v.count} ${v.count === 1 ? 'element' : 'elements'}: ${v.targets.join(', ')}${more}.${at}`
  })
  if (violations.length > MAX_VIOLATIONS) axeLines.push(`- and ${violations.length - MAX_VIOLATIONS} more rules`)
  const clean = !inspection.errors.length && !inspection.missing.length && !inspection.failed.length && !inspection.brokenLinks.length && !violations.length
  const report = [
    heading,
    `Screenshots below: ${sizes.join('; ')}.`,
    '',
    section('Console errors and uncaught exceptions', inspection.errors, 'none.'),
    section("Files the page asked for that it doesn't have (404)", inspection.missing, 'none.'),
    section("Links to files the page doesn't have", inspection.brokenLinks, 'none.'),
    section('CDN requests that failed', inspection.failed, 'none.'),
    violations.length
      ? `Accessibility (axe-core, WCAG 2.1 A and AA), ${violations.length} ${violations.length === 1 ? 'rule' : 'rules'} broken:\n${axeLines.join('\n')}`
      : 'Accessibility (axe-core, WCAG 2.1 A and AA): no violations found.',
    ...(inspection.blocked.length
      ? [
          '',
          section(
            "Not loaded here, because inspections only reach the page's own files and a few public CDNs (people's browsers may still load them)",
            inspection.blocked,
            '',
          ),
        ]
      : []),
    '',
    clean
      ? 'Nothing to fix. Look at the screenshots to check the page looks as intended before sharing it.'
      : 'Fix these, publish a new version, and inspect it again before sharing the link.',
  ].join('\n')
  return {
    content: [{ type: 'text' as const, text: report }, ...shots.map((s) => ({ type: 'image' as const, data: s.data, mimeType: s.mimeType }))],
  }
}

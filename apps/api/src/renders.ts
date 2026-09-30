import { type Inspection, inspectTree, type Width } from './inspect.js'
import { log } from './log.js'
import { type Pdf, printTree } from './pdf.js'
import { loadTree, renderConcurrency } from './thumbnails.js'

// Renders someone is waiting for: inspect_artifact's checks (src/inspect.ts) and PDFs of a page
// (src/pdf.ts). Both open the page through inPage in src/thumbnails.ts, in the same Chromium and under
// the same rules as thumbnails, but take turns in slots of their own, so a long thumbnail queue never
// holds them up.
//
// In a cluster they run in the worker that has Chromium (the background one, src/primary.ts); the
// others ask it over IPC and wait for the answer (src/server.ts).

export type Job = { kind: 'inspect'; versionId: string; widths: Width[] } | { kind: 'pdf'; versionId: string }
type Values = { inspect: Inspection; pdf: Pdf }
export type Answer<T = Values[Job['kind']]> = { ok: true; value: T } | { ok: false; reason: 'missing' | 'busy' | 'failed'; message: string }
export type AnswerTo<J extends Job> = Answer<Values[J['kind']]>

// Renders waiting for a free slot; past it the answer is "busy"
const MAX_WAITING = 20
const MAX_WAIT_MS = 30_000
// How long a worker waits for the renderer to answer: the wait for a slot, then up to two renders
// (an inspection at two widths), each with one retry after Chromium went away
const ANSWER_MS = 130_000

const clip = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

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
  // The slot passes straight to the next render
  if (next) next()
  else active -= 1
}

// Renders one job here, where Chromium runs. Never throws: the answer says what went wrong.
export async function renderHere<J extends Job>(job: J): Promise<AnswerTo<J>> {
  try {
    const tree = await loadTree(job.versionId)
    if (!tree) return { ok: false, reason: 'missing', message: 'The version is gone.' }
    if (!(await takeSlot())) return { ok: false, reason: 'busy', message: 'The server is busy rendering other pages. Try again in a minute.' }
    try {
      const value = job.kind === 'inspect' ? await inspectTree(tree, job.widths) : await printTree(tree)
      return { ok: true, value } as AnswerTo<J>
    } finally {
      freeSlot()
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('Render failed', { kind: job.kind, versionId: job.versionId, error: message })
    return { ok: false, reason: 'failed', message: clip(message) }
  }
}

// In a cluster's other workers: where to send jobs, and the ones waiting for an answer
type Send = (request: { id: number; job: Job }) => void
let renderer: Send | null = null
const answers = new Map<number, (answer: Answer) => void>()
let nextId = 0

export function renderElsewhere(send: Send | null) {
  renderer = send
}

export function renderAnswered(id: number, answer: Answer) {
  answers.get(id)?.(answer)
}

export function render<J extends Job>(job: J): Promise<AnswerTo<J>> {
  const send = renderer
  if (!send) return renderHere(job)
  return new Promise((resolve) => {
    const id = nextId++
    const timer = setTimeout(() => done({ ok: false, reason: 'failed', message: 'The renderer did not answer in time. Try again in a minute.' }), ANSWER_MS)
    function done(answer: Answer) {
      clearTimeout(timer)
      answers.delete(id)
      resolve(answer as AnswerTo<J>)
    }
    answers.set(id, done)
    send({ id, job })
  })
}

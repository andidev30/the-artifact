import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import {
  FILES_MODULE,
  type FileInput,
  pageText,
  PREPARE_WORKER,
  type PrepareReply,
  type PrepareRequest,
  prepareContent,
  type PreparedContent,
  PublishError,
} from './files.js'
import { log } from './log.js'

// Checking, decoding base64 and hashing a page of a few MB takes milliseconds of CPU, and every other
// request waits while it runs on the main thread: 20 agents publishing 2.8 MB pages at once held the
// event loop up to 105 ms (issue #121). Large pages are prepared on a few worker threads instead.
// Small ones stay here, where they cost less than the trip to a worker and back. Pulling the text out
// of a large stored page for search (src/search.ts) runs on the same workers.
export const WORKER_MIN_CHARS = 256 * 1024
const POOL_SIZE = Math.min(4, availableParallelism())

// run does the same work here, when there is no worker for it
type Job = { request: PrepareRequest; run: () => unknown; resolve: (value: never) => void; reject: (err: unknown) => void }
type Slot = { worker: Worker; job: Job | null; worked: boolean; error?: Error }

const slots: Slot[] = []
const waiting: Job[] = []
let disabled = false

function inline(job: Job) {
  try {
    job.resolve(job.run() as never)
  } catch (err) {
    job.reject(err)
  }
}

function revive(content: PreparedContent): PreparedContent {
  // Transferred buffers arrive as plain Uint8Arrays
  const buffer = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return { ...content, html: buffer(content.html), files: content.files.map((f) => ({ ...f, content: buffer(f.content) })) }
}

function start(slot: Slot, job: Job) {
  slot.job = job
  // Referenced only while it works, so a waiting publish keeps a script alive but an idle pool doesn't
  slot.worker.ref()
  try {
    slot.worker.postMessage(job.request)
  } catch {
    // Input that can't be copied to a thread (never the case for JSON) is prepared here instead
    slot.job = null
    slot.worker.unref()
    inline(job)
  }
}

// Workers that can't start (a missing file, no threads allowed) mean publishing on the main thread
// from now on, rather than not at all
function disable(error: unknown) {
  if (!disabled) log.warn('Preparing pages on worker threads failed; preparing them on the main thread', { error: String(error) })
  disabled = true
  for (const queued of waiting.splice(0)) inline(queued)
}

// Starts the job on a new worker, or here if there can't be one
function startNew(job: Job) {
  let slot: Slot
  try {
    slot = spawn()
  } catch (err) {
    disable(err)
    return inline(job)
  }
  start(slot, job)
}

function spawn(): Slot {
  const slot: Slot = { worker: new Worker(new URL(FILES_MODULE), { workerData: PREPARE_WORKER }), job: null, worked: false }
  slot.worker.on('message', (reply: PrepareReply) => {
    const job = slot.job
    slot.job = null
    slot.worked = true
    if (job) {
      if ('content' in reply) job.resolve(revive(reply.content) as never)
      else if ('text' in reply) job.resolve(reply.text as never)
      else job.reject(reply.publishError ? new PublishError(reply.error) : new Error(reply.error))
    }
    const next = waiting.shift()
    if (next) start(slot, next)
    else slot.worker.unref()
  })
  slot.worker.on('error', (err: Error) => {
    slot.error = err
  })
  slot.worker.on('exit', () => {
    slots.splice(slots.indexOf(slot), 1)
    const job = slot.job
    slot.job = null
    if (!slot.worked) {
      // One that never answered couldn't start
      disable(slot.error?.message ?? 'exited')
      if (job) inline(job)
    } else {
      if (job) job.reject(slot.error ?? new Error('The worker preparing this page stopped.'))
      const next = waiting.shift()
      if (next) startNew(next)
    }
  })
  slots.push(slot)
  return slot
}

function enqueue(job: Job, chars: number) {
  if (disabled || chars < WORKER_MIN_CHARS) return inline(job)
  const idle = slots.find((s) => !s.job)
  if (idle) start(idle, job)
  else if (slots.length < POOL_SIZE) startNew(job)
  else waiting.push(job)
}

function charCount(html: string, files: FileInput[] | undefined): number {
  let n = html.length
  if (Array.isArray(files)) for (const f of files) n += typeof f?.content === 'string' || f?.content instanceof Uint8Array ? f.content.length : 0
  return n
}

// Checks, decodes and hashes a page sent inline, on a worker thread when it is large. Throws the same
// PublishError with the same message either way.
export function prepare(html: string, files: FileInput[] | undefined): Promise<PreparedContent> {
  return new Promise((resolve, reject) => {
    enqueue({ request: { html, files }, run: () => prepareContent(html, files), resolve, reject }, charCount(html, files))
  })
}

// The searchable text of a stored page (see pageText), on a worker thread when it is large
export function extractText(entry: string, others: { path: string; html: string }[] = []): Promise<string> {
  const chars = others.reduce((n, f) => n + f.html.length, entry.length)
  return new Promise((resolve, reject) => {
    enqueue({ request: { text: { entry, others } }, run: () => pageText(entry, others), resolve, reject }, chars)
  })
}

// For tests: whether large pages really go to workers, rather than quietly falling back
export const workerState = () => ({ workers: slots.length, disabled })

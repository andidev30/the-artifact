import cluster, { type Worker } from 'node:cluster'
import { AggregatorRegistry } from 'prom-client'
import { closeDatabase } from './db/index.js'
import { log } from './log.js'
import { prepare } from './startup.js'
import { type FromWorker, restartDelay, STABLE_MS, type ToWorker } from './workers.js'

// The primary of a cluster of WEB_CONCURRENCY workers (src/index.ts). It serves nothing itself: it
// migrates and checks the bucket once, starts the workers, which share the port, and restarts any
// that exits. Worker 1's slot is the background one (src/server.ts): it runs the storage sweep and
// renders every thumbnail; the others send it the versions to render through here.
//
// Kept light on purpose: on Linux the primary accepts every connection and hands it to a worker.

// A little longer than a worker's own limit (EXIT_MS in src/server.ts)
const STOP_MS = 10_000

type Slot = { index: number; worker: Worker | null; startedAt: number; failures: number }

export async function runPrimary(count: number) {
  await prepare()
  // Workers open their own pools; the one migrations used isn't needed again
  await closeDatabase()

  const slots: Slot[] = Array.from({ length: count }, (_, index) => ({ index, worker: null, startedAt: 0, failures: 0 }))
  const background = slots[0]
  const aggregator = new AggregatorRegistry()
  let stopping = false
  // Whether the background worker's thumbnail queue is full, for workers that start later
  let queueFull = false

  const sendTo = (worker: Worker | null, message: ToWorker) => {
    if (worker?.isConnected()) worker.send(message)
  }

  const broadcast = (full: boolean) => {
    queueFull = full
    for (const s of slots) if (s !== background) sendTo(s.worker, { type: 'artifact:thumbnail-queue-full', full })
  }

  function start(slot: Slot) {
    slot.startedAt = Date.now()
    const worker = cluster.fork({ WEB_CONCURRENCY: String(count), ARTIFACT_BACKGROUND: slot === background ? 'true' : 'false' })
    slot.worker = worker
    // A new background worker starts with an empty queue, and other new workers learn where it
    // stands; after 'listening', which comes once the worker listens for messages too
    worker.once('listening', () => {
      if (slot === background) queueFull && broadcast(false)
      else if (queueFull) sendTo(worker, { type: 'artifact:thumbnail-queue-full', full: true })
    })
    worker.on('message', (message: FromWorker) => {
      if (message?.type === 'artifact:thumbnail') sendTo(background.worker, message)
      else if (message?.type === 'artifact:thumbnail-queue-full') broadcast(message.full)
      else if (message?.type === 'artifact:metrics') {
        aggregator.clusterMetrics().then(
          (text) => sendTo(worker, { type: 'artifact:metrics', id: message.id, text }),
          (err: Error) => sendTo(worker, { type: 'artifact:metrics', id: message.id, error: err.message }),
        )
      }
    })
    worker.on('exit', (code, signal) => {
      if (slot.worker === worker) slot.worker = null
      if (stopping) return
      slot.failures = Date.now() - slot.startedAt >= STABLE_MS ? 1 : slot.failures + 1
      const delay = restartDelay(slot.failures)
      log.error('A worker stopped; starting another', { worker: worker.id, code, signal, restartInMs: delay })
      setTimeout(() => stopping || start(slot), delay).unref()
    })
  }

  for (const slot of slots) start(slot)
  log.info('Started workers', { workers: count })

  function stop(signal: string) {
    if (stopping) return
    stopping = true
    log.info('Stopping workers', { signal })
    const running = slots.map((s) => s.worker).filter((w): w is Worker => w !== null && !w.isDead())
    const force = setTimeout(() => {
      for (const w of running) if (!w.isDead()) w.process.kill('SIGKILL')
    }, STOP_MS)
    Promise.all(running.map((w) => (w.isDead() ? null : new Promise((resolve) => w.once('exit', resolve))))).then(() => {
      clearTimeout(force)
      log.info('Stopped')
      process.stdout.write('', () => process.exit(0))
    })
    // A signal rather than a message: a worker still starting has no listener for messages yet, and
    // one that isn't serving yet may as well stop right away
    for (const w of running) w.process.kill('SIGTERM')
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
}

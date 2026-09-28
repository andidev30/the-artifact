import cluster from 'node:cluster'
import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { trackingSettled } from './analytics.js'
import { app } from './app.js'
import { auditSettled } from './audit.js'
import { closeDatabase } from './db/index.js'
import { env } from './env.js'
import { scheduleSweeps } from './gc.js'
import { inspectElsewhere, inspectHere, inspectionAnswered } from './inspect.js'
import { log } from './log.js'
import { collectProcessMetrics, reportClusterMetrics } from './metrics.js'
import { closeThumbnailBrowser, queueThumbnail, renderThumbnailsElsewhere, rendererQueueFull, reportQueueFull } from './thumbnails.js'
import { batchViewCounts, stopViewCounts } from './views.js'
import type { FromWorker, ToWorker } from './workers.js'

// How long a stopping server waits for requests in flight. Docker stops a container 10 s after
// SIGTERM, and Kubernetes 30 s after; only a crash or a SIGKILL loses the last few seconds of view counts.
const DRAIN_MS = 8_000
const EXIT_MS = 9_500

// One process that serves requests: the only one, or a worker of a cluster (src/primary.ts). The
// background jobs run in exactly one process per server: the storage sweep with its pruners, and
// the thumbnail queue with Chromium, which also runs every inspection (src/inspect.ts).
export function startServer({ background }: { background: boolean }) {
  const worker = cluster.isWorker
  const send = (message: FromWorker) => process.send?.(message)

  if (worker) {
    // Every worker's process metrics are part of the server's, so they don't wait for a scrape
    collectProcessMetrics()
    let nextId = 0
    const waiting = new Map<number, { resolve: (text: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>()
    reportClusterMetrics(
      () =>
        new Promise((resolve, reject) => {
          const id = nextId++
          const timer = setTimeout(() => {
            waiting.delete(id)
            reject(new Error('The primary did not answer with metrics'))
          }, 10_000)
          waiting.set(id, { resolve, reject, timer })
          send({ type: 'artifact:metrics', id })
        }),
    )
    process.on('message', (message: ToWorker) => {
      if (message?.type === 'artifact:metrics') {
        const request = waiting.get(message.id)
        waiting.delete(message.id)
        if (request) clearTimeout(request.timer)
        if (message.error !== undefined) request?.reject(new Error(message.error))
        else request?.resolve(message.text ?? '')
      } else if (message?.type === 'artifact:thumbnail') queueThumbnail(message.versionId)
      else if (message?.type === 'artifact:thumbnail-queue-full') rendererQueueFull(message.full)
      else if (message?.type === 'artifact:inspect') {
        const { id, from } = message
        void inspectHere(message.versionId, message.widths).then((answer) => send({ type: 'artifact:inspected', id, to: from, answer }))
      } else if (message?.type === 'artifact:inspected') inspectionAnswered(message.id, message.answer)
    })
    // The primary is gone, and with it the listening socket
    process.on('disconnect', () => void stop('disconnect'))
    if (background) reportQueueFull((full) => send({ type: 'artifact:thumbnail-queue-full', full }))
    else {
      renderThumbnailsElsewhere((versionId) => send({ type: 'artifact:thumbnail', versionId }))
      inspectElsewhere((request) => send({ type: 'artifact:inspect', ...request }))
    }
  }

  if (background) {
    scheduleSweeps()
    if (worker) log.info('Background jobs run in this worker', { worker: cluster.worker?.id })
  }

  // This process outlives its requests, so view counts are summed in memory and written every few
  // seconds (src/views.ts), by each worker for its own. Vercel's entry (api/index.js) doesn't call
  // this and writes each view.
  batchViewCounts()

  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
    log.info('Server is running', { port: info.port, ...(worker ? { worker: cluster.worker?.id } : {}) })
  })

  // serve() makes an HTTP/1.1 server unless told otherwise
  const http = server as Server
  let stopping = false
  async function stop(reason: string) {
    if (stopping) return
    stopping = true
    log.info('Stopping', { reason, ...(worker ? { worker: cluster.worker?.id } : {}) })
    setTimeout(() => process.exit(1), EXIT_MS).unref()
    // close() stops accepting and waits for open connections; idle keep-alive connections are closed
    // as they become idle, and whatever is still open after DRAIN_MS is cut
    const closed = new Promise((resolve) => server.close(resolve))
    const idle = setInterval(() => http.closeIdleConnections(), 250)
    const cut = setTimeout(() => http.closeAllConnections(), DRAIN_MS)
    await closed
    clearInterval(idle)
    clearTimeout(cut)
    // The view counts the requests added, and whatever else is still being written
    await Promise.allSettled([stopViewCounts(), auditSettled(), trackingSettled(), closeThumbnailBrowser()])
    await closeDatabase().catch(() => {})
    log.info('Stopped', worker ? { worker: cluster.worker?.id } : {})
    // Once the log line is out: a pipe's writes are asynchronous on macOS
    process.stdout.write('', () => process.exit(0))
  }
  process.once('SIGTERM', () => void stop('SIGTERM'))
  process.once('SIGINT', () => void stop('SIGINT'))
}

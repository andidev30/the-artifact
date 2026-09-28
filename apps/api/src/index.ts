import cluster from 'node:cluster'
import { webConcurrency } from './workers.js'

// The long-running server (the Docker image runs this; Vercel runs api/index.js and never forks).
// With WEB_CONCURRENCY above 1, a primary starts that many workers (src/primary.ts); with 1, this one
// process does everything, as a server always did.
if (cluster.isWorker) {
  const { startServer } = await import('./server.js')
  startServer({ background: process.env.ARTIFACT_BACKGROUND === 'true' })
} else {
  const workers = webConcurrency(process.env.WEB_CONCURRENCY)
  if (workers > 1) {
    const { runPrimary } = await import('./primary.js')
    await runPrimary(workers)
  } else {
    const { prepare } = await import('./startup.js')
    await prepare()
    const { startServer } = await import('./server.js')
    startServer({ background: true })
  }
}

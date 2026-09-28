import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import type { InspectAnswer, Width } from './inspect.js'

// How many Node processes serve requests (WEB_CONCURRENCY) and how many database connections each
// may open (DATABASE_POOL_MAX). One process tops out at about one and a half cores however many the
// machine has (load/results/2026-09-28.md), so the long-running server starts one per core it may use.

export const MAX_DEFAULT_WORKERS = 8
const MAX_WORKERS = 64

type ReadFile = (path: string) => string

const readText: ReadFile = (path) => readFileSync(path, 'utf8')

// The cores a container's CPU limit allows, or null without one. cgroup v2 has "<quota> <period>" (or
// "max <period>") in cpu.max; cgroup v1 splits them over two files. Parts of a core round down, to at least 1.
export function cgroupCpuLimit(read: ReadFile = readText): number | null {
  const cores = (quota: number, period: number) => (quota > 0 && period > 0 ? Math.max(1, Math.floor(quota / period)) : null)
  try {
    const [quota, period] = read('/sys/fs/cgroup/cpu.max').trim().split(/\s+/)
    return quota === 'max' ? null : cores(Number(quota), Number(period))
  } catch {}
  try {
    return cores(Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us').trim()), Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us').trim()))
  } catch {}
  return null
}

// Unset or empty: one per core, capped at MAX_DEFAULT_WORKERS, and at the container's CPU limit
// (Node's availableParallelism doesn't always honour it)
export function webConcurrency(raw: string | undefined, cpus = availableParallelism(), limit: number | null = cgroupCpuLimit()): number {
  const value = raw?.trim()
  if (!value) return Math.max(1, Math.min(cpus, limit ?? cpus, MAX_DEFAULT_WORKERS))
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_WORKERS)
    throw new Error(`WEB_CONCURRENCY must be a whole number from 1 to ${MAX_WORKERS}, e.g. WEB_CONCURRENCY=4, or empty for one per CPU.`)
  return n
}

// Connections per process: 10 with one process, as before; with more, about 20 in all shared between
// them, at least 2 each. Postgres allows 100 by default, and the load test found a larger pool slower.
export function databasePoolMax(raw: string | undefined, workers: number): number {
  const value = raw?.trim()
  if (!value) return Math.max(2, Math.min(10, Math.floor(20 / Math.max(1, workers))))
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1 || n > 1000) throw new Error('DATABASE_POOL_MAX must be a whole number from 1 to 1000, e.g. DATABASE_POOL_MAX=10.')
  return n
}

// Restarts of a worker that keeps crashing wait longer each time: 1 s, 2 s, 4 s... up to 30 s. A worker
// that stayed up for a minute starts the count again.
export const STABLE_MS = 60_000
export function restartDelay(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1))
}

// What the primary and its workers say to each other over the cluster's IPC channel (src/primary.ts).
// An inspection goes from a worker to the primary, which adds the asking worker's id (`from`) and
// passes it to the background worker; its answer names that worker (`to`) and the primary passes it back.
export type FromWorker =
  | { type: 'artifact:thumbnail'; versionId: string }
  | { type: 'artifact:thumbnail-queue-full'; full: boolean }
  | { type: 'artifact:metrics'; id: number }
  | { type: 'artifact:inspect'; id: number; versionId: string; widths: Width[] }
  | { type: 'artifact:inspected'; id: number; to: number; answer: InspectAnswer }
export type ToWorker =
  | { type: 'artifact:thumbnail'; versionId: string }
  | { type: 'artifact:thumbnail-queue-full'; full: boolean }
  | { type: 'artifact:metrics'; id: number; text?: string; error?: string }
  | { type: 'artifact:inspect'; id: number; from: number; versionId: string; widths: Width[] }
  | { type: 'artifact:inspected'; id: number; answer: InspectAnswer }

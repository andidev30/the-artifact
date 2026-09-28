import { watch as fsWatch } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { LINK_FILE } from './config.ts'
import { ignoreMatcher, SKIPPED_FOLDERS } from './files.ts'

// `publish --watch`: watch a page's folder, and publish again once changes have settled

export const DEBOUNCE_MS = 500
export const POLL_MS = 1000

export type Clock = {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}

export const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

// Calls onChange with the changed path relative to the watched folder (with /), or null when the
// platform doesn't say which. Returns a function that stops watching.
export type Subscribe = (onChange: (path: string | null) => void) => () => void

function toPosix(path: string) {
  return sep === '/' ? path : path.split(sep).join('/')
}

// Whether a change at this path can change what publish sends: the same files collectPage leaves out
// (hidden files and folders, node_modules, --ignore) never trigger a publish, and neither does the
// page link file publish --save writes. For a single HTML file, only that file counts.
export function relevantChange(opts: { file?: string; ignore?: string[] }): (path: string | null) => boolean {
  const ignored = ignoreMatcher(opts.ignore ?? [])
  return (path) => {
    if (path === null) return true
    const parts = toPosix(path).split('/').filter(Boolean)
    if (!parts.length) return false
    if (opts.file !== undefined) return parts.length === 1 && parts[0] === opts.file
    if (parts.at(-1) === LINK_FILE) return false
    if (parts.some((p) => p.startsWith('.') || SKIPPED_FOLDERS.has(p))) return false
    // A change inside an ignored folder is ignored too; the path itself may be a file or a folder
    for (let i = 1; i < parts.length; i++) if (ignored(parts.slice(0, i).join('/'), true)) return false
    const whole = parts.join('/')
    return !ignored(whole, false) && !ignored(whole, true)
  }
}

// What polling compares: every path under the folder with its size and modification time
async function snapshot(root: string, file: string | undefined, relevant: (path: string) => boolean): Promise<Map<string, string>> {
  const seen = new Map<string, string>()
  if (file !== undefined) {
    const info = await stat(join(root, file)).catch(() => null)
    if (info) seen.set(file, `${info.size}:${info.mtimeMs}`)
    return seen
  }
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const item of entries) {
      const abs = join(dir, item.name)
      const path = toPosix(relative(root, abs))
      if (!relevant(path)) continue
      if (item.isDirectory()) await walk(abs)
      else {
        const info = await stat(abs).catch(() => null)
        if (info) seen.set(path, `${info.size}:${info.mtimeMs}`)
      }
    }
  }
  await walk(root)
  return seen
}

// Looks at the folder every interval and reports each path that was added, changed or removed
export function pollFolder(root: string, opts: { file?: string; relevant: (path: string) => boolean; interval?: number; clock?: Clock }): Subscribe {
  const clock = opts.clock ?? realClock
  return (onChange) => {
    let stopped = false
    let timer: unknown
    let last: Map<string, string> | null = null
    const tick = async () => {
      const now = await snapshot(root, opts.file, opts.relevant)
      if (stopped) return
      if (last) {
        for (const [path, sig] of now) if (last.get(path) !== sig) onChange(path)
        for (const path of last.keys()) if (!now.has(path)) onChange(path)
      }
      last = now
      timer = clock.setTimeout(tick, opts.interval ?? POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
      clock.clearTimeout(timer)
    }
  }
}

// fs.watch where the platform has it (recursive on macOS, Windows and Linux from Node 20), and
// polling where it hasn't or where it stops working (network drives, too many watched files)
export function watchFolder(
  root: string,
  opts: { file?: string; relevant: (path: string) => boolean; poll?: boolean; log?: (line: string) => void },
): Subscribe {
  const polling = pollFolder(root, opts)
  return (onChange) => {
    if (opts.poll) return polling(onChange)
    let stop: () => void
    try {
      const watcher = fsWatch(root, { recursive: opts.file === undefined, persistent: true }, (_event, name) =>
        onChange(name === null ? null : toPosix(name.toString())),
      )
      watcher.on('error', (err) => {
        watcher.close()
        opts.log?.(`Watching for changes stopped working (${err.message}); looking for changes every second instead.`)
        stop = polling(onChange)
        // Whatever happened in between is picked up by the next publish
        onChange(null)
      })
      stop = () => watcher.close()
    } catch {
      stop = polling(onChange)
    }
    return () => stop()
  }
}

// Runs publish after each burst of relevant changes, once none came for debounceMs. A publish that is
// running finishes first; changes during it lead to one more. A failed publish is reported and the
// loop waits for the next change. Resolves once signal aborts and any running publish has finished.
export function runWatch(opts: {
  subscribe: Subscribe
  relevant: (path: string | null) => boolean
  publish: () => Promise<void>
  onError: (err: unknown) => void
  signal: AbortSignal
  debounceMs?: number
  clock?: Clock
}): Promise<void> {
  const clock = opts.clock ?? realClock
  const debounce = opts.debounceMs ?? DEBOUNCE_MS
  return new Promise((resolve) => {
    if (opts.signal.aborted) return resolve()
    let timer: unknown
    let running = false
    let again = false
    let stopped = false

    const schedule = () => {
      clock.clearTimeout(timer)
      timer = clock.setTimeout(fire, debounce)
    }

    async function fire() {
      timer = undefined
      if (stopped) return
      running = true
      try {
        await opts.publish()
      } catch (err) {
        opts.onError(err)
      }
      running = false
      if (stopped) return resolve()
      if (again) {
        again = false
        schedule()
      }
    }

    const unsubscribe = opts.subscribe((path) => {
      if (stopped || !opts.relevant(path)) return
      if (running) again = true
      else schedule()
    })

    opts.signal.addEventListener(
      'abort',
      () => {
        stopped = true
        clock.clearTimeout(timer)
        unsubscribe()
        if (!running) resolve()
      },
      { once: true },
    )
  })
}

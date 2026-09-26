import type { ArtifactSummary } from './api'

// Gallery thumbnails are rendered on the server after publishing, so a fresh card has none yet.
// While some are on their way, the gallery asks again: soon at first, then less often, for about a
// minute, and not at all while the tab is hidden (coming back to it starts a new minute).

export const FIRST_DELAY = 2_000
export const MAX_DELAY = 10_000
export const POLL_FOR = 60_000

// Wait before the attempt-th refresh (0-based): 2s, 3s, 4.5s, 6.75s, then every 10s
export function pollDelay(attempt: number): number {
  return Math.min(MAX_DELAY, Math.round(FIRST_DELAY * 1.5 ** attempt))
}

type Visibility = { hidden: () => boolean; subscribe: (onChange: () => void) => () => void }

const documentVisibility: Visibility = {
  hidden: () => document.visibilityState === 'hidden',
  subscribe(onChange) {
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  },
}

type Options = {
  // Fetches the list again and shows what changed; resolves to whether any thumbnail is still pending
  refresh: () => Promise<boolean>
  visibility?: Visibility
  now?: () => number
}

// Starts polling; call the returned function to stop
export function pollThumbnails({ refresh, visibility = documentVisibility, now = Date.now }: Options): () => void {
  let started = now()
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let done = false

  function stop() {
    done = true
    clearTimeout(timer)
    unsubscribe()
  }

  function schedule() {
    clearTimeout(timer)
    if (done || visibility.hidden()) return
    const delay = pollDelay(attempt)
    if (now() - started + delay > POLL_FOR) return
    timer = setTimeout(tick, delay)
  }

  async function tick() {
    if (done || inFlight || visibility.hidden()) return
    inFlight = true
    attempt += 1
    let pending = true
    try {
      pending = await refresh()
    } catch {
      // A failed request (offline, aborted) just waits for the next turn
    } finally {
      inFlight = false
    }
    if (done) return
    if (!pending) return stop()
    schedule()
  }

  const unsubscribe = visibility.subscribe(() => {
    if (done) return
    clearTimeout(timer)
    if (visibility.hidden()) return
    // Back on the tab: renders may have finished meanwhile, so look now and start a new minute
    started = now()
    attempt = 0
    void tick()
  })

  schedule()
  return stop
}

// Takes only the thumbnail news from a refetch, so cards don't move or change under the pointer.
// A page republished in the meantime is replaced as a whole; pages that are gone stay until the next load.
export function withFreshThumbnails(items: ArtifactSummary[], fresh: ArtifactSummary[]): ArtifactSummary[] {
  const bySlug = new Map(fresh.map((a) => [a.slug, a]))
  return items.map((a) => {
    const f = bySlug.get(a.slug)
    if (!f) return a
    if (f.version !== a.version) return f
    if (f.thumbnail === a.thumbnail && f.thumbnailState === a.thumbnailState) return a
    return { ...a, thumbnail: f.thumbnail, thumbnailState: f.thumbnailState }
  })
}

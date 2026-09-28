// An open page asks the server for its current version every few seconds, so a new version published
// meanwhile (by an agent, or by `the-artifact publish --watch`) shows without a reload. Polling rather
// than a stream, because serverless hosts end long requests. The answer is tiny and usually a 304.
// While the tab is hidden it asks less and less often, and coming back to it asks at once.

export const VISIBLE_DELAY = 3_000
export const MAX_DELAY = 60_000

// Wait before the next check: every 3s while visible; hidden or failing, 6s, 12s, 24s... up to a minute
export function liveDelay(hidden: boolean, misses: number): number {
  if (!hidden && misses === 0) return VISIBLE_DELAY
  return Math.min(MAX_DELAY, VISIBLE_DELAY * 2 ** Math.max(1, misses))
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
  // The page's current version number, or null once it is gone or closed to this person
  check: () => Promise<number | null>
  // The version the page shows now
  shown: number
  onNewer: (version: number) => void
  visibility?: Visibility
}

// Starts polling; call the returned function to stop. Stops by itself on a newer version (the caller
// starts again for the next one) and when the page is gone.
export function pollCurrentVersion({ check, shown, onNewer, visibility = documentVisibility }: Options): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let done = false
  let inFlight = false
  // Checks in a row that were hidden or failed, for the backoff
  let misses = 0

  function stop() {
    done = true
    clearTimeout(timer)
    unsubscribe()
  }

  function schedule() {
    clearTimeout(timer)
    if (done) return
    timer = setTimeout(tick, liveDelay(visibility.hidden(), misses))
  }

  async function tick() {
    if (done || inFlight) return
    inFlight = true
    let failed = false
    let current: number | null = shown
    try {
      current = await check()
    } catch {
      // Offline or a server error: try again later, less often
      failed = true
    } finally {
      inFlight = false
    }
    if (done) return
    if (current === null) return stop()
    if (current > shown) {
      stop()
      onNewer(current)
      return
    }
    misses = failed || visibility.hidden() ? misses + 1 : 0
    schedule()
  }

  const unsubscribe = visibility.subscribe(() => {
    if (done || visibility.hidden()) return
    misses = 0
    clearTimeout(timer)
    void tick()
  })

  schedule()
  return stop
}

// In-process caches. Each process keeps its own, so anything cached here must be safe to read after
// another process (or instance) changed or deleted it: only immutable rows, looked up by a key that the
// request has just read fresh from the database, or answers that may be a few seconds old.

// Least recently used entries go first once there are more than maxEntries or their estimated size
// passes maxBytes. A Map keeps insertion order, so re-inserting on a hit moves an entry to the end.
export class Lru<K, V> {
  private readonly map = new Map<K, { value: V; bytes: number }>()
  private used = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly sizeOf: (value: V) => number,
  ) {}

  get(key: K): V | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key: K, value: V) {
    this.delete(key)
    const bytes = this.sizeOf(value)
    if (bytes > this.maxBytes) return
    this.map.set(key, { value, bytes })
    this.used += bytes
    for (const [k, entry] of this.map) {
      if (this.map.size <= this.maxEntries && this.used <= this.maxBytes) break
      this.map.delete(k)
      this.used -= entry.bytes
    }
  }

  delete(key: K) {
    const entry = this.map.get(key)
    if (!entry) return
    this.map.delete(key)
    this.used -= entry.bytes
  }

  // Removes every entry the test matches; for rare events such as deleting a page
  deleteWhere(test: (value: V, key: K) => boolean) {
    for (const [k, entry] of this.map) if (test(entry.value, k)) this.delete(k)
  }

  clear() {
    this.map.clear()
    this.used = 0
  }

  get size() {
    return this.map.size
  }

  get bytes() {
    return this.used
  }
}

// A value read at most once every ttlMs. Concurrent callers share one read, and a failed read isn't kept.
export function memo<T>(ttlMs: number, load: () => Promise<T>): { get: () => Promise<T>; clear: () => void } {
  let value: { promise: Promise<T>; at: number } | null = null
  return {
    get() {
      const now = Date.now()
      if (value && now - value.at < ttlMs) return value.promise
      const entry = { promise: load(), at: now }
      value = entry
      entry.promise.catch(() => {
        if (value === entry) value = null
      })
      return entry.promise
    },
    clear() {
      value = null
    },
  }
}

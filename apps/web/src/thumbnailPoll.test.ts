import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactSummary } from './api'
import { POLL_FOR, pollDelay, pollThumbnails, withFreshThumbnails } from './thumbnailPoll'

// A tab whose visibility the test flips
function fakeVisibility() {
  let hidden = false
  const listeners = new Set<() => void>()
  return {
    hidden: () => hidden,
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    set(next: boolean) {
      hidden = next
      for (const fn of listeners) fn()
    },
    listeners,
  }
}

describe('pollDelay', () => {
  it('backs off from 2 seconds to at most 10', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(pollDelay)).toEqual([2000, 3000, 4500, 6750, 10000, 10000, 10000])
  })
})

describe('pollThumbnails', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks again with backoff and stops after about a minute', async () => {
    const refresh = vi.fn(async () => true)
    const visibility = fakeVisibility()
    pollThumbnails({ refresh, visibility })

    await vi.advanceTimersByTimeAsync(1999)
    expect(refresh).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(refresh).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(POLL_FOR)
    const calls = refresh.mock.calls.length
    // At 2, 5, 9.5, 16.25, 26.25, 36.25, 46.25 and 56.25s; the next would pass the minute
    expect(calls).toBe(8)
    await vi.advanceTimersByTimeAsync(5 * POLL_FOR)
    expect(refresh).toHaveBeenCalledTimes(calls)
  })

  it('stops as soon as nothing is pending', async () => {
    const refresh = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const visibility = fakeVisibility()
    pollThumbnails({ refresh, visibility })
    await vi.advanceTimersByTimeAsync(POLL_FOR)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(visibility.listeners.size).toBe(0)
  })

  it('keeps going after a failed request', async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(false)
    pollThumbnails({ refresh, visibility: fakeVisibility() })
    await vi.advanceTimersByTimeAsync(2000 + 3000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('pauses while the tab is hidden and looks again when it comes back', async () => {
    const refresh = vi.fn(async () => true)
    const visibility = fakeVisibility()
    pollThumbnails({ refresh, visibility })
    await vi.advanceTimersByTimeAsync(2000)
    expect(refresh).toHaveBeenCalledTimes(1)

    visibility.set(true)
    await vi.advanceTimersByTimeAsync(10 * POLL_FOR)
    expect(refresh).toHaveBeenCalledTimes(1)

    // Right away, then the backoff starts over
    visibility.set(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(refresh).toHaveBeenCalledTimes(3)
    // And a new minute of it
    await vi.advanceTimersByTimeAsync(POLL_FOR)
    expect(refresh).toHaveBeenCalledTimes(9)
  })

  it('does nothing once stopped', async () => {
    const refresh = vi.fn(async () => true)
    const visibility = fakeVisibility()
    const stop = pollThumbnails({ refresh, visibility })
    stop()
    visibility.set(true)
    visibility.set(false)
    await vi.advanceTimersByTimeAsync(POLL_FOR)
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('withFreshThumbnails', () => {
  const card = (slug: string, extra: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
    slug,
    title: `Page ${slug}`,
    visibility: 'private',
    version: 1,
    publishedWith: null,
    updatedAt: '2026-09-26T12:00:00Z',
    owner: 'Dana',
    mine: true,
    canEdit: true,
    thumbnail: false,
    thumbnailState: 'pending',
    ...extra,
  })

  it('takes only the thumbnail from the refetch, keeping order and local edits', () => {
    const items = [card('a', { title: 'Renamed here' }), card('b'), card('c')]
    const fresh = [
      card('c', { thumbnail: true, thumbnailState: 'ready' }),
      card('a', { thumbnail: true, thumbnailState: 'ready' }),
      card('b', { thumbnailState: 'none' }),
    ]
    const next = withFreshThumbnails(items, fresh)
    expect(next.map((a) => [a.slug, a.title, a.thumbnail, a.thumbnailState])).toEqual([
      ['a', 'Renamed here', true, 'ready'],
      ['b', 'Page b', false, 'none'],
      ['c', 'Page c', true, 'ready'],
    ])
  })

  it('replaces a page republished meanwhile and keeps untouched cards as they were', () => {
    const items = [card('a'), card('b')]
    const republished = card('a', { version: 2, title: 'New title' })
    const next = withFreshThumbnails(items, [republished, card('b')])
    expect(next[0]).toBe(republished)
    expect(next[1]).toBe(items[1])
  })

  it('leaves cards missing from the refetch alone', () => {
    const items = [card('a')]
    expect(withFreshThumbnails(items, [])[0]).toBe(items[0])
  })
})

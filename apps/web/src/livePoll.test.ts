import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { liveDelay, MAX_DELAY, pollCurrentVersion, VISIBLE_DELAY } from './livePoll'

function fakeVisibility() {
  let hidden = false
  let listener: (() => void) | null = null
  return {
    visibility: {
      hidden: () => hidden,
      subscribe: (fn: () => void) => {
        listener = fn
        return () => {
          listener = null
        }
      },
    },
    set(value: boolean) {
      hidden = value
      listener?.()
    },
    listening: () => listener !== null,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('liveDelay', () => {
  it('checks every 3 seconds while visible, and backs off while hidden or failing', () => {
    expect(liveDelay(false, 0)).toBe(VISIBLE_DELAY)
    expect(liveDelay(true, 0)).toBe(6_000)
    expect(liveDelay(true, 1)).toBe(6_000)
    expect(liveDelay(true, 2)).toBe(12_000)
    expect(liveDelay(false, 3)).toBe(24_000)
    expect(liveDelay(true, 10)).toBe(MAX_DELAY)
  })
})

describe('pollCurrentVersion', () => {
  it('asks every few seconds, and hands on a newer version once', async () => {
    const vis = fakeVisibility()
    const answers = [1, 1, 2]
    const check = vi.fn(async () => answers.shift() ?? 3)
    const onNewer = vi.fn()
    pollCurrentVersion({ check, shown: 1, onNewer, visibility: vis.visibility })
    await vi.advanceTimersByTimeAsync(2_999)
    expect(check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(check).toHaveBeenCalledTimes(3)
    expect(onNewer).toHaveBeenCalledWith(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(check).toHaveBeenCalledTimes(3)
    expect(vis.listening()).toBe(false)
  })

  it('stops for good when the page is gone', async () => {
    const vis = fakeVisibility()
    const check = vi.fn(async () => null)
    const onNewer = vi.fn()
    pollCurrentVersion({ check, shown: 1, onNewer, visibility: vis.visibility })
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(check).toHaveBeenCalledTimes(1)
    expect(onNewer).not.toHaveBeenCalled()
  })

  it('asks less often while hidden, and at once when the tab comes back', async () => {
    const vis = fakeVisibility()
    const check = vi.fn(async () => 1)
    pollCurrentVersion({ check, shown: 1, onNewer: vi.fn(), visibility: vis.visibility })
    vis.set(true)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_999)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(check).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(check).toHaveBeenCalledTimes(3)
    vis.set(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(check).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(check).toHaveBeenCalledTimes(5)
  })

  it('backs off after failed checks and keeps going', async () => {
    const vis = fakeVisibility()
    let fail = 2
    const check = vi.fn(async () => {
      if (fail-- > 0) throw new Error('offline')
      return 2
    })
    const onNewer = vi.fn()
    pollCurrentVersion({ check, shown: 1, onNewer, visibility: vis.visibility })
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(check).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(11_999)
    expect(onNewer).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onNewer).toHaveBeenCalledWith(2)
  })

  it('does nothing more once stopped', async () => {
    const vis = fakeVisibility()
    const check = vi.fn(async () => 1)
    const stop = pollCurrentVersion({ check, shown: 1, onNewer: vi.fn(), visibility: vis.visibility })
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    vis.set(false)
    expect(check).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timeAgo } from './time'

const NOW = new Date('2026-09-26T12:00:00Z')

function ago(seconds: number) {
  return new Date(NOW.getTime() - seconds * 1000).toISOString()
}

describe('timeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    [0, 'just now'],
    [59, 'just now'],
    [60, '1 minute ago'],
    [5 * 60, '5 minutes ago'],
    [3600, '1 hour ago'],
    [3 * 3600, '3 hours ago'],
    [24 * 3600, 'yesterday'],
    [3 * 24 * 3600, '3 days ago'],
    [7 * 24 * 3600, 'last week'],
    [14 * 24 * 3600, '2 weeks ago'],
    [30 * 24 * 3600, 'last month'],
    [90 * 24 * 3600, '3 months ago'],
    [365 * 24 * 3600, 'last year'],
    [2 * 365 * 24 * 3600, '2 years ago'],
  ])('%i seconds ago is "%s"', (seconds, expected) => {
    expect(timeAgo(ago(seconds))).toBe(expected)
  })

  it('rounds to the nearest unit', () => {
    expect(timeAgo(ago(89))).toBe('1 minute ago')
    expect(timeAgo(ago(170))).toBe('3 minutes ago')
  })

  it('handles times in the future', () => {
    expect(timeAgo(ago(-2 * 3600))).toBe('in 2 hours')
    expect(timeAgo(ago(-30))).toBe('just now')
  })
})

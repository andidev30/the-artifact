import { describe, expect, it, vi } from 'vitest'
import { Lru, memo } from '../../src/cache.js'

describe('Lru', () => {
  it('drops the least recently used entry past its entry limit', () => {
    const lru = new Lru<string, number>(2, 1000, () => 1)
    lru.set('a', 1)
    lru.set('b', 2)
    expect(lru.get('a')).toBe(1)
    lru.set('c', 3)
    expect(lru.get('b')).toBeUndefined()
    expect(lru.get('a')).toBe(1)
    expect(lru.get('c')).toBe(3)
    expect(lru.size).toBe(2)
  })

  it('drops entries past its size limit, and never keeps one larger than it', () => {
    const lru = new Lru<string, string>(100, 10, (v) => v.length)
    lru.set('a', 'xxxx')
    lru.set('b', 'yyyy')
    lru.set('c', 'zzzz')
    expect(lru.get('a')).toBeUndefined()
    expect(lru.bytes).toBe(8)
    lru.set('big', 'x'.repeat(11))
    expect(lru.get('big')).toBeUndefined()
    expect(lru.bytes).toBe(8)
  })

  it('forgets entries by key and by test', () => {
    const lru = new Lru<string, { page: string }>(10, 1000, () => 1)
    lru.set('v1', { page: 'p' })
    lru.set('v2', { page: 'p' })
    lru.set('v3', { page: 'q' })
    lru.delete('v3')
    expect(lru.get('v3')).toBeUndefined()
    lru.deleteWhere((v) => v.page === 'p')
    expect(lru.size).toBe(0)
    expect(lru.bytes).toBe(0)
  })
})

describe('memo', () => {
  it('reads once per period, shares a read in flight and forgets failures', async () => {
    vi.useFakeTimers()
    try {
      let n = 0
      const load = vi.fn(async () => {
        n += 1
        if (n === 2) throw new Error('down')
        return n
      })
      const value = memo(1000, load)
      expect(await Promise.all([value.get(), value.get()])).toEqual([1, 1])
      expect(load).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1000)
      await expect(value.get()).rejects.toThrow('down')
      expect(await value.get()).toBe(3)
      value.clear()
      expect(await value.get()).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })
})

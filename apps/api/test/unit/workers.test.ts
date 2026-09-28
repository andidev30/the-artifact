import { afterEach, describe, expect, it } from 'vitest'
import { configureThumbnails, queueThumbnail, rendererQueueFull, renderThumbnailsElsewhere } from '../../src/thumbnails.js'
import { cgroupCpuLimit, databasePoolMax, restartDelay, webConcurrency } from '../../src/workers.js'

const files =
  (content: Record<string, string>) =>
  (path: string): string => {
    if (!(path in content)) throw new Error(`ENOENT: ${path}`)
    return content[path]
  }

describe('WEB_CONCURRENCY', () => {
  it('defaults to one worker per CPU, at most 8', () => {
    expect(webConcurrency(undefined, 4, null)).toBe(4)
    expect(webConcurrency('', 1, null)).toBe(1)
    expect(webConcurrency('  ', 32, null)).toBe(8)
  })

  it('stays within the container CPU limit', () => {
    expect(webConcurrency(undefined, 16, 2)).toBe(2)
    expect(webConcurrency(undefined, 2, 6)).toBe(2)
  })

  it('takes a number as given', () => {
    expect(webConcurrency('1', 16, 2)).toBe(1)
    expect(webConcurrency('12', 4, 2)).toBe(12)
  })

  it('refuses anything else', () => {
    for (const value of ['0', '-1', '1.5', 'auto', '65'])
      expect(() => webConcurrency(value, 4, null)).toThrow(/WEB_CONCURRENCY must be a whole number from 1 to 64/)
  })
})

describe('cgroup CPU limits', () => {
  it('reads cgroup v2', () => {
    expect(cgroupCpuLimit(files({ '/sys/fs/cgroup/cpu.max': '400000 100000\n' }))).toBe(4)
    expect(cgroupCpuLimit(files({ '/sys/fs/cgroup/cpu.max': '250000 100000' }))).toBe(2)
    expect(cgroupCpuLimit(files({ '/sys/fs/cgroup/cpu.max': '50000 100000' }))).toBe(1)
    expect(cgroupCpuLimit(files({ '/sys/fs/cgroup/cpu.max': 'max 100000\n' }))).toBeNull()
  })

  it('reads cgroup v1', () => {
    const v1 = (quota: string) => files({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': quota, '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n' })
    expect(cgroupCpuLimit(v1('300000\n'))).toBe(3)
    expect(cgroupCpuLimit(v1('-1\n'))).toBeNull()
  })

  it('finds none outside a container', () => {
    expect(cgroupCpuLimit(files({}))).toBeNull()
  })
})

describe('DATABASE_POOL_MAX', () => {
  it('keeps 10 for one process and shares about 20 between more', () => {
    expect(databasePoolMax(undefined, 1)).toBe(10)
    expect(databasePoolMax(undefined, 2)).toBe(10)
    expect(databasePoolMax(undefined, 3)).toBe(6)
    expect(databasePoolMax(undefined, 4)).toBe(5)
    expect(databasePoolMax(undefined, 8)).toBe(2)
    expect(databasePoolMax('', 16)).toBe(2)
  })

  it('takes a number per process as given', () => {
    expect(databasePoolMax('25', 4)).toBe(25)
    for (const value of ['0', 'ten', '2.5', '1001']) expect(() => databasePoolMax(value, 1)).toThrow(/DATABASE_POOL_MAX/)
  })
})

describe('restarting workers', () => {
  it('waits longer after every crash, up to 30 seconds', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(restartDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  })
})

describe('thumbnails rendered by another worker', () => {
  afterEach(() => configureThumbnails({ chromePath: '' }))

  it('hands versions over until the renderer says its queue is full', () => {
    configureThumbnails({ chromePath: '/usr/bin/chromium' })
    const sent: string[] = []
    renderThumbnailsElsewhere((id) => sent.push(id))
    expect(queueThumbnail('v1')).toBe(true)
    expect(queueThumbnail('v2')).toBe(true)
    rendererQueueFull(true)
    expect(queueThumbnail('v3')).toBe(false)
    rendererQueueFull(false)
    expect(queueThumbnail('v4')).toBe(true)
    expect(sent).toEqual(['v1', 'v2', 'v4'])
  })
})

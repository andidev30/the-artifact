import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { idpAddress } from '../../src/ee/sso/idp-requests.js'
import { env } from '../../src/env.js'
import { fetchOutbound, isLoopbackAddress, isPrivateNetworkAddress, OutboundError } from '../../src/network.js'

let server: Server
let base: string
const hits: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/secret' })
      return res.end()
    }
    if (req.url === '/big') return res.end('x'.repeat(2048))
    if (req.url === '/slow') return
    res.writeHead(200, { 'content-type': 'text/plain', 'x-encoding-asked': req.headers['accept-encoding'] ?? '' })
    res.end('hello')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

afterEach(() => {
  hits.length = 0
})

const anywhere = { allow: () => true, timeoutMs: 2000, maxBytes: 1024 }

describe('fetchOutbound', () => {
  it('answers with the status, headers and body', async () => {
    const res = await fetchOutbound(new URL(`${base}/hello`), { ...anywhere, headers: { 'Accept-Encoding': 'gzip' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
    // Never compressed, so maxBytes counts what the answer really is
    expect(res.headers.get('x-encoding-asked')).toBe('identity')
  })

  it('never connects to an address that isn’t allowed, by address or by name', async () => {
    const allow = (ip: string) => !isLoopbackAddress(ip)
    await expect(fetchOutbound(new URL(`${base}/hello`), { ...anywhere, allow })).rejects.toThrow(OutboundError)
    const byName = new URL(`${base}/hello`)
    byName.hostname = 'localhost'
    await expect(fetchOutbound(byName, { ...anywhere, allow })).rejects.toThrow('The address could not be reached.')
    expect(hits).toEqual([])
  })

  it('doesn’t follow redirects', async () => {
    const res = await fetchOutbound(new URL(`${base}/redirect`), anywhere)
    expect(res.status).toBe(302)
    expect(hits).toEqual(['/redirect'])
  })

  it('stops reading past maxBytes', async () => {
    await expect(fetchOutbound(new URL(`${base}/big`), anywhere)).rejects.toThrow(OutboundError)
  })

  it('gives up after the timeout', async () => {
    const started = Date.now()
    await expect(fetchOutbound(new URL(`${base}/slow`), { ...anywhere, timeoutMs: 200 })).rejects.toThrow('The address could not be reached.')
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('says the same whatever went wrong', async () => {
    const closed = new URL(base)
    closed.port = '1'
    await expect(fetchOutbound(closed, anywhere)).rejects.toThrow('The address could not be reached.')
    await expect(fetchOutbound(new URL('http://no-such-host.invalid/'), anywhere)).rejects.toThrow('The address could not be reached.')
    await expect(fetchOutbound(new URL('file:///etc/passwd'), anywhere)).rejects.toThrow('The address could not be reached.')
  })
})

describe('addresses of identity providers', () => {
  const selfHosted = env.selfHosted
  afterEach(() => {
    env.selfHosted = selfHosted
  })

  it('are public, or on the company network of a self-hosted install, never link-local', () => {
    expect(isPrivateNetworkAddress('10.1.2.3')).toBe(true)
    expect(isPrivateNetworkAddress('169.254.169.254')).toBe(false)
    expect(isPrivateNetworkAddress('127.0.0.1')).toBe(false)
    env.selfHosted = true
    for (const ip of ['8.8.8.8', '2606:4700::1111', '10.1.2.3', '172.20.0.5', '192.168.1.10', 'fd00::1']) expect(idpAddress(ip), ip).toBe(true)
    for (const ip of ['169.254.169.254', 'fe80::1', '0.0.0.0', '224.0.0.1', '::ffff:169.254.169.254']) expect(idpAddress(ip), ip).toBe(false)
    env.selfHosted = false
    expect(idpAddress('8.8.8.8')).toBe(true)
    expect(idpAddress('10.1.2.3')).toBe(false)
    // APP_URL is http in tests, where a provider on this machine is allowed for trying SSO locally
    expect(idpAddress('127.0.0.1')).toBe(true)
  })
})

import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'

// Addresses this server never sends its own requests to (a CDN host for thumbnails, a webhook's
// destination), whatever a name resolves to: private, loopback, link-local (cloud metadata lives at
// 169.254.169.254), shared, documentation, multicast and reserved ranges, and IPv6 forms that embed IPv4
// (two lists: one BlockList would match every IPv4 address against the IPv4-mapped IPv6 range)
const NOT_PUBLIC_V4 = new BlockList()
const NOT_PUBLIC_V6 = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  NOT_PUBLIC_V4.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  // Unspecified, loopback and the deprecated IPv4-compatible addresses (::a.b.c.d)
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  NOT_PUBLIC_V6.addSubnet(net, bits, 'ipv6')

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip)
  if (!family) return false
  return family === 4 ? !NOT_PUBLIC_V4.check(ip, 'ipv4') : !NOT_PUBLIC_V6.check(ip, 'ipv6')
}

const PRIVATE_V4 = new BlockList()
for (const [net, bits] of [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  PRIVATE_V4.addSubnet(net, bits, 'ipv4')
const PRIVATE_V6 = new BlockList()
PRIVATE_V6.addSubnet('fc00::', 7, 'ipv6')

// A company's own network (RFC 1918, shared address space, unique local IPv6). Not loopback,
// link-local (where cloud metadata services are) or any other reserved range.
export function isPrivateNetworkAddress(ip: string): boolean {
  const family = isIP(ip)
  if (!family) return false
  return family === 4 ? PRIVATE_V4.check(ip, 'ipv4') : PRIVATE_V6.check(ip, 'ipv6')
}

export function isLoopbackAddress(ip: string): boolean {
  return ip === '::1' || (isIP(ip) === 4 && ip.startsWith('127.'))
}

export class OutboundError extends Error {}

export type OutboundRequest = {
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  // Whether the server may connect to an address the name resolves to
  allow: (ip: string) => boolean
  timeoutMs: number
  // A longer answer fails the request as soon as this much has arrived
  maxBytes: number
  signal?: AbortSignal
}

type Resolved = { address: string; family: number }
type LookupCallback = (err: Error | null, address: string | Resolved[], family?: number) => void

// A request to an address an admin typed in (an IdP's metadata or issuer URL, and the endpoints its
// discovery document names). The name is resolved once, every address it has must pass `allow`, and
// the connection goes to a checked address, so the name can't resolve to something else in between.
// Redirects are answered as they are, never followed. Every failure is the same OutboundError, which
// says nothing about what was or wasn't there, so the answers can't be used to map a network.
export async function fetchOutbound(url: URL, req: OutboundRequest): Promise<Response> {
  const unreachable = () => new OutboundError('The address could not be reached.')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw unreachable()
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !req.allow(host)) throw unreachable()
  if (req.signal?.aborted) throw unreachable()

  // Node connects to what this answers, so only checked addresses are ever dialled
  const checkedLookup = (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    lookup(hostname, { all: true, verbatim: true }).then(
      (addresses) => {
        if (!addresses.length || addresses.some((a) => !req.allow(a.address))) return callback(unreachable(), '')
        if (options.all) callback(null, addresses)
        else callback(null, addresses[0].address, addresses[0].family)
      },
      () => callback(unreachable(), ''),
    )
  }

  return new Promise<Response>((resolve, reject) => {
    const fail = (err: OutboundError) => {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
      request.destroy()
      reject(err)
    }
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = send(
      url,
      {
        method: req.method ?? 'GET',
        // A compressed answer could unpack to far more than maxBytes
        headers: {
          ...Object.fromEntries(Object.entries(req.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'accept-encoding')),
          'accept-encoding': 'identity',
        },
        lookup: checkedLookup as never,
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status < 200 || status > 599) return fail(unreachable())
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > req.maxBytes) fail(new OutboundError('The answer is too large.'))
          else chunks.push(chunk)
        })
        res.on('error', () => fail(unreachable()))
        res.on('end', () => {
          if (size > req.maxBytes) return
          clearTimeout(timer)
          req.signal?.removeEventListener('abort', onAbort)
          const headers = new Headers()
          for (const [name, value] of Object.entries(res.headers)) {
            for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, v)
          }
          const empty = status === 204 || status === 205 || status === 304
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers }))
        })
      },
    )
    const timer = setTimeout(() => fail(unreachable()), req.timeoutMs)
    const onAbort = () => fail(unreachable())
    req.signal?.addEventListener('abort', onAbort, { once: true })
    request.on('error', (err) => fail(err instanceof OutboundError ? err : unreachable()))
    request.end(req.body)
  })
}

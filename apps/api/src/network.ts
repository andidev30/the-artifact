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

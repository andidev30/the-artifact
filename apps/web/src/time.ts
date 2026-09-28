const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

export function timeAgo(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

// For an access token: null never expires
export function expiryText(t: { expiresAt: string | null; expired: boolean }): string {
  if (!t.expiresAt) return 'No expiry'
  return t.expired ? `Expired ${timeAgo(t.expiresAt)}` : `Expires ${timeAgo(t.expiresAt)}`
}

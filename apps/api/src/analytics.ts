import { log } from './log.js'

// The hook core code calls when someone reaches a step of the hosted service's sign-up funnel. The
// store (the tables, the SELF_HOSTED check, the admin funnel) is in src/ee/analytics.ts, which app.ts
// plugs in with setProductEventStore; without it, and on every self-hosted install, track() records
// nothing. It never waits and never throws, so the action it records can't fail or slow down because
// of it. Events carry only the account id, the step and a fixed enum: never page content, titles,
// email addresses or IP addresses.

export const SIGN_UP_METHODS = ['email_link', 'password', 'google', 'sso'] as const
export const SHARE_KINDS = ['link', 'organization', 'person'] as const

export type SignUpMethod = (typeof SIGN_UP_METHODS)[number]

// In funnel order
export const PRODUCT_EVENTS = ['signed_up', 'onboarded', 'agent_connected', 'page_published', 'page_shared'] as const

export type ProductEventName = (typeof PRODUCT_EVENTS)[number]

export type ProductEvent =
  | { event: 'signed_up'; userId: string; detail: SignUpMethod }
  | { event: 'onboarded'; userId: string; detail: 'personal' | 'organization' | 'invitation' | 'email domain' }
  | { event: 'agent_connected'; userId: string; detail: 'oauth' | 'access_token' }
  // Every publish, new page or new version; the store keeps the first per account and a daily count
  | { event: 'page_published'; userId: string; detail?: undefined }
  | { event: 'page_shared'; userId: string; detail: (typeof SHARE_KINDS)[number] }

export type ProductEventStore = { record: (event: ProductEvent, at: Date) => Promise<void> }

let store: ProductEventStore | null = null
const pending = new Set<Promise<void>>()

export function setProductEventStore(s: ProductEventStore | null) {
  store = s
}

export function track(event: ProductEvent): void {
  if (!store) return
  const done = store
    .record(event, new Date())
    .catch((err) => log.error('Recording a product event failed', { err, event: event.event }))
    .finally(() => pending.delete(done))
  pending.add(done)
}

// Resolves once every event handed to track() so far is written, for tests and shutdown
export async function trackingSettled(): Promise<void> {
  await Promise.all([...pending])
}

export type Role = 'owner' | 'admin' | 'member'

export type Organization = {
  id: string
  name: string
  slug: string
  role: Role
}

export type Me = {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  onboarded: boolean
  organizations: Organization[]
}

// Resolves to the signed-in user, or null when nobody is signed in
export async function fetchMe(): Promise<Me | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin' })
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`GET /api/me failed with ${res.status}`)
  return res.json()
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
}

export async function finishPersonalOnboarding(): Promise<void> {
  const res = await fetch('/api/onboarding/personal', { method: 'POST', credentials: 'same-origin' })
  if (!res.ok) throw new Error(`Onboarding failed with ${res.status}`)
}

export type SlugCheck = { available: true } | { available: false; reason: string }

export async function checkSlug(slug: string, signal?: AbortSignal): Promise<SlugCheck> {
  const res = await fetch(`/api/organizations/slug-available?slug=${encodeURIComponent(slug)}`, { signal })
  if (!res.ok) throw new Error(`Slug check failed with ${res.status}`)
  return res.json()
}

export class FieldError extends Error {
  field: string | undefined
  constructor(message: string, field?: string) {
    super(message)
    this.field = field
  }
}

export async function createOrganization(name: string, slug: string): Promise<Organization> {
  const res = await fetch('/api/organizations', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, slug }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new FieldError(data.error ?? 'The organization could not be created. Try again.', data.field)
  return data
}

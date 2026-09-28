import { ApiError } from '../api'

// SCIM tokens of a self-hosted install (/api/admin/scim, Enterprise)

export type Organization = { id: string; name: string }

export type ScimToken = {
  id: string
  name: string
  organizationId: string | null
  organizationName: string | null
  createdAt: string
  lastUsedAt: string | null
}

export type ScimSettings = { baseUrl: string; organizations: Organization[]; tokens: ScimToken[] }

async function request<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method: init?.method,
    credentials: 'same-origin',
    headers: init?.json === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init?.json === undefined ? undefined : JSON.stringify(init.json),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data?.error ?? 'Something went wrong. Try again.', res.status, data?.code, data?.field)
  return data as T
}

export const getScim = () => request<ScimSettings>('/scim')
export const createScimToken = (name: string, organizationId: string) =>
  request<ScimSettings & { token: string }>('/scim/tokens', { method: 'POST', json: { name, organizationId } })
export const revokeScimToken = (id: string) => request<ScimSettings>(`/scim/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
